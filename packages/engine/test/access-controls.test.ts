import { randomUUID } from 'node:crypto';
import type { Principal } from '@novate/core';
import { cycles, rowHistory, sessions, users } from '@novate/db';
import { MockRail } from '@novate/rails';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCsv } from '../src/csv.ts';
import {
  acceptInvite,
  approveRequest,
  assertWholeExport,
  configureAuth,
  contributeToDefaultFund,
  controlEventsCsv,
  createApiKey,
  decideCase,
  type Engine,
  EXPORT_MAX_ROWS,
  inviteToken,
  inviteUser,
  listApiKeys,
  listApprovals,
  login,
  openBreaks,
  principalForKey,
  principalOfUser,
  reissueInvite,
  rejectRequest,
  requestWithdrawal,
  resetUser,
  resolveBreak,
  rotateApiKey,
  stopSettlement,
  suspendMember,
  tenantStatus,
  userSessions,
} from '../src/index.ts';
import {
  boot,
  brain,
  controlEventsOf,
  eur,
  frozenBigOrder,
  makeWorld,
  notified,
  rigBreak,
  sent,
  shutdown,
  testAuth,
  type World,
  waitFor,
} from './harness.ts';

const main = new MockRail();
let engine: Engine;

beforeAll(async () => {
  engine = await boot(main);
});
afterAll(() => shutdown());

const PASSWORD = 'a long enough password';
const meta = { ip: '203.0.113.9', userAgent: 'test-browser' };
let n = 0;
const address = (who: string) => `${who}.${++n}.${Date.now()}@example.com`;

/** A house person invited by the operator, signed in: the principal a session would give. */
async function housePerson(w: World, name = 'House person') {
  const { user, inviteUrl } = await inviteUser(
    w.tenantId,
    { kind: 'operator', operator: 'setup' },
    { email: address('house'), name, role: 'house' },
  );
  const accepted = await acceptInvite(meta, { token: inviteToken(inviteUrl), password: PASSWORD });
  const [row] = await engine.db.select().from(users).where(eq(users.id, user.id));
  return { principal: principalOfUser(row as never), user: accepted.user, email: user.email };
}

