import { randomUUID } from 'node:crypto';
import { reconBreakAssignments, settlementInstructions, tenants } from '@novate/db';
import { Accounts } from '@novate/ledger';
import { MockRail } from '@novate/rails';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  controlEventFeed,
  createMember,
  dealDetail,
  deposit,
  type Engine,
  economics,
  exposure,
  inviteUser,
  listMembers,
  listUsers,
  memberAccount,
  memberCycle,
  memberStatement,
  memberStatementCsv,
  openBreaks,
  problemPayouts,
  provisionRequests,
  railBooks,
  reconHistory,
  recordRailOpening,
  refreshPayout,
  requestProvision,
  requestWithdrawal,
  runCycle,
  setAgentStatus,
  setBreakAssignee,
  settlementPreview,
  stopSettlement,
  submitFact,
  tenantStatus,
  tenantWithdrawals,
  updateMember,
} from '../src/index.ts';
import {
  acceptedDeal,
  boot,
  controlEventsOf,
  eur,
  gbp,
  makeWorld,
  netProgram,
  owning,
  provisionEurMember,
  reconcile,
  rigBreak,
  sent,
  shutdown,
  type World,
  waitFor,
} from './harness.ts';

const rail = new MockRail();
const slow = new MockRail({ name: 'slow', async: true, holdUntilSettled: true });
let engine: Engine;
beforeAll(async () => {
  engine = await boot(rail, [slow]);
});
afterAll(() => shutdown());

const withdraw = (w: World, memberId: string, amount: bigint, railName?: string) =>
  sent(
    requestWithdrawal(w.tenantId, w.asMember(memberId), memberId, {
      currency: 'EUR',
      amount,
      ...(railName ? { rail: railName } : {}),
      idempotencyKey: randomUUID(),
    }),
  );

