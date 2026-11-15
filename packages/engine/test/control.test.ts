import { randomUUID } from 'node:crypto';
import { controlEvents, cycles, decisionCases, settlementInstructions } from '@novate/db';
import { presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activityFeed,
  caseDifference,
  decisionFeed,
  decisionTrail,
  differenceAmount,
  type Engine,
  listAgents,
  listDeals,
  listPrograms,
  openCases,
  publishProgram,
  recordRailOpening,
  resumeSettlement,
  setAgentStatus,
  setCaseAssignee,
  stopSettlement,
  tenantStatus,
} from '../src/index.ts';
import {
  boot,
  brain,
  controlEventsOf,
  eur,
  gbp,
  makeWorld,
  personDecides,
  reconcile,
  shutdown,
  waitFor,
  waitForCase,
} from './harness.ts';

const main = new MockRail();
let engine: Engine;

beforeAll(async () => {
  engine = await boot(main);
});
afterAll(() => shutdown());

async function waitForType(tenantId: string, type: string) {
  await expect
    .poll(async () => (await controlEventsOf(tenantId)).some((e) => e.type === type))
    .toBe(true);
}

/** The world's members and agents, added before each test starts. */
const notSetup = (e: { type: string }) => e.type !== 'member_added' && e.type !== 'agent_added';