describe('invites and resets', () => {
  it('re-invites only someone who never signed in, and resets anyone else with a reason', async () => {
    const w = await makeWorld(main);
    const admin = await housePerson(w, 'Admin');
    const invited = await inviteUser(w.tenantId, admin.principal, {
      email: address('ops'),
      name: 'Ops',
      role: 'platform',
    });
    expect(invited).toMatchObject({ delivered: 'inviter', inviteUrl: expect.any(String) });
    const invitedEvent = (await controlEventsOf(w.tenantId, 'user_invited')).at(-1);
    expect(invitedEvent?.payload).toMatchObject({
      name: 'Ops',
      role: 'platform',
      delivered: 'inviter',
    });

    // Still invited: a new link is fine, and the old one stops working.
    const again = await reissueInvite(w.tenantId, admin.principal, invited.user.id);
    await expect(
      acceptInvite(meta, { token: inviteToken(invited.inviteUrl), password: PASSWORD }),
    ).rejects.toThrow('expired or was already used');
    await acceptInvite(meta, { token: inviteToken(again.inviteUrl), password: PASSWORD });
    const accepted = (await controlEventsOf(w.tenantId, 'invite_accepted')).at(-1);
    expect(accepted).toMatchObject({
      actor: { kind: 'platform', userId: invited.user.id, via: 'session' },
      payload: { userId: invited.user.id, ip: '203.0.113.9', userAgent: 'test-browser' },
    });
    const signedIn = await login(meta, { email: invited.user.email, password: PASSWORD });
    expect(signedIn.token).toBeTruthy();
    const signIn = (await controlEventsOf(w.tenantId, 'user_signed_in')).at(-1);
    expect(signIn?.payload).toMatchObject({ userId: invited.user.id, ip: '203.0.113.9' });

    // Once active, a new link would hand the inviter the account, so only a reset will do.
    await expect(reissueInvite(w.tenantId, admin.principal, invited.user.id)).rejects.toThrow(
      'reset their account',
    );
    await expect(
      resetUser(w.tenantId, admin.principal, invited.user.id, {} as never),
    ).rejects.toThrow();
    await expect(
      resetUser(w.tenantId, admin.principal, admin.user.id, { reason: 'myself' }),
    ).rejects.toThrow('cannot reset yourself');
    const reset = await resetUser(w.tenantId, admin.principal, invited.user.id, {
      reason: 'Lost their phone',
    });
    expect(reset).toMatchObject({ delivered: 'inviter', user: { status: 'invited', mfa: false } });
    const [row] = await engine.db.select().from(users).where(eq(users.id, invited.user.id));
    expect(row).toMatchObject({ passwordHash: null, totpSecret: null, status: 'invited' });
    const live = await engine.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, invited.user.id));
    expect(live.every((s) => s.revokedAt !== null)).toBe(true);
    expect(live.map((s) => s.endedReason)).toContain('user_reset');
    const [resetEvent] = await controlEventsOf(w.tenantId, 'user_reset');
    expect(resetEvent).toMatchObject({
      reason: 'Lost their phone',
      actor: { userId: admin.user.id, via: 'session' },
      payload: {
        userId: invited.user.id,
        name: 'Ops',
        role: 'platform',
        email: invited.user.email,
      },
    });
    await expect(
      login(meta, { email: invited.user.email, password: PASSWORD }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    const history = await userSessions(w.tenantId, admin.principal, invited.user.id);
    expect(history[0]).toMatchObject({
      ip: '203.0.113.9',
      active: false,
      endedReason: 'user_reset',
    });
  });

  it('sends the link to the invitee, not the inviter, when delivery is configured', async () => {
    const w = await makeWorld(main);
    configureAuth({ ...testAuth, inviteDelivery: 'notification' });
    try {
      const email = address('delivered');
      const out = await inviteUser(
        w.tenantId,
        { kind: 'operator' },
        { email, name: 'Dee', role: 'house' },
      );
      expect(out).not.toHaveProperty('inviteUrl');
      expect(out.delivered).toBe('notification');
      await expect
        .poll(() => notified.find((x) => x.type === 'user_invite' && x.email === email))
        .toMatchObject({ name: 'Dee', role: 'house', why: 'invited' });
      const [event] = await controlEventsOf(w.tenantId, 'user_invited');
      expect(event?.payload).toMatchObject({ delivered: 'notification' });
    } finally {
      configureAuth(testAuth);
    }
  });
});

describe('four eyes', () => {
  it('refuses an approver the requester invited in the last 30 days', async () => {
    const w = await makeWorld(main);
    const maker = await housePerson(w, 'Maker');
    // The maker invites a second "person" to an address they control.
    const sock = await inviteUser(w.tenantId, maker.principal, {
      email: address('sock'),
      name: 'Sock puppet',
      role: 'house',
    });
    await acceptInvite(meta, { token: inviteToken(sock.inviteUrl), password: PASSWORD });
    const [sockRow] = await engine.db.select().from(users).where(eq(users.id, sock.user.id));
    const held = await resolveOrHold(w, maker.principal);
    await expect(
      approveRequest(w.tenantId, principalOfUser(sockRow as never), held),
    ).rejects.toThrow('invited or reset one another');
    // Someone independent may.
    const other = await housePerson(w, 'Independent');
    await approveRequest(w.tenantId, other.principal, held);
    // The item is written off; only the balance it explained is left for a person to close.
    expect((await openBreaks(w.tenantId)).map((b) => b.kind)).toEqual(['balance_mismatch']);
    const [resolved] = await controlEventsOf(w.tenantId, 'break_resolved');
    expect(resolved).toMatchObject({
      actor: { userId: maker.user.id },
      payload: {
        resolution: 'written_off',
        approvalId: held,
        approvedBy: { userId: other.user.id },
      },
    });
  });

  it('writes a difference off only once a second person approves, and a rejection runs nothing', async () => {
    const w = await makeWorld(main);
    const first = await resolveOrHold(w, w.person, 'write-reject');
    await expect(rejectRequest(w.tenantId, w.checker, first, {} as never)).rejects.toThrow();
    await rejectRequest(w.tenantId, w.checker, first, { reason: 'Find it first' });
    await expect(approveRequest(w.tenantId, w.checker, first)).rejects.toThrow('already rejected');
    expect((await openBreaks(w.tenantId)).length).toBeGreaterThan(0);
    const [rejected] = await controlEventsOf(w.tenantId, 'approval_rejected');
    expect(rejected).toMatchObject({ reason: 'Find it first', payload: { approvalId: first } });
  });

  it('holds a person’s decision past the ceiling until a second person approves it', async () => {
    brain.current = undefined;
    const w = await makeWorld(main);
    const { big, case: c } = await frozenBigOrder(w);
    const decision = {
      bindingHash: c.bindingHash,
      rationale: 'Confirmed with the buyer by phone',
      action: { type: 'cancel' as const },
    };
    // A platform key alone cannot decide: nobody would know who did.
    await expect(decideCase(c.id, w.platform, decision)).rejects.toMatchObject({
      code: 'person_required',
    });
    const held = await decideCase(c.id, w.person, decision);
    expect(held).toMatchObject({ status: 'pending_approval', kind: 'case_decision' });
    expect((await listApprovals(w.tenantId, null)).rows.map((a) => a.kind)).toEqual([
      'case_decision',
    ]);
    await approveRequest(w.tenantId, w.checker, (held as { approvalId: string }).approvalId);
    await waitFor(big.id, ['cancelled']);
  });
});