describe('a member treasurer', () => {
  it('suspends its own agent with a reason, but cannot reinstate it or touch another’s', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const me = w.asMember(w.retailer);
    await expect(setAgentStatus(w.tenantId, me, w.retailerAgent, 'blocked', {})).rejects.toThrow(
      'Say why',
    );
    await expect(
      setAgentStatus(w.tenantId, me, w.supplierAgent, 'blocked', { reason: 'not mine' }),
    ).rejects.toThrow('Agent not found');
    await setAgentStatus(w.tenantId, me, w.retailerAgent, 'blocked', { reason: 'it misbehaved' });
    await expect(
      setAgentStatus(w.tenantId, me, w.retailerAgent, 'active', { reason: 'back' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const [event] = await controlEventsOf(w.tenantId, 'agent_suspended');
    expect(event).toMatchObject({
      reason: 'it misbehaved',
      payload: { agentId: w.retailerAgent },
      actor: { kind: 'member' },
    });
  });

  it('sees what holds its money, and each refusal says why with its own code', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await provisionEurMember(w, w.retailer);
    await w.fund(w.retailer, 'EUR', eur('20'));
    expect((await memberAccount(w.tenantId, w.retailer)).holds).toEqual({
      settlement: null,
      rails: [],
      withdrawals: null,
    });

    await expect(withdraw(w, w.retailer, eur('50'))).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    await expect(withdraw(w, w.supplier, eur('5'))).rejects.toMatchObject({
      code: 'no_payout_account',
    });

    // A debt in the currency comes before taking money out.
    await deps().ledger.post(deps().db, w.tenantId, [
      {
        key: `test-debt:${w.retailer}`,
        debit: Accounts.memberDebt(w.retailer, 'EUR'),
        credit: Accounts.houseFeeRevenue('EUR'),
        amount: eur('1'),
        kind: 'house_fee_debt',
      },
    ]);
    await expect(withdraw(w, w.retailer, eur('5'))).rejects.toMatchObject({
      code: 'debt_outstanding',
    });

    // A rail with an open difference holds what goes over it. Finding it stops settlement too;
    // clear that stop, so the rail's own hold is what is left.
    await rigBreak(w, 'held-for-member', { corrupt: eur('3') });
    await deps()
      .db.update(tenants)
      .set({ settlementHaltedAt: null, settlementHaltReason: null })
      .where(eq(tenants.id, w.tenantId));
    await expect(withdraw(w, w.retailer, eur('5'), 'held-for-member')).rejects.toMatchObject({
      code: 'rail_held',
    });
    const held = (await memberAccount(w.tenantId, w.retailer)).holds;
    expect(held.rails).toEqual([
      { rail: 'held-for-member', openDifferences: 1, since: expect.any(Date) },
    ]);
    // Its payout account is on `mock`, which is not held.
    expect(held.withdrawals).toBeNull();

    await stopSettlement(w.tenantId, w.platform, { reason: 'investigating' });
    await expect(withdraw(w, w.retailer, eur('5'))).rejects.toMatchObject({
      code: 'settlement_held',
    });
    expect((await memberAccount(w.tenantId, w.retailer)).holds).toMatchObject({
      settlement: { since: expect.any(Date), reason: 'investigating' },
      withdrawals: 'settlement',
    });
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('20'));
  });

  it('reads a cycle with names, rates and when it was paid, and files a claim by category', async () => {
    const program = netProgram({
      funding: { mode: 'prefunded', timeout: '72h', currency: 'home', fxBufferBps: 300 },
    });
    const w = await makeWorld(rail, { net: program });
    await w.fund(w.brand, 'GBP', gbp('200'));
    const dealId = await acceptedDeal(w, 'brand', 'supplier', '100');
    const cycle = await runCycle(w.tenantId);
    expect(cycle.status).toBe('settled');
    await waitFor(dealId, ['settled']);

    const mine = await memberCycle(w.tenantId, w.brand, cycle.cycleId);
    expect(mine.owed[0]).toMatchObject({ counterpartyName: 'Portuguese supplier' });
    expect(mine.converted[0]).toMatchObject({
      sellCurrency: 'GBP',
      buyCurrency: 'EUR',
      rate: '1.15',
      rateLabel: '1 GBP = 1.15 EUR',
    });
    expect(mine.converted[0]?.externalRef).toMatch(/^mockfx_/);
    expect(mine.converted[0]?.status).toBe('confirmed');
    const theirs = await memberCycle(w.tenantId, w.supplier, cycle.cycleId);
    const payout = theirs.instructions.find((i) => i.direction === 'payout');
    expect(payout?.status).toBe('confirmed');
    expect(payout?.paidAt).toBeInstanceOf(Date);

    // The lock and its release say what rate the member paid.
    const statement = await memberStatement(w.tenantId, w.brand);
    const lock = statement.lines.find((l) => l.kind === 'lock');
    expect(lock).toMatchObject({ currency: 'GBP', marketRate: '1.15', bufferBps: 300 });
    expect(lock?.rateLabel).toBe(`1 GBP = ${lock?.rate} EUR`);

    // The spreadsheet opens and closes with balances, and names what each line is.
    const csv = await memberStatementCsv(w.tenantId, w.brand);
    const [header, ...rows] = csv.body.trimEnd().split('\r\n');
    expect(header?.endsWith(',deal_ref,counterparty_name,description')).toBe(true);
    expect(csv.rows).toBe(rows.length);
    expect(rows[0]).toMatch(/^[^,]+,opening_balance,EUR,,,,,0,0\.00,0,0\.00,/);
    expect(rows[1]).toMatch(/^[^,]+,opening_balance,GBP,/);
    expect(rows.at(-1)).toMatch(/,closing_balance,GBP,/);
    expect(rows.at(-1)?.endsWith('Closing balance')).toBe(true);
    const lockRow = rows.find((r) => r.split(',')[1] === 'lock') as string;
    const cells = lockRow.split(',');
    expect(cells[16]).toBe(cells[0]); // value date: the posting date, as nothing else is known
    expect(cells[20]).toBe(`DL-${dealId.replaceAll('-', '').slice(0, 4).toUpperCase()}`);
    expect(cells[21]).toBe('Portuguese supplier');
    expect(cells[22]).toBe('Locked for a deal');
    // Every line between the opening and closing rows walks from one to the other.
    const closingGbp = rows.at(-1)?.split(',')[8];
    const lastGbp = rows
      .filter((r) => r.split(',')[2] === 'GBP')
      .at(-2)
      ?.split(',')[8];
    expect(closingGbp).toBe(lastGbp);

    await expect(
      submitFact(dealId, w.asMember(w.brand), {
        kind: 'dispute',
        type: 'claim',
        data: { reason: 'mugs chipped', category: 'broken' },
      }),
    ).rejects.toThrow('category');
    await submitFact(dealId, w.asMember(w.brand), {
      kind: 'dispute',
      type: 'claim',
      data: { reason: 'mugs chipped', category: 'quality' },
    });
    const detail = await dealDetail(dealId, w.asMember(w.brand));
    expect((detail as { claims: { category: string }[] }).claims[0]?.category).toBe('quality');
  });
});

