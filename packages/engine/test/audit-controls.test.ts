import { randomUUID } from 'node:crypto';
import {
  approvalRequests,
  controlEvents,
  decisionCases,
  ledgerTransfers,
  programs,
  reconBreaks,
  reconRuns,
} from '@novate/db';
import { MockRail } from '@novate/rails';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  APPROVAL_TTL_MS,
  activityFeed,
  approvalsCsv,
  approveRequest,
  businessDay,
  controlEventFeed,
  controlEventsCsv,
  createApiKey,
  creditDeposit,
  decideCase,
  decisionTrail,
  deposit,
  type Engine,
  listApprovals,
  monthStart,
  openBreaks,
  railBooks,
  reconciliationCsv,
  reconHistory,
  reconPositionsCsv,
  recordRailOpening,
  reinstateMember,
  rejectRequest,
  requestRailOpening,
  resolveBreak,
  resumeSettlement,
  revokeApiKey,
  setMemberRailRefs,
  signOffBooks,
  suspendMember,
  tenantStatus,
  updateTenantSettings,
} from '../src/index.ts';
import {
  boot,
  brain,
  controlEventsOf,
  eur,
  makeWorld,
  personDecides,
  reconcile,
  rigBreak,
  shutdown,
  waitForCase,
} from './harness.ts';

const main = new MockRail();
let engine: Engine;

beforeAll(async () => {
  engine = await boot(main);
});
afterAll(() => shutdown());

/** A rail of its own, so each test's account starts empty. */
function account(name: string) {
  const rail = new MockRail({ name });
  engine.rails.register(rail);
  return rail;
}