/** Make a break and ask to write it off as `who`: returns the approval id. */
async function resolveOrHold(w: World, who: Principal, rail = `write-${randomUUID().slice(0, 8)}`) {
  await rigBreak(w, rail, { stray: eur('4') });
  const [item] = (await openBreaks(w.tenantId)).filter((b) => b.rail === rail && b.countsAsItem);
  await expect(
    resolveBreak(w.tenantId, w.platform, item?.id as string, {
      resolution: 'written_off',
      reason: 'Too small to chase',
    }),
  ).rejects.toMatchObject({ code: 'person_required' });
  const out = await resolveBreak(w.tenantId, who, item?.id as string, {
    resolution: 'written_off',
    reason: 'Too small to chase',
  });
  expect(out).toMatchObject({ status: 'pending_approval', kind: 'break_write_off' });
  return (out as { approvalId: string }).approvalId;
}

describe('money moves name a person', () => {
  it('records the default fund move with who, why and how much, once', async () => {
    const w = await makeWorld(main);
    await w.fund(w.retailer, 'EUR', eur('50'));
    const move = {
      memberId: w.retailer,
      currency: 'EUR',
      amount: eur('20'),
      idempotencyKey: 'df-1',
      reason: 'Annual contribution',
    };
    await expect(contributeToDefaultFund(w.tenantId, w.platform, move)).rejects.toMatchObject({
      code: 'person_required',
    });
    const { reason: _r, ...noReason } = move;
    await expect(
      contributeToDefaultFund(w.tenantId, w.person, noReason as never),
    ).rejects.toThrow();
    await contributeToDefaultFund(w.tenantId, w.person, move);
    await contributeToDefaultFund(w.tenantId, w.person, move);
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('30'));
    const moved = await controlEventsOf(w.tenantId, 'default_fund_moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      reason: 'Annual contribution',
      actor: { userId: w.person.userId, via: 'session' },
      payload: {
        memberId: w.retailer,
        currency: 'EUR',
        amount: String(eur('20')),
        direction: 'contribute',
      },
    });
  });

  it('keeps who asked for a withdrawal on it', async () => {
    const w = await makeWorld(main);
    await w.fund(w.retailer, 'EUR', eur('30'));
    const asker = { ...w.asMember(w.retailer), name: 'Retailer treasury key' };
    const { id } = await sent(
      requestWithdrawal(w.tenantId, asker, w.retailer, {
        currency: 'EUR',
        amount: eur('10'),
        rail: main.name,
        idempotencyKey: randomUUID(),
      }),
    );
    const [cycle] = await engine.db.select().from(cycles).where(eq(cycles.id, id));
    expect(cycle?.requestedBy).toMatchObject({ kind: 'member', keyId: asker.id, via: 'key' });
    const [event] = await controlEventsOf(w.tenantId, 'withdrawal_requested');
    expect(event).toMatchObject({
      actor: { kind: 'member', via: 'key' },
      payload: {
        withdrawalId: id,
        memberId: w.retailer,
        amount: String(eur('10')),
        status: 'opened',
      },
    });
  });

  it('leaves the tenant row as it was in row_history when settlement stops', async () => {
    const w = await makeWorld(main);
    await stopSettlement(w.tenantId, w.platform, { reason: 'Bank holiday' });
    const history = await engine.db
      .select()
      .from(rowHistory)
      .where(and(eq(rowHistory.tableName, 'tenants'), eq(rowHistory.rowId, w.tenantId)));
    expect(history.at(-1)).toMatchObject({
      op: 'UPDATE',
      old: { settlement_halted_at: null },
      new: { settlement_halt_reason: 'Bank holiday' },
    });
    expect((await tenantStatus(w.tenantId)).settings).toEqual({
      requireTwoStep: true,
      timeZone: 'UTC',
      fourEyesAbove: {},
    });
  });
});