describe('the head of operations', () => {
  it('sees held rails on the tenant and the preview, with who owns each break', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    expect((await tenantStatus(w.tenantId)).heldRails).toEqual([]);
    await rigBreak(w, 'held-for-ops', { corrupt: eur('3') });
    const status = await tenantStatus(w.tenantId);
    expect(status.settlementHaltedAt).toBeTruthy();
    expect(status.heldRails).toEqual([
      { rail: 'held-for-ops', openDifferences: 1, since: expect.any(Date) },
    ]);
    const preview = await settlementPreview(w.tenantId);
    expect(preview.heldRails.map((h) => h.rail)).toEqual(['held-for-ops']);

    const [open] = await openBreaks(w.tenantId);
    expect(open).toMatchObject({ assignee: null, assignedAt: null });
    const ops = { ...w.platform, kind: 'house' as const, id: 'ops-key', name: 'ops' };
    await setBreakAssignee(w.tenantId, ops, open?.id as string, true);
    const [taken] = await openBreaks(w.tenantId);
    expect(taken).toMatchObject({ assignee: { kind: 'house', keyId: 'ops-key' } });
    expect(taken?.assignedAt).toBeInstanceOf(Date);
    await setBreakAssignee(w.tenantId, ops, open?.id as string, false);
    expect((await openBreaks(w.tenantId))[0]).toMatchObject({ assignee: null, assignedAt: null });
    const types = (
      await controlEventFeed(w.tenantId, { type: ['break_assigned', 'break_unassigned'] })
    ).rows
      .map((e) => e.type)
      .sort();
    expect(types).toEqual(['break_assigned', 'break_unassigned']);
    // Assignments are history: they cannot be rewritten.
    await expect(
      deps().db.execute(
        sql`update ${reconBreakAssignments} set assignee = null where break_id = ${open?.id}`,
      ),
    ).rejects.toThrow();
    await expect(setBreakAssignee(w.tenantId, ops, randomUUID(), true)).rejects.toThrow(
      'Break not found',
    );
  });

  it('shows what the latest opening absorbed next to a run that found no difference', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const own = new MockRail({ name: 'rebased' });
    engine.rails.register(own);
    own.simulateDeposit('EUR', eur('100'), 'before');
    await recordRailOpening(w.tenantId, 'rebased');
    await reconcile(w.tenantId, 'rebased');
    const [run] = (await reconHistory(w.tenantId)).rows;
    expect(run?.absorbedByOpening).toEqual({
      openingAt: expect.any(Date),
      previousOpeningAt: null,
      currencies: [{ currency: 'EUR', amount: eur('100') }],
    });
  });

  it('filters control events by one or several types', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await stopSettlement(w.tenantId, w.platform, { reason: 'drill' });
    const stops = (await controlEventFeed(w.tenantId, { type: 'settlement_stopped' })).rows;
    expect(stops.map((e) => e.type)).toEqual(['settlement_stopped']);
    expect((await controlEventFeed(w.tenantId, { type: ['books_signed_off'] })).rows.length).toBe(
      0,
    );
    await expect(controlEventFeed(w.tenantId, { type: 'nonsense' })).rejects.toThrow('Invalid');
  });

  it('lists payouts in doubt across members, and asks the rail for one now', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await provisionEurMember(w, w.retailer, 'slow');
    // The money must be on the rail it is paid out over.
    const externalRef = `dep-${randomUUID()}`;
    slow.simulateDeposit('EUR', eur('20'), externalRef);
    await deposit(w.tenantId, {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('20'),
      rail: 'slow',
      externalRef,
    });
    const { id } = await withdraw(w, w.retailer, eur('15'), 'slow');
    const { db } = deps();
    const waiting = async () => {
      const [row] = await db
        .select()
        .from(settlementInstructions)
        .where(eq(settlementInstructions.cycleId, id));
      return row;
    };
    await expect.poll(async () => (await waiting())?.externalRef ?? null).toBeTruthy();
    const ins = (await waiting()) as typeof settlementInstructions.$inferSelect;
    // As the payment workflow does once the confirm window has passed.
    await db
      .update(settlementInstructions)
      .set({ status: 'in_doubt' })
      .where(eq(settlementInstructions.id, ins.id));

    const { rows: payouts } = await problemPayouts(w.tenantId, { status: 'in_doubt' });
    expect(payouts).toEqual([
      expect.objectContaining({
        id: ins.id,
        memberName: 'Dutch retailer',
        cycleId: id,
        withdrawal: true,
        rail: 'slow',
        amount: eur('15'),
        status: 'in_doubt',
        attempt: 0,
        externalRef: ins.externalRef,
        createdAt: expect.any(Date),
      }),
    ]);
    expect((await problemPayouts(w.tenantId, { status: 'failed' })).rows).toEqual([]);
    const all = await tenantWithdrawals(w.tenantId, { status: 'in_doubt' });
    expect(all.rows).toEqual([
      expect.objectContaining({ id, memberName: 'Dutch retailer', status: 'in_doubt' }),
    ]);
    // One member's withdrawals, for its page.
    expect((await tenantWithdrawals(w.tenantId, { memberId: w.retailer })).rows).toHaveLength(1);
    expect((await tenantWithdrawals(w.tenantId, { memberId: w.supplier })).rows).toEqual([]);

    const house = { ...w.platform, kind: 'house' as const, id: 'ops-key' };
    // Still under way: nothing is taken in, and the check is still recorded.
    expect(await refreshPayout(w.tenantId, house, ins.id)).toMatchObject({
      was: 'in_doubt',
      status: 'submitted',
      applied: false,
    });
    slow.settle(ins.externalRef as string);
    expect(
      await refreshPayout(w.tenantId, house, ins.id, { reason: 'bank says paid' }),
    ).toMatchObject({ status: 'confirmed', applied: true });
    await expect.poll(async () => (await waiting())?.status, { timeout: 15_000 }).toBe('confirmed');
    expect((await problemPayouts(w.tenantId)).rows).toEqual([]);
    const checks = (await controlEventFeed(w.tenantId, { type: 'payout_refreshed' })).rows;
    expect(checks.map((c) => c.payload.found)).toEqual(['confirmed', 'submitted']);
    await expect(refreshPayout(w.tenantId, house, randomUUID())).rejects.toThrow('not found');
  });
});