describe('the audit tables hold', () => {
  it('refuses to edit, delete or empty them, and fixes what a case showed', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const { run } = await rigBreak(w, 'immutable', { stray: eur('3') });
    expect(run.breaks).toHaveLength(2);
    await expect(
      engine.db.update(reconRuns).set({ status: 'clean' }).where(eq(reconRuns.id, run.runId)),
    ).rejects.toThrow();
    await expect(
      engine.db.delete(reconBreaks).where(eq(reconBreaks.runId, run.runId)),
    ).rejects.toThrow();
    await expect(
      engine.db.delete(programs).where(eq(programs.tenantId, w.tenantId)),
    ).rejects.toThrow();
    for (const table of [
      'ledger_transfers',
      'control_events',
      'decision_records',
      'decision_outcomes',
      'recon_break_resolutions',
    ]) {
      await expect(engine.db.execute(sql.raw(`truncate ${table}`))).rejects.toThrow();
    }

    const open = await waitForCase(w.tenantId, { subjectId: run.runId });
    const where = eq(decisionCases.id, open.id);
    await expect(engine.db.update(decisionCases).set({ shown: {} }).where(where)).rejects.toThrow();
    await expect(
      engine.db.update(decisionCases).set({ context: {} }).where(where),
    ).rejects.toThrow();
    await expect(
      engine.db.update(decisionCases).set({ bindingHash: 'x' }).where(where),
    ).rejects.toThrow();
    await expect(engine.db.delete(decisionCases).where(where)).rejects.toThrow();
    // What moves with the case still moves.
    await engine.db.update(decisionCases).set({ judgeAfter: new Date() }).where(where);

    const trail = await decisionTrail(w.tenantId, open.id);
    expect(trail.untampered).toBe(true);
    expect(trail.integrity.shown).toMatchObject({ matches: true, recorded: open.bindingHash });
    expect(trail.integrity.context).toMatchObject({ matches: true, recorded: open.contextHash });
    expect(open.contextHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a reconciliation break', () => {
  it('stays open after a clean run until a person resolves it, and holds settlement till then', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const { run } = await rigBreak(w, 'lifecycle', { stray: eur('3') });
    // The case opens in its own workflow, after the run returns.
    const open = await waitForCase(w.tenantId, { subjectId: run.runId });
    expect((await tenantStatus(w.tenantId)).settlementHaltedAt).not.toBeNull();
    expect(run.breaks.map((b) => [b.kind, b.countsAsItem]).sort()).toEqual([
      ['balance_mismatch', false],
      ['missing_in_ledger', true],
    ]);

    // Book the stray money: the books agree again, but the differences were still found.
    await deposit(w.tenantId, {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('3'),
      rail: 'lifecycle',
      externalRef: 'stray-lifecycle',
    });
    expect((await reconcile(w.tenantId, 'lifecycle')).status).toBe('clean');
    const broken = (await reconHistory(w.tenantId)).rows.find((r) => r.id === run.runId);
    expect(broken?.breaks.map((b) => b.status)).toEqual(['open', 'open']);
    expect(broken?.breaks[0]?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(await openBreaks(w.tenantId)).toHaveLength(2);

    // The balance mismatch and the item it comes from are one difference, counted once. One run's
    // breaks share a timestamp, so their order is the query plan's.
    expect((await openBreaks(w.tenantId)).map((b) => [b.kind, b.countsAsItem]).sort()).toEqual([
      ['balance_mismatch', false],
      ['missing_in_ledger', true],
    ]);
    await expect(resumeSettlement(w.tenantId, w.platform, { reason: 'all good' })).rejects.toThrow(
      'Sign in as yourself',
    );
    await expect(resumeSettlement(w.tenantId, w.person, { reason: 'all good' })).rejects.toThrow(
      /1 unresolved break on Lifecycle; case .* about Lifecycle is waiting for a person/,
    );
    await expect(resumeSettlement(w.tenantId, w.person, { reason: ' ' })).rejects.toThrow();

    const balance = broken?.breaks.find((b) => b.kind === 'balance_mismatch');
    const item = broken?.breaks.find((b) => b.kind === 'missing_in_ledger');
    await expect(
      resolveBreak(w.tenantId, w.person, balance?.id as string, {
        resolution: 'posted',
        reason: 'Booked',
      }),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ message: expect.stringMatching(/reference/) })],
    });
    const [booked] = await engine.db
      .select({ id: ledgerTransfers.id })
      .from(ledgerTransfers)
      .where(
        and(eq(ledgerTransfers.tenantId, w.tenantId), eq(ledgerTransfers.ref, 'stray-lifecycle')),
      );
    const post = (reference: string) =>
      resolveBreak(w.tenantId, { ...w.person, operator: 'Ada Ops' }, item?.id as string, {
        resolution: 'posted',
        reason: 'Booked the deposit',
        reference,
      });
    // A posted correction must be a real transfer, in the break's currency, for its difference.
    await expect(post('deposit:stray-lifecycle')).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringMatching(/not a transfer id/),
    });
    await expect(post(randomUUID())).rejects.toThrow(/no such transfer/);
    const [other] = await engine.db
      .select({ id: ledgerTransfers.id })
      .from(ledgerTransfers)
      .where(
        and(
          eq(ledgerTransfers.tenantId, w.tenantId),
          sql`${ledgerTransfers.amount} <> ${eur('3')}`,
        ),
      )
      .limit(1);
    if (other) await expect(post(other.id)).rejects.toThrow(/the difference is 3.00 EUR/);
    const posted = await post(booked?.id as string);
    expect((posted as { resolved: string[] }).resolved).toEqual([item?.id]);
    await expect(
      resolveBreak(w.tenantId, w.person, item?.id as string, {
        resolution: 'explained',
        reason: 'again',
      }),
    ).rejects.toThrow('already resolved');
    await resolveBreak(w.tenantId, w.person, balance?.id as string, {
      resolution: 'explained',
      reason: 'Follows from the deposit booked late',
    });

    await expect(resumeSettlement(w.tenantId, w.person, { reason: 'all good' })).rejects.toThrow(
      /waiting for a person/,
    );
    await personDecides(w, open.id, {
      bindingHash: open.bindingHash,
      action: { type: 'halt_settlement' },
      rationale: 'Keep it stopped until the books are corrected',
    });
    await resumeSettlement(w.tenantId, w.person, { reason: 'Corrected and checked' });
    expect((await tenantStatus(w.tenantId)).settlementHaltedAt).toBeNull();

    const [after] = (await reconHistory(w.tenantId)).rows.filter((r) => r.id === run.runId);
    expect(after?.breaks.find((b) => b.id === item?.id)).toMatchObject({
      status: 'resolved',
      resolution: {
        resolution: 'posted',
        reason: 'Booked the deposit',
        reference: booked?.id,
        actor: { kind: 'platform', operator: 'Ada Ops' },
      },
    });
    expect(await openBreaks(w.tenantId)).toEqual([]);
    const resolved = await controlEventsOf(w.tenantId, 'break_resolved');
    expect(resolved.map((e) => e.payload.resolution)).toEqual(['posted', 'explained']);
    const [resumed] = await controlEventsOf(w.tenantId, 'settlement_resumed');
    expect(resumed?.reason).toBe('Corrected and checked');

    const exported = (await reconciliationCsv(w.tenantId)).body;
    expect(exported.split('\r\n')[0]).toBe(
      'run_id,run_at,rail,run_status,break_id,kind,currency,expected_minor,expected_major,actual_minor,actual_major,external_ref,break_status,resolution,resolved_at,resolved_by_kind,resolved_by_key_id,resolved_by_name,resolved_by_operator,resolved_by_user_id,resolved_by_via,resolution_reason,resolution_reference,age_seconds,counts_as_item',
    );
    expect(exported).toContain(',resolved,posted,');
    // Each check's balances, per currency, whatever it found.
    const [header, ...lines] = (await reconPositionsCsv(w.tenantId)).body.trim().split('\r\n');
    expect(header).toBe(
      'run_id,run_at,rail,run_status,transactions,currency,ledger_minor,ledger_major,rail_balance_minor,rail_balance_major,at_opening_minor,at_opening_major,difference_minor,difference_major',
    );
    expect(lines.find((l) => l.startsWith(run.runId))).toMatch(/,breaks,\d+,EUR,/);
  });

  it('closes on a person acknowledging it, and settlement resumes if nothing else holds it', async () => {
    brain.current = {
      name: 'stub',
      decide: async () => ({ action: { type: 'acknowledge', note: 'timing' }, rationale: 'r' }),
    };
    const w = await makeWorld(main);
    const { run } = await rigBreak(w, 'acknowledged', { stray: eur('3') });
    const open = await waitForCase(w.tenantId, { subjectId: run.runId });
    // The model tries to acknowledge first, and code refuses it.
    await expect
      .poll(async () => (await decisionTrail(w.tenantId, open.id)).steps.length)
      .toBeGreaterThan(0);
    await decideCase(
      open.id,
      { ...w.person, operator: 'Grace' },
      {
        bindingHash: open.bindingHash,
        action: { type: 'acknowledge', note: 'A top-up booked tomorrow' },
        rationale: 'Matched to the bank statement',
      },
    );
    await expect.poll(async () => (await tenantStatus(w.tenantId)).settlementHaltedAt).toBeNull();
    expect(await openBreaks(w.tenantId)).toEqual([]);
    const [resumed] = await controlEventsOf(w.tenantId, 'settlement_resumed');
    expect(resumed).toMatchObject({
      actor: { kind: 'platform', operator: 'Grace' },
      reason: 'A top-up booked tomorrow',
      payload: { caseId: open.id },
    });

    brain.current = undefined;
    const trail = await decisionTrail(w.tenantId, open.id);
    const byModel = trail.steps.filter((s) => s.decider === 'model');
    expect(byModel.length).toBeGreaterThan(0);
    expect(byModel.every((s) => !s.accepted)).toBe(true);
    expect(byModel[0]?.checks.filter((c) => !c.passed).map((c) => c.text)).toContain(
      'acknowledging a reconciliation difference is reserved for a person',
    );
    const person = trail.steps.find((s) => s.decider === 'person');
    expect(person).toMatchObject({ accepted: true, rationale: 'Matched to the bank statement' });
  });

  it('needs a reason from a person', async () => {
    const w = await makeWorld(main);
    const { run } = await rigBreak(w, 'unreasoned', { stray: eur('3') });
    const open = await waitForCase(w.tenantId, { subjectId: run.runId });
    await expect(
      decideCase(open.id, w.person, {
        bindingHash: open.bindingHash,
        action: { type: 'halt_settlement' },
        rationale: '  ',
      }),
    ).rejects.toMatchObject({
      details: [expect.objectContaining({ message: 'A rationale is required' })],
    });
  });
});

