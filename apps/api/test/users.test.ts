import { runMigrations } from '@novate/db/migrate';
import { testPoolSize } from '@novate/db/test-databases';
import {
  authClock,
  base32Decode,
  inviteToken,
  launchEngine,
  purgeEndedSessions,
  totpAt,
  totpStep,
} from '@novate/engine';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import {
  CONSOLE,
  cookieOf,
  address as email,
  PASSWORD,
  people,
  type Send,
  testEngine,
} from './people.ts';

let engine: Awaited<ReturnType<typeof launchEngine>>;
const ADMIN = 'test-admin-key';
const app = createApp({ isOperator: async (key) => key === ADMIN, authPerMinute: 10_000 });
const { send, person } = people(app, ADMIN);

let now = Date.now();
const at = (ms: number) => {
  now = ms;
};

beforeAll(async () => {
  await runMigrations();
  engine = await launchEngine({
    ...testEngine(),
    pace: 0.01,
    poolSize: testPoolSize,
    appName: `novate-users-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail()),
  });
  authClock.now = () => new Date(now);
});
afterEach(() => at(Date.now()));
afterAll(async () => {
  authClock.now = () => new Date();
  await engine?.shutdown();
});

async function tenant() {
  const res = await send('/operator/tenants', { key: ADMIN, body: { name: 't' } });
  const { tenant, apiKey } = (await res.json()) as { tenant: { id: string }; apiKey: string };
  return { id: tenant.id, platformKey: apiKey, base: `/tenants/${tenant.id}` };
}

const login = (body: Record<string, unknown>) => send('/auth/login', { body });

async function member(t: { base: string; platformKey: string }) {
  const res = await send(`${t.base}/members`, {
    key: t.platformKey,
    body: { name: 'm', homeCurrency: 'EUR' },
  });
  return ((await res.json()) as { id: string }).id;
}

describe('people sign in with accounts', () => {
  it('accepts an invite once, then signs in with a session cookie', async () => {
    const t = await tenant();
    const address = email('house');
    const invited = await send(`/operator${t.base}/users`, {
      key: ADMIN,
      body: { email: address, name: 'Ada', role: 'house' },
    });
    const { inviteUrl } = (await invited.json()) as { inviteUrl: string };
    expect(inviteUrl).toMatch(/^http:\/\/localhost:4000\/console\/#\/invite\/[\w-]{43}$/);
    const token = inviteToken(inviteUrl);

    const short = await send('/auth/invites/accept', { body: { token, password: 'short' } });
    expect(short.status).toBe(422);
    const own = await send('/auth/invites/accept', {
      body: { token, password: address.toLowerCase() },
    });
    expect(own.status).toBe(422);

    const accepted = await send('/auth/invites/accept', { body: { token, password: PASSWORD } });
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/novate_session=[\w-]{43}/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');

    const again = await send('/auth/invites/accept', { body: { token, password: PASSWORD } });
    expect(again.status).toBe(422);

    const me = await send('/me', { cookie: cookieOf(accepted) });
    expect(await me.json()).toMatchObject({
      kind: 'house',
      tenantId: t.id,
      name: 'Ada',
      email: address.toLowerCase(),
      mfa: false,
    });

    const signedIn = await login({ email: address, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({
      user: { role: 'house', status: 'active', mfa: false },
      mfaRequired: true,
    });
    expect(cookieOf(signedIn)).toHaveLength(43);
  });

  it('gives one answer for a wrong password and an unknown email, and locks after five', async () => {
    const t = await tenant();
    const ada = await person(t.id, 'house', { twoStep: false });
    const wrong = await login({ email: ada.email, password: 'not the password!' });
    const unknown = await login({ email: email('nobody'), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());

    for (let i = 0; i < 4; i++) await login({ email: ada.email, password: 'still wrong!!' });
    const locked = await login({ email: ada.email, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(((await locked.json()) as { error: string }).error).toBe('invalid_credentials');

    const { rows: events } = (await (
      await send(`${t.base}/control-events`, { key: t.platformKey })
    ).json()) as {
      rows: { type: string; actor: { kind: string }; payload: { userId?: string } }[];
    };
    const lock = events.find((e) => e.type === 'user_login_locked');
    expect(lock).toMatchObject({ actor: { kind: 'system' }, payload: { userId: ada.id } });

    at(Date.now() + 16 * 60_000);
    expect((await login({ email: ada.email, password: PASSWORD })).status).toBe(200);
  });

  it('asks for a code once two-factor sign-in is on, and takes each code only once', async () => {
    const t = await tenant();
    const ada = await person(t.id, 'house', { twoStep: false });
    const start = Date.now();
    at(start);
    const setup = await send('/auth/mfa/setup', { cookie: ada.cookie, method: 'POST' });
    const { secret, otpauthUrl } = (await setup.json()) as { secret: string; otpauthUrl: string };
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const code = (ms: number) => totpAt(base32Decode(secret), totpStep(new Date(ms)));

    const bad = await send('/auth/mfa/enable', { cookie: ada.cookie, body: { code: '000000' } });
    expect(bad.status).toBe(code(start) === '000000' ? 200 : 422);
    const enabled = await send('/auth/mfa/enable', {
      cookie: ada.cookie,
      body: { code: code(start) },
    });
    expect(enabled.status).toBe(200);
    expect(await (await send('/me', { cookie: ada.cookie })).json()).toMatchObject({ mfa: true });

    const noCode = await login({ email: ada.email, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(await noCode.json()).toMatchObject({ error: 'mfa_required' });
    expect(noCode.headers.get('set-cookie')).toBeNull();
    // The code that turned it on has been used.
    const reused = await login({ email: ada.email, password: PASSWORD, code: code(start) });
    expect(reused.status).toBe(401);

    at(start + 30_000);
    const next = code(start + 30_000);
    const ok = await login({ email: ada.email, password: PASSWORD, code: next });
    expect(ok.status).toBe(200);
    expect(await ok.json()).not.toHaveProperty('mfaRequired');
    expect((await login({ email: ada.email, password: PASSWORD, code: next })).status).toBe(401);

    at(start + 60_000);
    const off = await send('/auth/mfa/disable', {
      cookie: cookieOf(ok),
      body: { code: code(start + 60_000) },
    });
    expect(off.status).toBe(200);
    expect((await login({ email: ada.email, password: PASSWORD })).status).toBe(200);
  });

  it('ends a session after 30 idle minutes, or 12 hours however busy', async () => {
    const t = await tenant();
    const ada = await person(t.id, 'house', { twoStep: false });
    const start = Date.now();
    at(start);
    const idle = cookieOf(await login({ email: ada.email, password: PASSWORD }));
    at(start + 29 * 60_000);
    expect((await send('/me', { cookie: idle })).status).toBe(200);
    // That request moved the idle clock on.
    at(start + 58 * 60_000);
    expect((await send('/me', { cookie: idle })).status).toBe(200);
    at(start + 89 * 60_000);
    expect((await send('/me', { cookie: idle })).status).toBe(401);

    at(start);
    const busy = cookieOf(await login({ email: ada.email, password: PASSWORD }));
    let ms = start;
    while (ms < start + 12 * 3_600_000 - 20 * 60_000) {
      ms += 20 * 60_000;
      at(ms);
      expect((await send('/me', { cookie: busy })).status).toBe(200);
    }
    at(start + 12 * 3_600_000 + 1);
    expect((await send('/me', { cookie: busy })).status).toBe(401);
  });

  it('forgets sessions 90 days after they ended', async () => {
    const t = await tenant();
    const house = await person(t.id, 'house', { twoStep: false });
    const ada = await person(t.id, 'platform', { as: { key: t.platformKey }, twoStep: false });
    const sessionsOf = async () =>
      (await (
        await send(`${t.base}/users/${ada.id}/sessions`, { cookie: house.cookie })
      ).json()) as { createdAt: string }[];
    const start = Date.now();
    const day = 86_400_000;
    at(start - 91 * day);
    expect((await login({ email: ada.email, password: PASSWORD })).status).toBe(200);
    at(start - 89 * day);
    expect((await login({ email: ada.email, password: PASSWORD })).status).toBe(200);
    at(start);
    const before = await sessionsOf();
    await purgeEndedSessions(engine.db, new Date(start));
    const after = await sessionsOf();
    expect(after).toHaveLength(before.length - 1);
    expect(after.every((s) => new Date(s.createdAt).getTime() > start - 90 * day)).toBe(true);
  });

  it('logs out, and a changed password ends every other session', async () => {
    const t = await tenant();
    const ada = await person(t.id, 'platform', { as: { key: t.platformKey }, twoStep: false });
    const other = cookieOf(await login({ email: ada.email, password: PASSWORD }));
    const out = await send('/auth/logout', { cookie: ada.cookie, method: 'POST' });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(/novate_session=;.*Max-Age=0/);
    expect((await send('/me', { cookie: ada.cookie })).status).toBe(401);
    expect((await send('/me', { cookie: other })).status).toBe(200);

    const third = cookieOf(await login({ email: ada.email, password: PASSWORD }));
    const changed = await send('/auth/password', {
      cookie: other,
      body: { current: PASSWORD, next: 'an even longer password' },
    });
    expect(changed.status).toBe(200);
    expect((await send('/me', { cookie: other })).status).toBe(200);
    expect((await send('/me', { cookie: third })).status).toBe(401);
    expect((await login({ email: ada.email, password: PASSWORD })).status).toBe(401);
    expect((await login({ email: ada.email, password: 'an even longer password' })).status).toBe(
      200,
    );
  });

  it('refuses a cookie-borne change without the console’s origin and header, but not a key', async () => {
    const t = await tenant();
    const ada = await person(t.id, 'house');
    const stop = (headers: Record<string, string>) =>
      app.request(`${t.base}/settlement/stop`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `novate_session=${ada.cookie}`,
          ...headers,
        },
        body: JSON.stringify({ reason: 'test' }),
      });
    expect((await stop({ origin: CONSOLE.origin })).status).toBe(403);
    expect((await stop({ 'x-requested-with': 'novate' })).status).toBe(403);
    expect(
      (await stop({ 'x-requested-with': 'novate', origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await stop(CONSOLE)).status).toBe(200);
    // Reading needs neither.
    const read = await app.request('/me', { headers: { cookie: `novate_session=${ada.cookie}` } });
    expect(read.status).toBe(200);
    // Nor does a sign-in form posted from elsewhere get anywhere.
    const forged = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: ada.email, password: PASSWORD }),
    });
    expect(forged.status).toBe(403);
    // A key is not sent by a browser on its own, so key requests need no such proof.
    const res = await app.request(`${t.base}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.platformKey}` },
      body: JSON.stringify({ name: 'm', homeCurrency: 'EUR' }),
    });
    expect(res.status).toBe(201);
  });

  it('lets the house manage anyone, the platform its own and members, and members no one', async () => {
    const t = await tenant();
    // Only the operator key makes the first house user. A platform key or person cannot.
    const asPlatformKey = await send(`${t.base}/users`, {
      key: t.platformKey,
      body: { email: email('h'), name: 'h', role: 'house' },
    });
    expect(asPlatformKey.status).toBe(403);
    const house = await person(t.id, 'house');
    const platform = await person(t.id, 'platform', { as: { cookie: house.cookie } });
    const m = await member(t);
    const missing = await send(`${t.base}/users`, {
      cookie: platform.cookie,
      body: { email: email('m'), name: 'm', role: 'member' },
    });
    expect(missing.status).toBe(422);
    const memberUser = await person(t.id, 'member', {
      as: { cookie: platform.cookie },
      memberId: m,
    });
    expect(await (await send('/me', { cookie: memberUser.cookie })).json()).toMatchObject({
      kind: 'member',
      memberId: m,
    });

    const houseByPlatform = await send(`${t.base}/users`, {
      cookie: platform.cookie,
      body: { email: email('h'), name: 'h', role: 'house' },
    });
    expect(houseByPlatform.status).toBe(403);
    const byMember = await send(`${t.base}/users`, {
      cookie: memberUser.cookie,
      body: { email: email('m'), name: 'm', role: 'member', memberId: m },
    });
    expect(byMember.status).toBe(403);
    expect((await send(`${t.base}/users`, { cookie: memberUser.cookie })).status).toBe(403);
    const disableHouse = await send(`${t.base}/users/${house.id}/disable`, {
      cookie: platform.cookie,
      body: { reason: 'try' },
    });
    expect(disableHouse.status).toBe(403);

    // The house disables the platform user: their session ends at once and they cannot sign in.
    const disabled = await send(`${t.base}/users/${platform.id}/disable`, {
      cookie: house.cookie,
      body: { reason: 'left the company' },
    });
    expect(await disabled.json()).toMatchObject({ user: { status: 'disabled' } });
    expect((await send('/me', { cookie: platform.cookie })).status).toBe(401);
    expect((await login({ email: platform.email, password: PASSWORD })).status).toBe(401);
    const reinvite = await send(`${t.base}/users/${platform.id}/invite`, {
      cookie: house.cookie,
      method: 'POST',
    });
    expect(reinvite.status).toBe(409);
    await send(`${t.base}/users/${platform.id}/enable`, {
      cookie: house.cookie,
      body: { reason: 'came back' },
    });
    // The password works again; two-step sign-in is on, so it asks for the code.
    expect(await (await login({ email: platform.email, password: PASSWORD })).json()).toMatchObject(
      { error: 'mfa_required' },
    );

    // Someone who has signed in is never re-invited: that would hand their account to whoever
    // got the link. A reset, with a reason, ends their sessions and clears password and two-step.
    const reissued = await send(`${t.base}/users/${platform.id}/invite`, {
      cookie: house.cookie,
      method: 'POST',
    });
    expect(reissued.status).toBe(409);
    expect(
      (
        await send(`${t.base}/users/${platform.id}/reset`, {
          cookie: house.cookie,
          body: {},
        })
      ).status,
    ).toBe(422);
    const resetRes = await send(`${t.base}/users/${platform.id}/reset`, {
      cookie: house.cookie,
      body: { reason: 'Lost their authenticator' },
    });
    expect(resetRes.status).toBe(201);
    const {
      inviteUrl,
      delivered,
      user: resetUser,
    } = (await resetRes.json()) as {
      inviteUrl: string;
      delivered: string;
      user: { status: string; mfa: boolean };
    };
    expect(delivered).toBe('inviter');
    expect(resetUser).toMatchObject({ status: 'invited', mfa: false });
    expect((await login({ email: platform.email, password: PASSWORD })).status).toBe(401);
    const token = inviteToken(inviteUrl);
    const reset = await send('/auth/invites/accept', {
      body: { token, password: 'a brand new password' },
    });
    expect(reset.status).toBe(200);
    expect((await login({ email: platform.email, password: PASSWORD })).status).toBe(401);
    const sessions = (await (
      await send(`${t.base}/users/${platform.id}/sessions`, { cookie: house.cookie })
    ).json()) as { endedReason: string | null; ip: string | null }[];
    expect(sessions.map((x) => x.endedReason)).toEqual(
      expect.arrayContaining([null, 'user_disabled']),
    );
    // The platform reviews its own people and members', never the house's.
    expect(
      (await send(`${t.base}/users/${house.id}/sessions`, { cookie: cookieOf(reset) })).status,
    ).toBe(403);

    const list = (await (await send(`${t.base}/users`, { cookie: house.cookie })).json()) as {
      role: string;
      passwordHash?: string;
    }[];
    expect(list.map((u) => u.role).sort()).toEqual(['house', 'member', 'platform']);
    expect(JSON.stringify(list)).not.toContain('scrypt');

    const types = (
      (await (await send(`${t.base}/control-events`, { cookie: house.cookie })).json()) as {
        rows: { type: string }[];
      }
    ).rows.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'user_invited',
        'user_disabled',
        'user_enabled',
        'user_reset',
        'invite_accepted',
        'two_step_enabled',
      ]),
    );
  });

  it('records the signed-in person on what they do, and ignores X-Operator from them', async () => {
    const t = await tenant();
    const ada = await person(t.id, 'house', { name: 'Ada Lovelace' });
    const stopped = await send(`${t.base}/settlement/stop`, {
      cookie: ada.cookie,
      headers: { 'x-operator': 'Mallory' },
      body: { reason: 'checking the books' },
    });
    expect(stopped.status).toBe(200);
    const { rows: events } = (await (
      await send(`${t.base}/control-events`, { key: t.platformKey })
    ).json()) as { rows: { type: string; actor: Record<string, unknown> }[] };
    const stop = events.find((e) => e.type === 'settlement_stopped');
    expect(stop?.actor).toEqual({
      kind: 'house',
      userId: ada.id,
      name: 'Ada Lovelace',
      operator: 'Ada Lovelace',
      via: 'session',
    });
  });

  it('leaves keys working exactly as before, for agents and the platform', async () => {
    const t = await tenant();
    const m = await member(t);
    const agent = (await (
      await send(`${t.base}/agents`, {
        key: t.platformKey,
        body: { memberId: m, name: 'a', mandate: { roles: ['buy'], limits: { EUR: {} } } },
      })
    ).json()) as { id: string };
    const { key } = (await (
      await send(`${t.base}/keys`, {
        key: t.platformKey,
        body: { name: 'bot', principal: 'agent', memberId: m, agentId: agent.id },
      })
    ).json()) as { key: string };
    const me = await send('/me', { key });
    expect(me.status).toBe(200);
    // A machine acting for the member does not see who works there.
    expect((await send(`${t.base}/members/${m}/users`, { key })).status).toBe(403);
    expect(await me.json()).toMatchObject({
      kind: 'agent',
      tenantId: t.id,
      memberId: m,
      name: 'bot',
    });
    // A key with X-Operator still names its holder on the record.
    await send(`${t.base}/settlement/stop`, {
      key: t.platformKey,
      headers: { 'x-operator': 'Grace' },
      body: { reason: 'key holder' },
    });
    const { rows: events } = (await (
      await send(`${t.base}/control-events`, { key: t.platformKey })
    ).json()) as { rows: { type: string; actor: Record<string, unknown> }[] };
    expect(events.find((e) => e.type === 'settlement_stopped')?.actor).toMatchObject({
      kind: 'platform',
      keyId: expect.any(String),
      operator: 'Grace',
    });
    // A key wins over a cookie, and session-only routes say so.
    const setup = await send('/auth/mfa/setup', { key: t.platformKey, method: 'POST' });
    expect(setup.status).toBe(403);
    expect(await setup.json()).toMatchObject({ error: 'person_required' });
    expect((await send('/me')).status).toBe(401);
  });
});

describe("a member's own people", () => {
  it('see one another, set their own withdrawal four eyes, and approve only their own', async () => {
    const t = await tenant();
    const mine = await member(t);
    const theirs = await member(t);
    const byPlatform = { as: { key: t.platformKey } };
    const ann = await person(t.id, 'member', { memberId: mine, name: 'Ann', ...byPlatform });
    const bob = await person(t.id, 'member', { memberId: mine, name: 'Bob', ...byPlatform });
    const carol = await person(t.id, 'member', { memberId: theirs, name: 'Carol', ...byPlatform });

    const list = await send(`${t.base}/members/${mine}/users`, { cookie: ann.cookie });
    expect(list.status).toBe(200);
    const users = (await list.json()) as { name: string; mfa: boolean; passwordHash?: string }[];
    expect(users.map((u) => u.name).sort()).toEqual(['Ann', 'Bob']);
    expect(users[0]).not.toHaveProperty('passwordHash');
    expect((await send(`${t.base}/members/${mine}/users`, { cookie: carol.cookie })).status).toBe(
      403,
    );

    const controls = (cookie: string, limits: Record<string, string>) =>
      send(`${t.base}/members/${mine}/controls`, {
        cookie,
        method: 'PUT',
        body: { withdrawalFourEyesAbove: limits, reason: 'treasury policy' },
      });
    expect((await controls(carol.cookie, { EUR: '1000' })).status).toBe(403);
    const set = await controls(ann.cookie, { EUR: '1000' });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ status: 'changed' });
    const loosened = await controls(ann.cookie, { EUR: '5000' });
    expect(loosened.status).toBe(202);
    const { approvalId } = (await loosened.json()) as { approvalId: string };

    const pending = async (cookie: string) =>
      ((await (await send(`${t.base}/approvals`, { cookie })).json()) as { rows: unknown[] }).rows;
    expect(await pending(carol.cookie)).toEqual([]);
    expect(await pending(bob.cookie)).toMatchObject([{ approvalId, kind: 'member_controls' }]);
    // Their requests are theirs: the platform reads them but cannot decide them.
    const platformList = await send(`${t.base}/approvals`, { key: t.platformKey });
    expect(((await platformList.json()) as { rows: unknown[] }).rows).toHaveLength(1);
    const approve = (as: Send) =>
      send(`${t.base}/approvals/${approvalId}/approve`, { ...as, body: {} });
    expect((await approve({ cookie: carol.cookie })).status).toBe(403);
    expect((await approve({ key: t.platformKey })).status).toBe(403);
    expect((await approve({ cookie: ann.cookie })).status).toBe(409);
    expect((await approve({ cookie: bob.cookie })).status).toBe(200);
    const account = await send(`${t.base}/members/${mine}/account`, { cookie: ann.cookie });
    expect(await account.json()).toMatchObject({ withdrawalFourEyesAbove: { EUR: '5000' } });

    // A member exports its own deals only, and reads no one else's.
    const csv = await send(`${t.base}/deals.csv`, { cookie: ann.cookie });
    expect(csv.status).toBe(200);
    expect((await csv.text()).split('\r\n')[0]).toContain('buyer_agent_name');
  });
});