describe('the record of control actions', () => {
  it('keeps the reason and the actor of the stop in force when the system stops again', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const rail = new MockRail({ name: 'restopped' });
    engine.rails.register(rail);
    await recordRailOpening(w.tenantId, 'restopped');
    await stopSettlement(w.tenantId, w.platform, { reason: 'looking into it' });
    rail.simulateDeposit('EUR', eur('7'), 'unexplained');

    expect((await reconcile(w.tenantId, 'restopped')).halted).toBe(true);
    const status = await tenantStatus(w.tenantId);
    expect(status.settlementHaltReason).toBe('looking into it');
    expect(status.settlementHaltedBy).toMatchObject({ kind: 'platform', keyId: 'platform-test' });
    const stops = (await controlEventsOf(w.tenantId)).filter(
      (e) => e.type === 'settlement_stopped',
    );
    expect(stops.map((e) => e.actor.kind)).toEqual(['platform']);
  });

  it('names who stopped and resumed settlement, and what the opening was', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const rail = new MockRail({ name: 'audited' });
    engine.rails.register(rail);
    rail.simulateDeposit('EUR', eur('5000'), 'before-novate');
    await recordRailOpening(w.tenantId, 'audited');
    rail.simulateDeposit('EUR', eur('7'), 'unexplained');

    const run = await reconcile(w.tenantId, 'audited');
    expect(run.halted).toBe(true);
    expect((await tenantStatus(w.tenantId)).settlementHaltedBy).toMatchObject({ kind: 'system' });
    // A second check while still stopped is not a second stop.
    expect((await reconcile(w.tenantId, 'audited')).halted).toBe(true);
    await stopSettlement(w.tenantId, w.platform, { reason: 'looking into it' });
    // The stop in force names whoever stopped it last, so a console can say who holds it.
    expect((await tenantStatus(w.tenantId)).settlementHaltedBy).toMatchObject({
      kind: 'platform',
      keyId: 'platform-test',
    });
    const recon = await waitForCase(w.tenantId, { subjectId: run.runId });
    await personDecides(w, recon.id, {
      bindingHash: recon.bindingHash,
      action: { type: 'acknowledge', note: 'Customer top-up we had not booked yet' },
      rationale: 'Matched to the bank statement',
    });
    // A person also stopped it, so the acknowledgement does not lift that person's stop.
    await waitForType(w.tenantId, 'break_resolved');
    expect((await tenantStatus(w.tenantId)).settlementHaltedAt).not.toBeNull();
    await resumeSettlement(w.tenantId, w.person, { reason: 'checked with the bank' });
    expect((await tenantStatus(w.tenantId)).settlementHaltedBy).toBeNull();

    // The tenant's first key was issued, then the world's own program was published.
    const events = (await controlEventsOf(w.tenantId)).filter(notSetup).slice(2);
    expect(events.map((e) => [e.type, e.actor.kind])).toEqual([
      ['opening_recorded', 'system'],
      ['settlement_stopped', 'system'],
      ['settlement_stopped', 'platform'],
      ['break_resolved', 'platform'],
      ['settlement_resumed', 'platform'],
    ]);
    expect(events[0]?.payload).toEqual({ rail: 'audited', balances: { EUR: String(eur('5000')) } });
    // The balance and the deposit behind it are one difference, counted once, in words a person reads.
    expect(events[1]?.reason).toBe(
      `Reconciliation run ${run.runId} found 1 difference with Audited, net 7.00 EUR`,
    );
    expect(events[1]?.payload).toEqual({ rail: 'audited', runId: run.runId });
    expect(events[2]).toMatchObject({
      actor: { kind: 'platform', keyId: 'platform-test' },
      reason: 'looking into it',
    });
    // Both runs saw the same two differences, so the one answer closes all four.
    expect(events[3]?.payload).toMatchObject({
      rail: 'audited',
      resolution: 'explained',
      caseId: recon.id,
    });
    expect(events[3]?.payload.breakIds).toHaveLength(4);
    // The case's trail goes on past the decision: settlement resuming is part of its story.
    const trail = await decisionTrail(w.tenantId, recon.id);
    expect(
      trail.events
        .filter((e) => e.source === 'control' && e.type !== 'settlement_stopped')
        .map((e) => [e.type, 'reason' in e ? e.reason : null]),
    ).toEqual([
      ['break_resolved', 'Customer top-up we had not booked yet'],
      ['settlement_resumed', 'checked with the bank'],
    ]);
    expect(events[4]).toMatchObject({
      reason: 'checked with the bank',
      payload: { stoppedBecause: 'looking into it' },
    });

    // The balance only follows from the unexplained deposit, so the case is about 7.00, not 14.00.
    const [found] = await engine.db
      .select()
      .from(decisionCases)
      .where(eq(decisionCases.subjectId, run.runId));
    expect(found?.reason).toBe('1 difference with Audited, net 7.00 EUR');
    expect(found?.context.amount).toBe(String(eur('7')));

    const feed = (await activityFeed(w.tenantId)).rows;
    const stopped = feed.find((i) => i.source === 'control' && i.type === 'settlement_resumed');
    expect(stopped).toMatchObject({
      id: `control:${events[4]?.id}`,
      actor: { kind: 'platform', userId: w.person.userId, via: 'session' },
      detail: { reason: 'checked with the bank' },
    });
  });

  it('records who published a program and why, and who suspended an agent', async () => {
    const w = await makeWorld(main);
    await publishProgram(w.tenantId, w.platform, {
      key: 'trade-assurance',
      spec: { ...presetInputs.tradeAssurance, settlement: { rail: 'mock' } } as never,
      note: 'Raise the ceiling for repeat buyers',
    });
    await setAgentStatus(w.tenantId, w.platform, w.retailerAgent, 'blocked', {
      reason: 'ordering in a loop',
    });
    await setAgentStatus(w.tenantId, w.platform, w.retailerAgent, 'active');

    const [latest, first] = await listPrograms(w.tenantId);
    expect(latest).toMatchObject({
      version: 2,
      note: 'Raise the ceiling for repeat buyers',
      createdBy: { kind: 'platform', keyId: 'platform-test' },
    });
    expect(first).toMatchObject({ version: 1, note: null });

    const events = (await controlEventsOf(w.tenantId)).filter(notSetup).slice(1);
    expect(events.map((e) => [e.type, e.reason, e.payload])).toEqual([
      [
        'program_published',
        null,
        { programKey: 'trade-assurance', version: 1, programId: first?.id },
      ],
      [
        'program_published',
        'Raise the ceiling for repeat buyers',
        { programKey: 'trade-assurance', version: 2, programId: latest?.id },
      ],
      ['agent_suspended', 'ordering in a loop', { agentId: w.retailerAgent }],
      ['agent_reinstated', null, { agentId: w.retailerAgent }],
    ]);
    await expect(
      engine.db.delete(controlEvents).where(eq(controlEvents.tenantId, w.tenantId)),
    ).rejects.toThrow();
  });
});