describe('re-recording a rail opening', () => {
  it('needs a second person, and keeps who asked, who approved and what it absorbed', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    await rigBreak(w, 'rebased', { stray: eur('9') });
    const ada = { ...w.checker, operator: 'Ada', userId: 'user-ada' };
    const grace = { ...w.checker, operator: 'Grace', userId: 'user-grace' };
    // Only the tenant that owns a rail may ask, and for anyone else it does not exist.
    await expect(
      requestRailOpening(w.tenantId, ada, 'rebased', { reason: 'Start again' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    deps().railOwners.rebased = w.tenantId;
    await expect(
      requestRailOpening(w.tenantId, ada, 'rebased', { reason: 'Start again' }),
    ).rejects.toThrow(/1 unresolved break on Rebased/);
    await expect(requestRailOpening(w.tenantId, ada, 'rebased', {} as never)).rejects.toThrow();
    // A key with a typed-in name is not a signed-in person.
    await expect(
      requestRailOpening(w.tenantId, { ...w.platform, operator: 'Ada' }, 'rebased', {
        reason: 'r',
        rebaseBreaks: true,
      }),
    ).rejects.toMatchObject({ code: 'person_required' });

    const asked = await requestRailOpening(w.tenantId, ada, 'rebased', {
      reason: 'Sandbox top-up by Airwallex, not client money',
      rebaseBreaks: true,
    });
    expect(asked).toMatchObject({
      status: 'pending_approval',
      kind: 'rail_opening',
      absorbed: { EUR: eur('9') },
      balances: { EUR: eur('9') },
    });
    // Nothing is applied until someone else approves it.
    expect(await openBreaks(w.tenantId)).toHaveLength(2);
    expect((await listApprovals(w.tenantId, null, { kind: 'rail_opening' })).rows).toMatchObject([
      {
        approvalId: asked.approvalId,
        amount: null,
        currency: null,
        payload: { rail: 'rebased', absorbed: { EUR: String(eur('9')) }, rebaseBreaks: true },
        requestedBy: { operator: 'Ada', userId: 'user-ada' },
      },
    ]);
    expect((await listApprovals(w.tenantId, null, { kind: 'manual_credit' })).rows).toEqual([]);
    // The same user under another name is still the same person.
    await expect(
      approveRequest(w.tenantId, { ...ada, operator: 'Grace' }, asked.approvalId),
    ).rejects.toThrow(/second person/);
    // A key with a different X-Operator name, and no sign-in, cannot approve at all.
    for (const operator of ['Grace', 'Somebody Else']) {
      await expect(
        approveRequest(w.tenantId, { ...w.platform, operator }, asked.approvalId),
      ).rejects.toMatchObject({ code: 'person_required' });
    }
    // Only the house approves an opening.
    await expect(
      approveRequest(w.tenantId, { ...w.person, userId: 'user-grace' }, asked.approvalId),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await approveRequest(w.tenantId, grace, asked.approvalId);
    await expect(approveRequest(w.tenantId, grace, asked.approvalId)).rejects.toThrow(
      /already approved/,
    );
    expect((await listApprovals(w.tenantId, null)).rows).toEqual([]);
    expect(await openBreaks(w.tenantId)).toEqual([]);
    // The books show who recorded the opening in force, who approved it and why.
    expect((await railBooks(w.tenantId)).find((r) => r.rail === 'rebased')?.opening).toMatchObject({
      requestedBy: { userId: 'user-ada' },
      approvedBy: { userId: 'user-grace' },
      approvalId: asked.approvalId,
      reason: 'Sandbox top-up by Airwallex, not client money',
    });

    const [requested] = await controlEventsOf(w.tenantId, 'approval_requested');
    expect(requested).toMatchObject({
      actor: { userId: 'user-ada' },
      payload: {
        approvalId: asked.approvalId,
        kind: 'rail_opening',
        request: { rail: 'rebased', absorbed: { EUR: String(eur('9')) } },
      },
    });
    const [, again] = await controlEventsOf(w.tenantId, 'opening_recorded');
    expect(again).toMatchObject({
      actor: { operator: 'Ada', userId: 'user-ada' },
      reason: 'Sandbox top-up by Airwallex, not client money',
      payload: {
        rail: 'rebased',
        balances: { EUR: String(eur('9')) },
        absorbed: { EUR: String(eur('9')) },
        previous: {},
        approvalId: asked.approvalId,
        approvedBy: { userId: 'user-grace' },
      },
    });
    expect(again?.payload.rebasedBreaks).toHaveLength(2);
    const runs = (await reconHistory(w.tenantId)).rows;
    expect(runs.find((r) => r.status === 'breaks')?.breaks[0]?.resolution).toMatchObject({
      resolution: 'opening_rebased',
      reference: `control:${again?.id}`,
    });
    expect(runs[0]?.status).toBe('opening');
    expect((await reconcile(w.tenantId, 'rebased')).status).toBe('clean');
  });

  it('is refused once the balances moved, or a day later', async () => {
    const w = await makeWorld(main);
    const rail = account('moved');
    await recordRailOpening(w.tenantId, 'moved');
    deps().railOwners.moved = w.tenantId;
    const ada = { ...w.checker, operator: 'Ada', userId: 'user-ada' };
    const grace = { ...w.checker, operator: 'Grace', userId: 'user-grace' };
    const asked = await requestRailOpening(w.tenantId, ada, 'moved', { reason: 'Recount' });
    expect(asked.absorbed).toEqual({});
    rail.corrupt('EUR', eur('1'));
    await expect(approveRequest(w.tenantId, grace, asked.approvalId)).rejects.toThrow(
      /changed since this request: make a new request/,
    );

    const [old] = await engine.db
      .insert(approvalRequests)
      .values({
        tenantId: w.tenantId,
        kind: 'rail_opening',
        actor: { kind: 'house', operator: 'Ada', userId: 'user-ada', via: 'session' },
        payload: {
          rail: 'moved',
          rebaseBreaks: false,
          railBalances: { EUR: String(eur('1')) },
          balances: { EUR: String(eur('1')) },
          absorbed: { EUR: String(eur('1')) },
        },
        reason: 'Long ago',
        createdAt: new Date(Date.now() - 25 * 3_600_000),
      })
      .returning();
    await expect(approveRequest(w.tenantId, grace, old?.id as string)).rejects.toThrow(
      /has expired/,
    );
    expect(
      (await listApprovals(w.tenantId, null, { kind: 'rail_opening' })).rows.map(
        (r) => r.approvalId,
      ),
    ).toEqual([asked.approvalId]);
  });
});

describe('a posted correction after a rebase', () => {
  it('is refused, because the opening already absorbed the difference', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const { run } = await rigBreak(w, 'absorbed', { stray: eur('4') });
    const [item] = (await openBreaks(w.tenantId)).filter(
      (b) => b.runId === run.runId && b.kind === 'missing_in_ledger',
    );
    // Recorded as the opening behind the reconciliation's back: what a rebase would leave.
    await engine.db.insert(reconRuns).values({
      tenantId: w.tenantId,
      rail: 'absorbed',
      status: 'opening',
      breakCount: 0,
      summary: { kind: 'opening', balances: { EUR: String(eur('4')) } },
      createdAt: new Date(Date.now() + 1000),
    });
    await expect(
      resolveBreak(w.tenantId, w.person, item?.id as string, {
        resolution: 'posted',
        reason: 'Booked',
        reference: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringMatching(/explained, or rebase/),
    });
  });
});

describe('signing off the books', () => {
  it('needs a check that day on every rail the tenant owns', async () => {
    const w = await makeWorld(main);
    account('signed');
    deps().railOwners.signed = w.tenantId;
    try {
      await expect(signOffBooks(w.tenantId, w.person)).rejects.toThrow(
        /No check ran on .* \(UTC\) for Signed/,
      );
      await recordRailOpening(w.tenantId, 'signed');
      await reconcile(w.tenantId, 'signed');
      const signed = await signOffBooks(w.tenantId, w.person, { note: 'Day closed' });
      expect(signed).toMatchObject({
        date: new Date().toISOString().slice(0, 10),
        timeZone: 'UTC',
        rails: [{ rail: 'signed', status: 'clean', lastCheckAt: expect.any(Date) }],
        openBreaks: 0,
        snapshotHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const [event] = await controlEventsOf(w.tenantId, 'books_signed_off');
      expect(event).toMatchObject({ id: signed.id, reason: 'Day closed' });
    } finally {
      delete deps().railOwners.signed;
    }
  });

  it('wants a note over open differences, once a day in the tenant’s time zone, with the positions', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const { rail } = await rigBreak(w, 'signed-open', { stray: eur('2') });
    deps().railOwners['signed-open'] = w.tenantId;
    try {
      const zone = 'Pacific/Auckland';
      // The business day is the tenant's, set by the house with a reason, not the client's.
      await expect(
        updateTenantSettings(w.tenantId, w.checker, { timeZone: 'Mars/Base', reason: 'x' }),
      ).rejects.toThrow();
      await expect(
        updateTenantSettings(w.tenantId, w.person, { timeZone: zone, reason: 'Desk moved' }),
      ).rejects.toThrow('Only the house');
      await updateTenantSettings(w.tenantId, w.checker, { timeZone: zone, reason: 'Desk moved' });
      expect((await tenantStatus(w.tenantId)).settings.timeZone).toBe(zone);
      const [changed] = await controlEventsOf(w.tenantId, 'settings_changed');
      expect(changed).toMatchObject({
        reason: 'Desk moved',
        payload: { changed: ['timeZone'], to: { timeZone: zone } },
      });
      await expect(signOffBooks(w.tenantId, w.platform, { note: 'n' })).rejects.toThrow(
        'Sign in as yourself',
      );
      await expect(signOffBooks(w.tenantId, w.person, {})).rejects.toThrow(
        /1 difference still open: add a note/,
      );
      const first = await signOffBooks(w.tenantId, w.person, {
        note: 'Stray 2.00 EUR under investigation',
      });
      expect(first).toMatchObject({
        date: businessDay(new Date(), zone).date,
        timeZone: zone,
        openBreaks: 1,
      });
      expect(first.rails[0]?.positions).toContainEqual({
        currency: 'EUR',
        ledger: '0',
        rail: String(eur('2')),
        atOpening: '0',
      });

      await expect(signOffBooks(w.tenantId, w.person, { note: 'again' })).rejects.toThrow(
        /already signed off: send supersede/,
      );
      await expect(
        signOffBooks(w.tenantId, w.person, { note: 'again', supersede: true }),
      ).rejects.toThrow();
      rail.simulateDeposit('EUR', 1n, 'another');
      await reconcile(w.tenantId, 'signed-open');
      const second = await signOffBooks(w.tenantId, w.person, {
        note: 'Another stray cent',
        supersede: true,
        reason: 'A later check found more',
      });
      expect(second.supersedes).toEqual({ id: first.id, reason: 'A later check found more' });
      expect(second.snapshotHash).not.toBe(first.snapshotHash);
    } finally {
      delete deps().railOwners['signed-open'];
    }
  });

  it('counts the day from midnight in the time zone given', () => {
    // 03:30 in New York on the morning clocks went forward: the day began at 05:00 UTC.
    expect(businessDay(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toEqual({
      date: '2026-03-08',
      start: new Date('2026-03-08T05:00:00Z'),
    });
    expect(businessDay(new Date('2026-11-15T20:00:00Z'), 'Pacific/Auckland')).toEqual({
      date: '2026-11-16',
      start: new Date('2026-11-15T11:00:00Z'),
    });
  });

  it('starts the month at midnight on the first in the time zone given', () => {
    // Clocks went forward on 8 March, so the first was still five hours behind UTC.
    expect(monthStart(new Date('2026-03-20T12:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-03-01T05:00:00Z'),
    );
    expect(monthStart(new Date('2026-11-30T20:00:00Z'), 'Pacific/Auckland')).toEqual(
      new Date('2026-11-30T11:00:00Z'),
    );
    expect(monthStart(new Date('2026-11-30T20:00:00Z'), 'UTC')).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
  });
});

describe('control actions that were not recorded before', () => {
  it('records rail refs, manual credits, member status and keys, with who and why', async () => {
    const w = await makeWorld(main);
    const ada = { ...w.platform, operator: 'Ada Ops' };
    const change = (refs: Record<string, string>, reason: string) =>
      setMemberRailRefs(w.tenantId, w.house, w.supplier, { refs, reason });
    const asked = async (refs: Record<string, string>, reason: string) => {
      const out = await change(refs, reason);
      if (out.status !== 'pending_approval') throw new Error('Not held for approval');
      return out;
    };
    // Where a member is paid is the classic fraud path: a key, even with a name, cannot change it.
    await expect(
      setMemberRailRefs(w.tenantId, ada, w.supplier, {
        refs: { mock_account: 'acct-1' },
        reason: 'Onboarding',
      }),
    ).rejects.toMatchObject({ code: 'person_required' });
    const onboarding = await asked({ mock_account: 'acct-1' }, 'Onboarding');
    // Held: nothing changes until a second house person approves.
    expect(await controlEventsOf(w.tenantId, 'rail_refs_changed')).toEqual([]);
    await expect(approveRequest(w.tenantId, w.house, onboarding.approvalId)).rejects.toThrow(
      /second person/,
    );
    await expect(approveRequest(w.tenantId, w.person, onboarding.approvalId)).rejects.toMatchObject(
      { code: 'forbidden' },
    );
    await approveRequest(w.tenantId, w.checker, onboarding.approvalId);
    const newBank = await asked({ mock_account: 'acct-2' }, 'Supplier changed bank');
    const typo = await asked({ mock_account: 'acct-3' }, 'Typo');
    await approveRequest(w.tenantId, w.checker, newBank.approvalId);
    // The other request was asked against acct-1: approving it now would not be what was seen.
    await expect(approveRequest(w.tenantId, w.checker, typo.approvalId)).rejects.toThrow(
      /changed since this request/,
    );
    await rejectRequest(w.tenantId, w.house, typo.approvalId, { reason: 'Asked against acct-1' });
    // Nothing changes, so nothing is asked.
    expect(await change({ mock_account: 'acct-2' }, 'Same again')).toEqual({ status: 'unchanged' });
    await expect(
      setMemberRailRefs(w.tenantId, w.house, w.supplier, { refs: { mock_account: 'x' } } as never),
    ).rejects.toThrow();
    const refs = await controlEventsOf(w.tenantId, 'rail_refs_changed');
    const approvedBy = expect.objectContaining({ userId: w.checker.userId, via: 'session' });
    expect(refs.map((e) => [e.reason, e.payload])).toEqual([
      [
        'Onboarding',
        {
          memberId: w.supplier,
          before: { mock_account: null },
          after: { mock_account: 'acct-1' },
          approvalId: onboarding.approvalId,
          approvedBy,
        },
      ],
      [
        'Supplier changed bank',
        {
          memberId: w.supplier,
          before: { mock_account: 'acct-1' },
          after: { mock_account: 'acct-2' },
          approvalId: newBank.approvalId,
          approvedBy,
        },
      ],
    ]);
    expect(refs[0]?.actor).toEqual({
      kind: 'house',
      userId: w.house.userId,
      name: 'Hana House',
      via: 'session',
    });

    const byHand = {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('5'),
      rail: 'mock',
      externalRef: 'by-hand',
      reason: 'Webhook lost, seen on the statement',
    };
    const { reason: _reason, ...noReason } = byHand;
    await expect(creditDeposit(w.tenantId, w.person, noReason as never)).rejects.toThrow();
    // A key, even with a name typed in, is not a person, and money in by hand needs one.
    await expect(creditDeposit(w.tenantId, ada, byHand)).rejects.toMatchObject({
      code: 'person_required',
    });
    // Four eyes by default: it waits for a second person, and nothing is credited until then.
    const held = await creditDeposit(w.tenantId, w.person, byHand);
    expect(held).toMatchObject({ status: 'pending_approval', kind: 'manual_credit' });
    const approvalId = (held as { approvalId: string }).approvalId;
    expect(await w.available(w.retailer, 'EUR')).toBe(0n);
    expect((await listApprovals(w.tenantId, null)).rows.map((a) => a.approvalId)).toEqual([
      approvalId,
    ]);
    await expect(approveRequest(w.tenantId, w.person, approvalId)).rejects.toThrow(/second person/);
    await expect(approveRequest(w.tenantId, ada, approvalId)).rejects.toMatchObject({
      code: 'person_required',
    });
    await approveRequest(w.tenantId, w.checker, approvalId, { note: 'Seen on the statement' });
    await expect(approveRequest(w.tenantId, w.checker, approvalId)).rejects.toThrow(
      /already approved/,
    );
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('5'));
    expect((await listApprovals(w.tenantId, null)).rows).toEqual([]);
    const [credit] = await controlEventsOf(w.tenantId, 'manual_credit');
    expect(credit?.payload).toMatchObject({
      memberId: w.retailer,
      amount: String(eur('5')),
      approvalId,
      approvedBy: { userId: w.checker.userId, via: 'session' },
    });
    expect(credit?.actor).toMatchObject({ userId: w.person.userId, via: 'session' });
    expect((await controlEventsOf(w.tenantId, 'approval_approved')).at(-1)?.payload).toMatchObject({
      approvalId,
      kind: 'manual_credit',
    });

    // Above the tenant's threshold only: below it one person is enough.
    await updateTenantSettings(
      w.tenantId,
      { ...w.checker },
      {
        fourEyesAbove: { EUR: eur('10').toString() },
        reason: 'Small corrections by one person',
      },
    );
    expect(
      await creditDeposit(w.tenantId, w.person, { ...byHand, externalRef: 'by-hand-2' }),
    ).toEqual({ status: 'credited' });
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('10'));

    await suspendMember(w.tenantId, ada, w.retailer, { reason: 'KYC lapsed' });
    await reinstateMember(w.tenantId, ada, w.retailer, { reason: 'KYC renewed' });
    expect(
      [
        ...(await controlEventsOf(w.tenantId, 'member_suspended')),
        ...(await controlEventsOf(w.tenantId, 'member_reinstated')),
      ].map((e) => [e.type, e.reason, e.payload.from]),
    ).toEqual([
      ['member_suspended', 'KYC lapsed', 'active'],
      ['member_reinstated', 'KYC renewed', 'suspended'],
    ]);

    const issued = await createApiKey(w.tenantId, ada, {
      name: 'inspector',
      principal: 'inspector',
    });
    await revokeApiKey(w.tenantId, ada, issued.id);
    await revokeApiKey(w.tenantId, ada, issued.id);
    const keys = [
      ...(await controlEventsOf(w.tenantId, 'key_issued')),
      ...(await controlEventsOf(w.tenantId, 'key_revoked')),
    ];
    // The tenant's first key came from the operator.
    expect(keys.map((e) => [e.type, e.actor.kind, e.payload.keyId ?? null])).toEqual([
      ['key_issued', 'operator', expect.any(String)],
      ['key_issued', 'platform', issued.id],
      ['key_revoked', 'platform', issued.id],
    ]);
    expect(JSON.stringify(keys)).not.toContain(issued.key);
  });

  it('pages rows written in one transaction without skipping or repeating any', async () => {
    const w = await makeWorld(main);
    // One transaction: every row shares its created_at, so only the id orders them.
    await engine.db.transaction(async (db) => {
      for (const reason of ['one', 'two', 'three', 'four']) {
        await db.insert(controlEvents).values({
          tenantId: w.tenantId,
          type: 'settlement_stopped',
          actor: { kind: 'system', via: 'system' },
          reason,
        });
      }
      for (const status of ['clean', 'clean', 'clean'] as const) {
        await db.insert(reconRuns).values({
          tenantId: w.tenantId,
          rail: 'tied',
          status,
          breakCount: 0,
          summary: { kind: 'comparison', transactions: 0, fees: 0, positions: [] },
        });
      }
    });
    const walk = async <T extends { id: string }>(
      read: (before: string | undefined) => Promise<{ rows: T[]; next: string | null }>,
    ) => {
      const seen: string[] = [];
      let before: string | undefined;
      do {
        const page = await read(before);
        seen.push(...page.rows.map((r) => r.id));
        before = page.next ?? undefined;
      } while (before);
      return seen;
    };
    const controls = (await controlEventFeed(w.tenantId, { type: 'settlement_stopped' })).rows;
    expect(controls).toHaveLength(4);
    const activity = (await activityFeed(w.tenantId, { limit: 500 })).rows;
    for (const limit of [1, 2]) {
      expect(
        await walk((before) =>
          controlEventFeed(w.tenantId, { type: 'settlement_stopped', limit, before }),
        ),
      ).toEqual(controls.map((e) => e.id));
      // Across sources too: control events and checks of the books written at the same moment.
      expect(await walk((before) => activityFeed(w.tenantId, { limit, before }))).toEqual(
        activity.map((a) => a.id),
      );
    }
    expect(activity.filter((a) => a.source === 'recon')).toHaveLength(3);
    await expect(activityFeed(w.tenantId, { before: 'nonsense' })).rejects.toThrow();
  });

  it('pages and exports the population for an auditor', async () => {
    const w = await makeWorld(main);
    for (const reason of ['one', 'two', 'three']) {
      await suspendMember(w.tenantId, w.platform, w.retailer, { reason });
    }
    const all = (await controlEventFeed(w.tenantId)).rows;
    const newest = all.slice(0, 2);
    expect(
      (await controlEventFeed(w.tenantId, { limit: '2' as never })).rows.map((e) => e.id),
    ).toEqual(newest.map((e) => e.id));
    const page = await controlEventFeed(w.tenantId, { limit: 2 });
    expect(page.next).toBe(newest[1]?.id);
    const rest = (await controlEventFeed(w.tenantId, { before: page.next ?? undefined })).rows;
    expect(rest.map((e) => e.id)).toEqual(all.slice(2).map((e) => e.id));
    const from = all[1]?.createdAt.toISOString();
    expect((await controlEventFeed(w.tenantId, { from: from as never })).rows).toHaveLength(2);
    expect(
      (await controlEventFeed(w.tenantId, { to: all.at(-1)?.createdAt.toISOString() as never }))
        .rows,
    ).toEqual([]);
    await expect(controlEventFeed(w.tenantId, { limit: 501 })).rejects.toThrow();
    await expect(controlEventFeed(w.tenantId, { from: 'yesterday' })).rejects.toThrow();

    const csv = (await controlEventsCsv(w.tenantId)).body.split('\r\n');
    expect(csv[0]).toBe(
      'id,at,type,actor_kind,actor_key_id,actor_name,actor_operator,actor_user_id,actor_via,reason,payload',
    );
    expect(csv[1]).toContain(',member_suspended,platform,platform-test,,,,key,three,');
  });
});

describe('the record of four eyes', () => {
  it('keeps every request, who decided it, when and why, and those that expired', async () => {
    const w = await makeWorld(main);
    const credit = async (externalRef: string) => {
      const out = await creditDeposit(w.tenantId, w.person, {
        memberId: w.retailer,
        currency: 'EUR',
        amount: eur('5'),
        rail: 'mock',
        externalRef,
        reason: 'Seen on the statement',
      });
      if (!('approvalId' in out)) throw new Error('Not held for approval');
      return out.approvalId;
    };
    const approved = await credit('history-1');
    const rejected = await credit('history-2');
    const waiting = await credit('history-3');
    await approveRequest(w.tenantId, w.checker, approved, { note: 'Matches the statement' });
    await rejectRequest(w.tenantId, w.checker, rejected, { reason: 'No such line' });

    const ids = async (status: 'pending' | 'decided' | 'all') =>
      (await listApprovals(w.tenantId, null, { status })).rows.map((r) => [r.approvalId, r.status]);
    expect(await ids('pending')).toEqual([[waiting, 'pending']]);
    expect(await ids('decided')).toEqual([
      [rejected, 'rejected'],
      [approved, 'approved'],
    ]);
    expect(await ids('all')).toHaveLength(3);
    const decided = (await listApprovals(w.tenantId, null, { status: 'decided' })).rows;
    expect(decided.map((r) => r.decision)).toEqual([
      {
        by: expect.objectContaining({ userId: w.checker.userId }),
        at: expect.any(Date),
        reason: 'No such line',
      },
      {
        by: expect.objectContaining({ userId: w.checker.userId }),
        at: expect.any(Date),
        reason: 'Matches the statement',
      },
    ]);
    // Pages like every other list.
    const first = await listApprovals(w.tenantId, null, { status: 'all', limit: 2 });
    const rest = await listApprovals(w.tenantId, null, {
      status: 'all',
      limit: 2,
      before: first.next ?? undefined,
    });
    expect([...first.rows, ...rest.rows].map((r) => r.approvalId)).toEqual([
      waiting,
      rejected,
      approved,
    ]);

    // Nobody decided the last one in time: it leaves the queue and stays on the record.
    const later = Date.now() + APPROVAL_TTL_MS + 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(await ids('pending')).toEqual([]);
      expect((await ids('decided'))[0]).toEqual([waiting, 'expired']);
    } finally {
      clock.mockRestore();
    }

    const out = await approvalsCsv(w.tenantId);
    const lines = out.body.trim().split('\r\n');
    expect(out.rows).toBe(3);
    expect(lines[0]).toBe(
      'id,kind,status,requested_at,requested_by_kind,requested_by_key_id,requested_by_name,requested_by_operator,requested_by_user_id,requested_by_via,reason,currency,amount_minor,amount_major,expires_at,decided_at,decided_by_kind,decided_by_key_id,decided_by_name,decided_by_operator,decided_by_user_id,decided_by_via,decision_reason,request',
    );
    expect(lines.find((l) => l.startsWith(rejected))).toContain(',rejected,');
    expect(lines.find((l) => l.startsWith(rejected))).toContain(',No such line,');
  });
});