describe('access review', () => {
  it('lists every key with who issued it and when it was last used, and rotates one', async () => {
    const w = await makeWorld(main);
    const issued = await createApiKey(w.tenantId, w.person, {
      name: 'inspector desk',
      principal: 'inspector',
    });
    expect((await principalForKey(issued.key))?.id).toBe(issued.id);
    const before = (await listApiKeys(w.tenantId)).find((k) => k.id === issued.id);
    expect(before).toMatchObject({
      name: 'inspector desk',
      principal: 'inspector',
      createdBy: { userId: w.person.userId, via: 'session' },
      lastUsedAt: expect.any(Date),
      revokedAt: null,
      active: true,
    });
    expect(JSON.stringify(await listApiKeys(w.tenantId))).not.toContain(issued.key);

    const rotated = await rotateApiKey(w.tenantId, w.person, issued.id);
    expect(rotated.key).not.toBe(issued.key);
    expect(await principalForKey(issued.key)).toBeNull();
    expect((await principalForKey(rotated.key))?.kind).toBe('inspector');
    const keys = await listApiKeys(w.tenantId);
    expect(keys.find((k) => k.id === issued.id)).toMatchObject({
      active: false,
      revokedBy: { userId: w.person.userId },
    });
    expect(keys.find((k) => k.id === rotated.id)).toMatchObject({
      name: 'inspector desk',
      active: true,
    });
    const [platformKey] = keys.filter((k) => k.principal === 'platform');
    await expect(rotateApiKey(w.tenantId, w.person, platformKey?.id as string)).rejects.toThrow(
      'operator',
    );
    const revoked = await controlEventsOf(w.tenantId, 'key_revoked');
    expect(revoked.at(-1)?.payload).toMatchObject({ keyId: issued.id, rotatedTo: rotated.id });
  });
});

describe('exports', () => {
  it('returns every row in the range, past any page size, and refuses rather than truncates', async () => {
    const w = await makeWorld(main);
    for (let i = 0; i < 205; i++) {
      await suspendMember(w.tenantId, w.platform, w.retailer, { reason: `r${i}` });
    }
    const out = await controlEventsCsv(w.tenantId);
    expect(out.defaulted).toBe(true);
    expect(out.to.getTime() - out.from.getTime()).toBe(31 * 86_400_000);
    expect(out.rows).toBeGreaterThanOrEqual(205);
    expect(out.body.trimEnd().split('\r\n')).toHaveLength(out.rows + 1);
    const narrow = await controlEventsCsv(w.tenantId, {
      from: new Date(Date.now() - 3_600_000),
      to: new Date(Date.now() + 1_000),
    });
    expect(narrow.defaulted).toBe(false);
    expect(narrow.rows).toBe(out.rows);
    expect(() => assertWholeExport(EXPORT_MAX_ROWS + 1, out)).toThrow(/shorter range/);
    await expect(
      controlEventsCsv(w.tenantId, { from: new Date(), to: new Date(Date.now() - 1) }),
    ).rejects.toThrow();
  });

  it('quotes line breaks and keeps a cell from running as a formula', () => {
    const body = toCsv<{ name: string; amount: string }>(
      [
        ['name', (r) => r.name],
        ['amount', (r) => r.amount],
      ],
      [
        { name: '=HYPERLINK("x")', amount: '-12.50' },
        { name: 'two\r\nlines', amount: '@1' },
      ],
    );
    expect(body).toBe('name,amount\r\n"\'=HYPERLINK(""x"")",-12.50\r\n"two\r\nlines",\'@1\r\n');
  });
});