describe('the size of a reconciliation difference', () => {
  const item = (
    kind: 'missing_in_ledger' | 'amount_mismatch',
    expected: bigint,
    actual: bigint,
  ) => ({
    kind,
    currency: 'EUR',
    expected,
    actual,
  });
  const balance = (expected: bigint, actual: bigint) => ({
    kind: 'balance_mismatch' as const,
    currency: 'EUR',
    expected,
    actual,
  });

  it('counts the items, not the balances that follow from them', () => {
    expect(differenceAmount([balance(1000n, 1700n), item('missing_in_ledger', 0n, 700n)])).toBe(
      700n,
    );
    expect(
      differenceAmount([item('amount_mismatch', 500n, 450n), item('missing_in_ledger', 0n, -30n)]),
    ).toBe(80n);
  });

  it('falls back to the net balance when no item explains it', () => {
    expect(differenceAmount([balance(1000n, 900n), balance(50n, 80n)])).toBe(70n);
    expect(differenceAmount([balance(1000n, 1000n), item('amount_mismatch', 500n, 400n)])).toBe(
      100n,
    );
  });

  it('never adds currencies together, and sizes the case in the largest', () => {
    const gbp = { kind: 'missing_in_ledger' as const, currency: 'GBP', expected: 0n, actual: 900n };
    expect(caseDifference([item('missing_in_ledger', 0n, 700n), gbp])).toEqual({
      currency: 'GBP',
      amount: 900n,
      byCurrency: [
        { currency: 'EUR', amount: 700n },
        { currency: 'GBP', amount: 900n },
      ],
    });
  });
});