describe('the platform owner', () => {
  it('splits each fee with the house, reports both, and the books still reconcile', async () => {
    // A rail of its own from the start, so reconciling it sees only this tenant's money.
    const own = new MockRail({ name: 'fees-rail' });
    engine.rails.register(own);
    const w = await makeWorld(own, {
      net: netProgram({
        settlement: { rail: 'fees-rail' },
        fees: { sellerBps: 100, buyerBps: 100, platformShareBps: 2_500 },
      }),
    });
    await recordRailOpening(w.tenantId, 'fees-rail');
    // Not enough for the buyer's whole fee: half of it is owed.
    await w.fund(w.retailer, 'EUR', eur('100.50'));
    const dealId = await acceptedDeal(w, 'retailer', 'supplier', '100');
    expect((await runCycle(w.tenantId)).status).toBe('settled');
    await waitFor(dealId, ['settled']);

    // Seller 1.00 from its proceeds; buyer 0.50 from its wallet and 0.50 owed. A quarter of each
    // part to the platform, rounded down: 0.25 + 0.12 + 0.12.
    const { db, ledger } = deps();
    expect(await ledger.balance(db, w.tenantId, Accounts.platformFeeRevenue('EUR'))).toBe(
      eur('0.49'),
    );
    expect(await ledger.balance(db, w.tenantId, Accounts.houseFeeRevenue('EUR'))).toBe(eur('1.51'));

    const report = await economics(w.tenantId);
    expect(report.platformEarned).toEqual([{ currency: 'EUR', amount: eur('0.37') }]);
    expect(report.platformOwed).toEqual([{ currency: 'EUR', amount: eur('0.12') }]);
    expect(report.houseEarned).toEqual([{ currency: 'EUR', amount: eur('1.13') }]);
    expect(report.houseOwed).toEqual([{ currency: 'EUR', amount: eur('0.38') }]);
    expect(report.feesCollected).toEqual([{ currency: 'EUR', amount: eur('1.5') }]);
    expect(report.feesOwed).toEqual([{ currency: 'EUR', amount: eur('0.5') }]);
    expect(report.byMonth).toHaveLength(12);
    expect(report.byMonth.at(-1)).toEqual({
      month: new Date().toISOString().slice(0, 7),
      settled: [{ currency: 'EUR', amount: eur('100') }],
      dealsSettled: 1,
      fees: [{ currency: 'EUR', amount: eur('2') }],
    });
    expect(report.byMonth[0]).toMatchObject({ settled: [], dealsSettled: 0, fees: [] });

    // Fees move money between ledger accounts only, so the rail and the books still agree.
    expect(await reconcile(w.tenantId, 'fees-rail')).toMatchObject({
      status: 'clean',
      halted: false,
    });
    // On the books the fees are the house's own money, less what the buyer still owes for them.
    const books = await owning(w.tenantId, 'fees-rail', () => railBooks(w.tenantId));
    const euros = books.find((b) => b.rail === 'fees-rail')?.positions[0];
    expect(euros).toMatchObject({ currency: 'EUR', houseOwn: eur('1.5') });
    expect(euros?.houseOwnParts).toEqual([
      { kind: 'member_debt', amount: -eur('0.5'), refs: [] },
      { kind: 'program_fees', amount: eur('2'), refs: [] },
    ]);
  });

  it('keeps onboarding facts, takes corrections on record, and asks the house for accounts', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const member = await createMember(w.tenantId, w.platform, {
      name: 'Lisbon ceramics',
      homeCurrency: 'EUR',
      legalName: 'Cerâmica de Lisboa Lda',
      country: 'pt',
      contactEmail: 'ops@ceramica.example',
    });
    expect(member).toMatchObject({ country: 'PT', legalName: 'Cerâmica de Lisboa Lda' });
    await expect(
      createMember(w.tenantId, w.platform, { name: 'x', homeCurrency: 'EUR', country: 'PRT' }),
    ).rejects.toThrow('Invalid');
    await expect(updateMember(w.tenantId, w.platform, member.id, {})).rejects.toThrow('Invalid');
    const updated = await updateMember(w.tenantId, w.platform, member.id, {
      contactEmail: 'treasury@ceramica.example',
      reason: 'new contact',
    });
    expect(updated.contactEmail).toBe('treasury@ceramica.example');
    const [change] = (await controlEventFeed(w.tenantId, { type: 'member_updated' })).rows;
    expect(change).toMatchObject({
      reason: 'new contact',
      payload: {
        before: { contactEmail: 'ops@ceramica.example' },
        after: { contactEmail: 'treasury@ceramica.example' },
      },
    });
    expect((await listMembers(w.tenantId)).find((m) => m.id === member.id)?.legalName).toBe(
      'Cerâmica de Lisboa Lda',
    );
    expect((await memberAccount(w.tenantId, member.id)).country).toBe('PT');

    const row = (await exposure(w.tenantId)).members.find((m) => m.memberId === member.id);
    expect(row).toMatchObject({
      legalName: 'Cerâmica de Lisboa Lda',
      provisioned: false,
      accountsOpenedAt: null,
      waitingSince: member.createdAt,
    });

    await requestProvision(w.tenantId, w.platform, member.id, { note: 'EUR on Airwallex' });
    expect(await provisionRequests(w.tenantId)).toEqual([
      expect.objectContaining({ memberId: member.id, note: 'EUR on Airwallex', country: 'PT' }),
    ]);
    await provisionEurMember(w, member.id);
    expect(await provisionRequests(w.tenantId)).toEqual([]);
    const opened = (await exposure(w.tenantId)).members.find((m) => m.memberId === member.id);
    expect(opened?.accountsOpenedAt).toBeInstanceOf(Date);
    expect(opened?.waitingSince).toBeNull();
    await expect(requestProvision(w.tenantId, w.platform, member.id)).rejects.toThrow(
      'already has',
    );

    await inviteUser(w.tenantId, w.platform, {
      email: `t-${randomUUID()}@example.com`,
      name: 'Treasurer',
      role: 'member',
      memberId: member.id,
    });
    const people = await listUsers(w.tenantId, { memberId: member.id });
    expect(people.map((p) => p.name)).toEqual(['Treasurer']);
    expect(await listUsers(w.tenantId, { memberId: w.retailer })).toEqual([]);
  });
});
