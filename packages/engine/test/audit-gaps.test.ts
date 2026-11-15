import { randomUUID } from 'node:crypto';
import { rowHistory, settlementInstructions, tenants } from '@novate/db';
import { presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cycleDetail,
  dealsCsv,
  decisionFeed,
  decisionRecordsCsv,
  decisionsCsv,
  decisionTrail,
  type Engine,
  ledgerCsv,
  openBreaks,
  payoutsCsv,
  recentCycles,
  recordRailOpening,
  requestWithdrawal,
  resolveBreak,
  runCycle,
} from '../src/index.ts';
import {
  acceptedDeal,
  boot,
  brain,
  controlEventsOf,
  eur,
  frozenBigOrder,
  makeWorld,
  netProgram,
  personDecides,
  reconcile,
  rigBreak,
  shutdown,
  waitFor,
  waitForCase,
} from './harness.ts';

const rail = new MockRail({ pull: false });
let engine: Engine;
beforeAll(async () => {
  engine = await boot(rail);
});
afterAll(() => shutdown());

const net = netProgram({
  settlement: { netting: 'multilateral', rail: 'mock', fundingWindow: '30s', confirmWithin: '1h' },
});

describe('an open reconciliation break', () => {
  it('holds settlement and withdrawals on its rail until a person closes it', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '50');
    await rigBreak(w, rail, { stray: eur('1') });
    // Reconciliation also stopped settlement. What is left is the hold of the break itself.
    await engine.db
      .update(tenants)
      .set({ settlementHaltedAt: null, settlementHaltReason: null })
      .where(eq(tenants.id, w.tenantId));

    const held = await runCycle(w.tenantId);
    expect(held).toMatchObject({
      status: 'deferred',
      reason:
        '1 unresolved reconciliation break on Mock: nothing settles on it until it is resolved',
    });
    await waitFor(dealId, ['eligible']);
    await expect(
      requestWithdrawal(w.tenantId, w.asMember(w.retailer), w.retailer, {
        currency: 'EUR',
        amount: eur('1'),
        rail: 'mock',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(/unresolved reconciliation break/);

    for (const open of await openBreaks(w.tenantId)) {
      await resolveBreak(w.tenantId, { ...w.person, operator: 'Ada' }, open.id, {
        resolution: 'explained',
        reason: 'A test difference',
      });
    }
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(dealId, ['settled']);

    // When the rail confirmed each payment, from its history rather than its last update.
    const [cycle] = await recentCycles(w.tenantId);
    const payout = cycle?.paid.find((p) => p.memberId === w.supplier);
    expect(payout).toMatchObject({ status: 'confirmed', failureReason: null });
    expect(payout?.paidAt).toBeInstanceOf(Date);
    const detail = await cycleDetail(w.tenantId, cycle?.id as string);
    const instruction = detail.instructions.find((i) => i.memberId === w.supplier);
    expect(instruction?.paidAt).toEqual(payout?.paidAt);
    expect(instruction).toHaveProperty('failureReason', null);

    // Editing a payment afterwards leaves what it was, and paidAt does not move.
    await engine.db
      .update(settlementInstructions)
      .set({ failureReason: 'edited by hand' })
      .where(eq(settlementInstructions.id, instruction?.id as string));
    const history = await engine.db
      .select()
      .from(rowHistory)
      .where(
        and(
          eq(rowHistory.tableName, 'settlement_instructions'),
          eq(rowHistory.rowId, instruction?.id as string),
        ),
      );
    expect(history.at(-1)).toMatchObject({
      op: 'UPDATE',
      old: expect.objectContaining({ status: 'confirmed', failure_reason: null }),
      new: expect.objectContaining({ failure_reason: 'edited by hand' }),
    });
    expect(history.some((h) => h.old.status !== 'confirmed')).toBe(true);
    const again = await cycleDetail(w.tenantId, cycle?.id as string);
    expect(again.instructions.find((i) => i.id === instruction?.id)?.paidAt).toEqual(
      instruction?.paidAt,
    );
    await expect(
      engine.db
        .update(rowHistory)
        .set({ op: 'DELETE' })
        .where(eq(rowHistory.id, history[0]?.id as bigint)),
    ).rejects.toThrow();
    for (const table of [
      'row_history',
      'settlement_instructions',
      'fx_conversions',
      'rail_events',
    ]) {
      await expect(engine.db.execute(sql.raw(`truncate ${table}`)), table).rejects.toThrow();
    }

    // The populations an auditor samples.
    const ledger = (await ledgerCsv(w.tenantId)).body.split('\r\n');
    expect(ledger[0]).toBe(
      'id,at,kind,debit_account,debit_kind,debit_member_id,debit_member_name,debit_deal_id,debit_cycle_id,debit_rail,credit_account,credit_kind,credit_member_id,credit_member_name,credit_deal_id,credit_cycle_id,credit_rail,amount_minor,amount_major,currency,idempotency_key,reference,batch_id,deal_id,cycle_id',
    );
    expect(ledger.some((l) => l.includes(`,${dealId},`))).toBe(true);
    expect(ledger.some((l) => l.endsWith(`,${cycle?.id}`))).toBe(true);
    // Each side says what the account is and whose, without taking its code apart.
    const columns = (ledger[0] as string).split(',');
    const settlementSide = ledger
      .slice(1)
      .map((l) => l.split(','))
      .find((cells) => cells[columns.indexOf('credit_kind')] === 'settlement');
    expect(settlementSide?.[columns.indexOf('credit_cycle_id')]).toBe(cycle?.id);
    expect(settlementSide?.[columns.indexOf('credit_member_name')]).toBeTruthy();
    const payouts = (await payoutsCsv(w.tenantId)).body.split('\r\n');
    expect(payouts[0]).toBe(
      'id,cycle_id,member_id,direction,rail,currency,amount_minor,amount_major,status,attempt,external_ref,failure_reason,created_at,updated_at',
    );
    expect(payouts.some((l) => l.includes('edited by hand'))).toBe(true);
    const dealLines = (await dealsCsv(w.tenantId, null)).body.split('\r\n');
    expect(dealLines[0]).toBe(
      'id,created_at,program_key,program_version,buyer_member_id,buyer_name,seller_member_id,seller_name,buyer_agent_id,buyer_agent_name,seller_agent_id,seller_agent_name,amount_minor,amount_major,currency,status,release_amount_minor,release_amount_major,funding',
    );
    expect(dealLines[1]).toMatch(new RegExp(`^${dealId},.*,net,1,.*,settled,.*,wallet$`));
    expect(
      (
        await dealsCsv(w.tenantId, null, {
          from: new Date(Date.now() + 60_000),
          to: new Date(Date.now() + 120_000),
        })
      ).body.split('\r\n'),
    ).toHaveLength(2);
  });
});

describe('adding members and agents', () => {
  it('records who added each, and the mandate an agent started with', async () => {
    const w = await makeWorld(rail);
    const events = await controlEventsOf(w.tenantId);
    const added = events.filter((e) => e.type === 'member_added');
    expect(added.map((e) => e.payload.memberId).sort()).toEqual(
      [w.brand, w.supplier, w.retailer].sort(),
    );
    const agent = events.find(
      (e) => e.type === 'agent_added' && e.payload.agentId === w.retailerAgent,
    );
    expect(agent).toMatchObject({
      actor: { kind: 'platform' },
      payload: { memberId: w.retailer, mandate: { roles: ['buy'] } },
    });
  });
});

describe('the decision record', () => {
  it('names the person, the program version and the ceiling the case was judged under', async () => {
    brain.current = undefined;
    const w = await makeWorld(rail);
    const { big, case: c } = await frozenBigOrder(w);
    await personDecides(
      w,
      c.id,
      {
        bindingHash: c.bindingHash,
        rationale: 'Ten times the usual order',
        action: { type: 'cancel' },
      },
      { ...w.person, operator: 'Ada Ops' },
    );
    await waitFor(big.id, ['cancelled']);

    const [row] = (await decisionFeed(w.tenantId)).rows.filter((r) => r.id === c.id);
    const ceiling = (presetInputs.tradeAssurance.decisions?.ceiling as Record<string, number>)?.EUR;
    expect(row).toMatchObject({
      programKey: 'trade-assurance',
      programVersion: 1,
      rationale: 'Ten times the usual order',
      deciderName: 'Ada Ops',
      promptVersion: null,
      refusedProposals: expect.any(Number),
    });
    if (ceiling !== undefined) expect(row?.ceiling).toBe(BigInt(ceiling));
    const trail = await decisionTrail(w.tenantId, c.id);
    expect(trail.steps.at(-1)).toMatchObject({
      decider: 'person',
      operator: 'Ada Ops',
      model: null,
    });

    const decisions = (await decisionsCsv(w.tenantId)).body.split('\r\n');
    expect(decisions[0]).toMatch(
      /,binding_hash,context_hash,rationale,decider_name,prompt_version,prompt_hash,refused_proposals,ceiling_minor,ceiling_major,program_key,program_version,decider_user_id$/,
    );
    expect(decisions.find((l) => l.startsWith(c.id))).toContain(
      ',Ten times the usual order,Ada Ops,,,',
    );
    const records = (await decisionRecordsCsv(w.tenantId)).body.split('\r\n');
    expect(records[0]).toBe(
      'case_id,at,decider_type,decider_id,operator,model,prompt_version,prompt_hash,action,accepted,refused_because,rationale,decider_user_id,approved_by_user_id',
    );
    expect(records.find((l) => l.startsWith(c.id) && l.includes(',person,'))).toMatch(
      new RegExp(
        `,Ada Ops,,,,cancel,true,,Ten times the usual order,${w.person.userId},${w.checker.userId}$`,
      ),
    );
  });

  it('shows a reconciliation difference in major units next to the minor ones', async () => {
    brain.current = undefined;
    const w = await makeWorld(rail);
    const account = new MockRail({ name: 'shown' });
    engine.rails.register(account);
    await recordRailOpening(w.tenantId, 'shown');
    account.simulateDeposit('EUR', eur('3'), 'stray-shown');
    account.simulateDeposit('GBP', 120n, 'stray-shown-gbp');
    const run = await reconcile(w.tenantId, 'shown');
    const found = await waitForCase(w.tenantId, { subjectId: run.runId });
    const shown = JSON.stringify(found.shown);
    expect(shown).toContain('"differenceShown":"3.00 EUR"');
    expect(shown).toContain('"actualShown":"1.20 GBP"');
    expect(found.reason).toBe('2 differences with Shown, net 3.00 EUR, 1.20 GBP');
    // Sized in the currency with the largest difference; the others are shown beside it.
    const [row] = (await decisionFeed(w.tenantId)).rows.filter((r) => r.id === found.id);
    expect(row).toMatchObject({ amount: String(eur('3')), currency: 'EUR' });
  });
});