describe('what the console reads', () => {
  it('shows each agent what it has committed this month, as its limit counts it', async () => {
    brain.current = undefined;
    const w = await makeWorld(main, undefined, { EUR: { monthlyLimit: eur('20000') } });
    await w.fund(w.brand, 'GBP', gbp('5000'));
    await w.fund(w.supplier, 'EUR', eur('1000'));
    const first = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 100, price: '14' });
    await waitFor(first.id, ['awaiting_conditions']);
    const second = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 50, price: '14' });
    await waitFor(second.id, ['awaiting_conditions']);

    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const usage = Object.fromEntries((await listAgents(w.tenantId)).map((a) => [a.id, a.usage]));
    const committed = (side: 'buy' | 'sell') => ({
      since,
      amounts: [{ side, currency: 'EUR', amount: eur('2100') }],
      deals: 2,
    });
    expect(usage[w.brandBuyer]).toEqual(committed('buy'));
    expect(usage[w.supplierAgent]).toEqual(committed('sell'));
    expect(usage[w.retailerAgent]).toEqual({ since, amounts: [], deals: 0 });

    const ids = async (input: Parameters<typeof listDeals>[1]) =>
      (await listDeals(w.tenantId, input)).rows.map((d) => d.id);
    expect(await ids({ memberId: w.supplier })).toEqual([second.id, first.id]);
    expect(await ids({ memberId: w.retailer })).toEqual([]);
    expect(await ids({ limit: '1' as never })).toEqual([second.id]);
    const page = await listDeals(w.tenantId, { limit: 1 });
    expect(page.next).toBe(second.id);
    expect(await ids({ before: page.next ?? undefined })).toEqual([first.id]);
    expect(page.rows[0]?.funding).toBeNull();
    await expect(listDeals(w.tenantId, { limit: 201 })).rejects.toThrow();

    // Filtered, searched, sorted and counted by the server, across every page.
    expect(await ids({ sort: 'largest' })).toEqual([first.id, second.id]);
    expect(await ids({ sort: 'smallest' })).toEqual([second.id, first.id]);
    const largest = await listDeals(w.tenantId, { sort: 'largest', limit: 1 });
    expect(await ids({ sort: 'largest', before: largest.next ?? undefined })).toEqual([second.id]);
    expect(await ids({ status: 'open' })).toEqual([second.id, first.id]);
    expect(await ids({ status: 'settled' })).toEqual([]);
    expect(largest.counts).toEqual({ all: 2, open: 2, review: 0, settled: 0, stopped: 0 });
    const short = `DL-${first.id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
    expect(await ids({ q: short })).toEqual([first.id]);
    expect(await ids({ q: 'homeware' })).toEqual([second.id, first.id]);
    const none = await listDeals(w.tenantId, { q: 'nobody at all' });
    expect([none.rows, none.counts.all]).toEqual([[], 0]);
  });

  it('dates every unmatched item, and lets a person take the case', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const rail = new MockRail({ name: 'dated' });
    engine.rails.register(rail);
    await recordRailOpening(w.tenantId, 'dated');
    const [cycle] = await engine.db
      .insert(cycles)
      .values({
        tenantId: w.tenantId,
        kind: 'settlement',
        settlementGroup: 'dated|gross|manual|none',
        status: 'settled',
      })
      .returning();
    const paid = (ref: string) => ({
      tenantId: w.tenantId,
      cycleId: cycle?.id as string,
      memberId: w.supplier,
      direction: 'payout' as const,
      currency: 'EUR',
      amount: eur('5'),
      rail: 'dated',
      status: 'confirmed' as const,
      externalRef: ref,
      idempotencyKey: ref,
    });
    const [gone, short] = [`gone-${randomUUID()}`, `short-${randomUUID()}`];
    const [missing] = await engine.db
      .insert(settlementInstructions)
      .values([paid(gone), paid(short)])
      .returning();
    rail.simulateDeposit('EUR', eur('4'), short);
    const [moved] = await rail.transactions(new Date(0));

    const run = await reconcile(w.tenantId, 'dated');
    const breakFor = (kind: string) => run.breaks.find((b) => b.kind === kind);
    expect(breakFor('missing_on_rail')?.detail).toEqual({
      occurredAt: missing?.updatedAt.toISOString(),
    });
    expect(breakFor('amount_mismatch')?.detail).toEqual({ occurredAt: moved?.occurredAt });

    // A difference in client money waits for a person.
    const caseId = (await waitForCase(w.tenantId, { subjectId: run.runId })).id;
    const taken = await setCaseAssignee(w.tenantId, w.platform, caseId, true);
    const me = { kind: 'platform', keyId: 'platform-test', via: 'key' };
    expect(taken.assignee).toEqual(me);
    expect((await openCases(w.tenantId)).find((c) => c.id === caseId)).toMatchObject({
      assignee: me,
      assignedAt: taken.assignedAt,
    });
    expect((await decisionFeed(w.tenantId)).rows.find((c) => c.id === caseId)?.assignee).toEqual(
      me,
    );

    await setCaseAssignee(w.tenantId, w.platform, caseId, false);
    expect((await openCases(w.tenantId)).find((c) => c.id === caseId)).toMatchObject({
      assignee: null,
      assignedAt: null,
    });
    const controls = (await activityFeed(w.tenantId)).rows.filter(
      (i) => i.source === 'control' && i.type.startsWith('case_'),
    );
    expect(controls.map((i) => [i.type, i.source === 'control' && i.detail.payload])).toEqual([
      ['case_unassigned', { caseId }],
      ['case_assigned', { caseId }],
    ]);

    const other = await makeWorld(main);
    await expect(setCaseAssignee(other.tenantId, other.platform, caseId, true)).rejects.toThrow(
      'Case not found',
    );
    await engine.db
      .update(decisionCases)
      .set({ status: 'decided' })
      .where(eq(decisionCases.id, caseId));
    await expect(setCaseAssignee(w.tenantId, w.platform, caseId, true)).rejects.toThrow(
      'Case is decided',
    );
  });
});
