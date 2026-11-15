import { randomUUID } from 'node:crypto';
import { runMigrations } from '@novate/db/migrate';
import { testPoolSize } from '@novate/db/test-databases';
import { launchEngine } from '@novate/engine';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { people, testEngine } from './people.ts';

let engine: Awaited<ReturnType<typeof launchEngine>>;
const ADMIN = 'test-admin-key';
const app = createApp({ isOperator: async (key) => key === ADMIN, authPerMinute: 10_000 });
const { send, person } = people(app, ADMIN);

const call = (
  path: string,
  key: string,
  init: { method?: string; body?: unknown; operator?: string } = {},
) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...(init.operator ? { 'x-operator': init.operator } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

beforeAll(async () => {
  await runMigrations();
  engine = await launchEngine({
    ...testEngine(),
    pace: 0.01,
    poolSize: testPoolSize,
    appName: `novate-api-audit-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail()),
  });
});
afterAll(() => engine?.shutdown());

async function house() {
  const { tenant, apiKey } = (await (
    await call('/operator/tenants', ADMIN, { method: 'POST', body: { name: 'audited' } })
  ).json()) as { tenant: { id: string }; apiKey: string };
  const issued = await call(`/operator/tenants/${tenant.id}/house-key`, ADMIN, {
    method: 'POST',
    operator: '  Root Operator  ',
  });
  const { key } = (await issued.json()) as { key: string };
  const member = (await (
    await call(`/tenants/${tenant.id}/members`, apiKey, {
      method: 'POST',
      body: { name: 'm', homeCurrency: 'EUR' },
    })
  ).json()) as { id: string };
  return {
    id: tenant.id,
    base: `/tenants/${tenant.id}`,
    platform: apiKey,
    house: key,
    memberId: member.id,
  };
}

describe('the audit surface', () => {
  it('takes manual credits only from a signed-in person, with a reason and a second person', async () => {
    const t = await house();
    const credit = { memberId: t.memberId, currency: 'EUR', amount: '100', rail: 'mock' };
    // A key, even with a name typed in, cannot credit money by hand.
    const byKey = await call(`${t.base}/deposits`, t.house, {
      method: 'POST',
      operator: 'Ada',
      body: { ...credit, externalRef: 'x', reason: 'Seen on the statement' },
    });
    expect(byKey.status).toBe(403);
    expect(await byKey.json()).toMatchObject({ error: 'person_required' });

    const ada = await person(t.id, 'house', { name: 'Ada' });
    const without = await send(`${t.base}/deposits`, {
      cookie: ada.cookie,
      body: { ...credit, externalRef: 'x' },
    });
    expect(without.status).toBe(422);
    const held = await send(`${t.base}/deposits`, {
      cookie: ada.cookie,
      body: { ...credit, externalRef: 'x', reason: 'Seen on the statement' },
    });
    expect(held.status).toBe(202);
    const { approvalId, status } = (await held.json()) as { approvalId: string; status: string };
    expect(status).toBe('pending_approval');

    const pending = (await (await send(`${t.base}/approvals`, { cookie: ada.cookie })).json()) as {
      rows: { approvalId: string; kind: string; amount: string }[];
    };
    expect(pending.rows).toEqual([
      expect.objectContaining({ approvalId, kind: 'manual_credit', amount: '100' }),
    ]);
    const approve = (cookie: string) =>
      send(`${t.base}/approvals/${approvalId}/approve`, { cookie, method: 'POST' });
    expect((await approve(ada.cookie)).status).toBe(409);
    // Someone Ada invited herself is not independent of her.
    const sock = await person(t.id, 'house', { name: 'Sock', as: { cookie: ada.cookie } });
    expect((await approve(sock.cookie)).status).toBe(409);
    const grace = await person(t.id, 'house', { name: 'Grace' });
    expect((await approve(grace.cookie)).status).toBe(200);
    expect((await approve(grace.cookie)).status).toBe(409);

    const balances = (await (
      await call(`${t.base}/members/${t.memberId}/balances`, t.platform)
    ).json()) as { kind: string; currency: string; balance: string }[];
    expect(balances.find((b) => b.kind === 'available' && b.currency === 'EUR')?.balance).toBe(
      '100',
    );

    const { rows: events } = (await (
      await call(`${t.base}/control-events`, t.platform)
    ).json()) as {
      rows: {
        type: string;
        actor: Record<string, string>;
        reason: string | null;
        payload: Record<string, unknown>;
      }[];
    };
    expect(events.find((e) => e.type === 'manual_credit')).toMatchObject({
      actor: { kind: 'house', userId: ada.id, via: 'session' },
      reason: 'Seen on the statement',
      payload: { approvalId, approvedBy: { userId: grace.id } },
    });
    expect(events.filter((e) => e.type === 'key_issued').map((e) => e.actor)).toContainEqual({
      kind: 'operator',
      operator: 'Root Operator',
      via: 'key',
    });
    expect((await call(`${t.base}/control-events?limit=501`, t.platform)).status).toBe(422);
    expect((await call(`${t.base}/control-events?from=nope`, t.platform)).status).toBe(422);

    // Rejecting needs a reason, and runs nothing.
    const second = await send(`${t.base}/deposits`, {
      cookie: ada.cookie,
      body: { ...credit, externalRef: 'y', reason: 'Another' },
    });
    const { approvalId: other } = (await second.json()) as { approvalId: string };
    const reject = (body?: unknown) =>
      send(`${t.base}/approvals/${other}/reject`, { cookie: grace.cookie, method: 'POST', body });
    expect((await reject()).status).toBe(422);
    expect((await reject({ reason: 'Not on the statement' })).status).toBe(200);
    expect(await (await send(`${t.base}/approvals`, { cookie: ada.cookie })).json()).toEqual({
      rows: [],
      next: null,
    });
  });

  it('exports each population as CSV with fixed columns', async () => {
    const t = await house();
    const headers: Record<string, string> = {
      'control-events': 'id,at,type,actor_kind,',
      decisions: 'case_id,opened_at,closed_at,kind,',
      activity: 'id,at,source,type,deal_id,',
      reconciliation: 'run_id,run_at,rail,run_status,break_id,',
      'decision-records': 'case_id,at,decider_type,decider_id,operator,model,',
      ledger: 'id,at,kind,debit_account,debit_kind,',
      payouts: 'id,cycle_id,member_id,direction,rail,',
      deals: 'id,created_at,program_key,program_version,',
      approvals: 'id,kind,status,requested_at,',
      'reconciliation-positions': 'run_id,run_at,rail,run_status,transactions,currency,',
    };
    for (const [name, start] of Object.entries(headers)) {
      const res = await call(`${t.base}/${name}.csv?limit=10`, t.platform);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');
      expect(res.headers.get('content-disposition')).toContain(`${name}-`);
      // The whole range, never a page: `limit` is ignored, and the headers say what is covered.
      expect(res.headers.get('x-novate-range-defaulted')).toBe('true');
      const from = new Date(res.headers.get('x-novate-from') as string);
      const to = new Date(res.headers.get('x-novate-to') as string);
      expect(to.getTime() - from.getTime()).toBe(31 * 86_400_000);
      const body = await res.text();
      expect(body).toMatch(new RegExp(`^${start}`));
      expect(Number(res.headers.get('x-novate-rows'))).toBe(body.trim().split('\r\n').length - 1);
    }
    const ranged = await call(
      `${t.base}/control-events.csv?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`,
      t.platform,
    );
    expect(ranged.headers.get('x-novate-from')).toBe('2026-01-01T00:00:00.000Z');
    expect(ranged.headers.get('x-novate-range-defaulted')).toBeNull();
    expect(
      (await call(`${t.base}/control-events.csv?from=2026-02-01&to=2026-01-01`, t.platform)).status,
    ).toBe(422);
    const statement = await call(`${t.base}/members/${t.memberId}/statement.csv`, t.platform);
    expect(statement.status).toBe(200);
    expect(statement.headers.get('x-novate-rows')).toMatch(/^\d+$/);
    expect(
      (await call(`${t.base}/economics.csv`, t.platform)).headers.get('x-novate-rows'),
    ).toMatch(/^\d+$/);
  });

  it('asks house and platform people for two-step sign-in before any change', async () => {
    const t = await house();
    const bare = await person(t.id, 'house', { name: 'No phone', twoStep: false });
    // Reading is fine; changing anything is not, except turning two-step on.
    expect((await send(`${t.base}`, { cookie: bare.cookie })).status).toBe(200);
    const stop = await send(`${t.base}/settlement/stop`, {
      cookie: bare.cookie,
      body: { reason: 'try' },
    });
    expect(stop.status).toBe(403);
    expect(await stop.json()).toMatchObject({ error: 'two_step_required' });
    expect((await send('/auth/mfa/setup', { cookie: bare.cookie, method: 'POST' })).status).toBe(
      200,
    );
    const status = (await (await send(`${t.base}`, { cookie: bare.cookie })).json()) as {
      settings: { requireTwoStep: boolean; timeZone: string };
    };
    expect(status.settings).toMatchObject({ requireTwoStep: true, timeZone: 'UTC' });

    // The house may turn the requirement off, with a reason, signed in; a key may not.
    const keyChange = await call(`${t.base}/settings`, t.house, {
      method: 'PATCH',
      body: { requireTwoStep: false, reason: 'pilot' },
    });
    expect(keyChange.status).toBe(403);
    const hal = await person(t.id, 'house', { name: 'Hal' });
    const change = (body: unknown) =>
      send(`${t.base}/settings`, { cookie: hal.cookie, method: 'PATCH', body });
    expect((await change({ requireTwoStep: false })).status).toBe(422);
    expect((await change({ timeZone: 'Mars/Base', reason: 'r' })).status).toBe(422);
    const changed = await change({
      requireTwoStep: false,
      timeZone: 'Europe/London',
      fourEyesAbove: { EUR: '50000' },
      reason: 'Pilot with one operator',
    });
    expect(changed.status).toBe(200);
    expect(
      (await send(`${t.base}/settlement/stop`, { cookie: bare.cookie, body: { reason: 'try' } }))
        .status,
    ).toBe(200);
    const after = (await (await send(`${t.base}`, { cookie: hal.cookie })).json()) as {
      settings: unknown;
    };
    expect(after.settings).toEqual({
      requireTwoStep: false,
      timeZone: 'Europe/London',
      fourEyesAbove: { EUR: '50000' },
    });
    // Everyone signed in to the tenant, and every key, sees times in its zone.
    expect(await (await send('/me', { cookie: hal.cookie })).json()).toMatchObject({
      timeZone: 'Europe/London',
    });
    expect(await (await call('/me', t.platform)).json()).toMatchObject({
      timeZone: 'Europe/London',
    });
    // Months in the fees report are the zone's months.
    expect((await call(`${t.base}/economics`, t.platform)).status).toBe(200);
  });

  it('lists every key for an access review, and rotates one', async () => {
    const t = await house();
    const issued = (await (
      await call(`${t.base}/keys`, t.platform, {
        method: 'POST',
        body: { name: 'member desk', principal: 'member', memberId: t.memberId },
      })
    ).json()) as { id: string; key: string };
    await call('/me', issued.key);
    const list = async () =>
      (await (await call(`${t.base}/keys`, t.house)).json()) as {
        id: string;
        principal: string;
        lastUsedAt: string | null;
        revokedAt: string | null;
        createdBy: Record<string, unknown> | null;
      }[];
    expect((await call(`${t.base}/keys`, issued.key)).status).toBe(403);
    const keys = await list();
    expect(keys.map((k) => k.principal).sort()).toEqual(['house', 'member', 'platform']);
    expect(keys.find((k) => k.id === issued.id)).toMatchObject({
      lastUsedAt: expect.any(String),
      revokedAt: null,
      createdBy: { kind: 'platform', via: 'key' },
    });
    expect(JSON.stringify(keys)).not.toContain(issued.key);
    const rotated = await call(`${t.base}/keys/${issued.id}/rotate`, t.platform, {
      method: 'POST',
    });
    expect(rotated.status).toBe(201);
    const fresh = (await rotated.json()) as { id: string; key: string; replaced: string };
    expect(fresh.replaced).toBe(issued.id);
    expect((await call('/me', issued.key)).status).toBe(401);
    expect((await call('/me', fresh.key)).status).toBe(200);
    expect((await list()).find((k) => k.id === issued.id)?.revokedAt).not.toBeNull();
    const houseKey = (await list()).find((k) => k.principal === 'house');
    expect(
      (await call(`${t.base}/keys/${houseKey?.id}/rotate`, t.house, { method: 'POST' })).status,
    ).toBe(403);
    const platformKey = (await list()).find((k) => k.principal === 'platform');
    for (const target of [houseKey, platformKey]) {
      expect(
        (await call(`${t.base}/keys/${target?.id}`, t.platform, { method: 'DELETE' })).status,
      ).toBe(403);
      expect((await list()).find((k) => k.id === target?.id)?.revokedAt).toBeNull();
    }
  });

  it('exports everyone and every key as they stand, for an access review', async () => {
    const t = await house();
    await person(t.id, 'platform', { name: 'Pat' });
    for (const [name, start] of [
      ['users', 'id,email,name,role,member_id,member_name,status,two_step,'],
      ['keys', 'id,name,kind,member_id,member_name,agent_id,agent_name,active,'],
    ] as const) {
      const res = await call(`${t.base}/${name}.csv`, t.platform);
      expect(res.status).toBe(200);
      // A snapshot of now, so nobody added long ago is left out.
      expect(res.headers.get('x-novate-range-defaulted')).toBeNull();
      const body = await res.text();
      expect(body).toMatch(new RegExp(`^${start}`));
      expect(Number(res.headers.get('x-novate-rows'))).toBe(body.trim().split('\r\n').length - 1);
    }
    const users = await (await call(`${t.base}/users.csv`, t.platform)).text();
    expect(users).toContain(',Pat,platform,,,active,true,');
    // Someone who never accepted shows when their link stops working.
    await call(`${t.base}/users`, t.platform, {
      method: 'POST',
      body: { email: `late.${randomUUID()}@example.com`, name: 'Late', role: 'platform' },
    });
    const listed = (await (await call(`${t.base}/users`, t.platform)).json()) as {
      name: string;
      inviteExpiresAt: string | null;
    }[];
    expect(listed.find((u) => u.name === 'Late')?.inviteExpiresAt).toEqual(expect.any(String));
    expect(listed.find((u) => u.name === 'Pat')?.inviteExpiresAt).toBeNull();
    const keys = await (await call(`${t.base}/keys.csv`, t.house)).text();
    expect(keys.split('\r\n').filter((l) => /,(house|platform),,,,,true,/.test(l))).toHaveLength(2);
  });

  it('holds a change of where a member is paid for a second house person', async () => {
    const t = await house();
    const refs = { mock_account: `acct-${randomUUID()}` };
    const path = `${t.base}/members/${t.memberId}/rail-refs`;
    // The house key alone cannot say who changed a payee.
    expect(
      (await call(path, t.house, { method: 'PUT', body: { refs, reason: 'New bank' } })).status,
    ).toBe(403);
    const ada = await person(t.id, 'house', { name: 'Ada' });
    const grace = await person(t.id, 'house', { name: 'Grace' });
    const asked = await send(path, {
      cookie: ada.cookie,
      method: 'PUT',
      body: { refs, reason: 'New bank' },
    });
    expect(asked.status).toBe(202);
    const { approvalId } = (await asked.json()) as { approvalId: string };
    const member = async () =>
      (
        (await (await call(`${t.base}/members`, t.house)).json()) as {
          id: string;
          railRefs: Record<string, string>;
        }[]
      ).find((m) => m.id === t.memberId);
    expect((await member())?.railRefs).toEqual({});
    expect(
      (await send(`${t.base}/approvals/${approvalId}/approve`, { cookie: ada.cookie, body: {} }))
        .status,
    ).toBe(409);
    expect(
      (await send(`${t.base}/approvals/${approvalId}/approve`, { cookie: grace.cookie, body: {} }))
        .status,
    ).toBe(200);
    expect((await member())?.railRefs).toEqual(refs);
    const history = (await (
      await send(`${t.base}/approvals?status=decided&kind=rail_refs`, { cookie: ada.cookie })
    ).json()) as {
      rows: { approvalId: string; status: string; decision: { by: { name: string } } }[];
    };
    expect(history.rows).toMatchObject([
      { approvalId, status: 'approved', decision: { by: { name: 'Grace' } } },
    ]);
  });

  it('opens a member’s accounts once, and never changes a payee through provisioning', async () => {
    const t = await house();
    const path = `${t.base}/members/${t.memberId}/provision`;
    const provision = (iban: string) =>
      call(path, t.house, {
        method: 'POST',
        body: {
          rail: 'mock',
          countryCode: 'NL',
          currency: 'EUR',
          transferMethods: ['LOCAL'],
          idempotencyKey: randomUUID(),
          beneficiary: { bank_details: { bank_name: 'ABN AMRO', iban } },
        },
      });
    const refs = async () =>
      (
        (await (await call(`${t.base}/members`, t.house)).json()) as {
          id: string;
          railRefs: Record<string, string>;
        }[]
      ).find((m) => m.id === t.memberId)?.railRefs;
    expect(await (await call(`${t.base}/rails`, t.house)).json()).toMatchObject([
      { name: 'mock', opensAccounts: 'beneficiary' },
    ]);
    const asks = async () =>
      ((await (await call(`${t.base}/provision-requests`, t.house)).json()) as unknown[]).length;
    await call(`${t.base}/members/${t.memberId}/provision-request`, t.platform, {
      method: 'POST',
      body: {},
    });
    expect(await asks()).toBe(1);
    expect((await provision('NL91ABNA0417164300')).status).toBe(201);
    // Opening the accounts is what answers the platform's ask.
    expect(await asks()).toBe(0);
    const opened = await refs();
    expect(opened?.mock_beneficiary).toBeTruthy();
    expect((await provision('NL02ABNA0123456789')).status).toBe(409);
    expect(await refs()).toEqual(opened);
    const events = (await (
      await call(`${t.base}/control-events?type=rail_refs_changed`, t.house)
    ).json()) as { rows: { type: string; actor: { kind: string; via: string } }[] };
    expect(events.rows.filter((e) => e.type === 'rail_refs_changed')).toMatchObject([
      { actor: { kind: 'house', via: 'key' } },
    ]);
  });

  it('lets an auditor read what the house reads, and change nothing but their own account', async () => {
    const t = await house();
    const hal = await person(t.id, 'house', { name: 'Hal' });
    const pat = await person(t.id, 'platform', { name: 'Pat' });
    const invite = (as: { cookie: string }) =>
      send(`${t.base}/users`, {
        ...as,
        body: { email: `auditor.${randomUUID()}@example.com`, name: 'Ann', role: 'auditor' },
      });
    // Only the house brings in an auditor.
    expect((await invite(pat)).status).toBe(403);
    const ann = await person(t.id, 'auditor', { name: 'Ann', as: { cookie: hal.cookie } });
    const read = (path: string) => send(path, { cookie: ann.cookie });
    for (const path of [
      t.base,
      `${t.base}/reconciliation`,
      `${t.base}/approvals?status=all`,
      `${t.base}/users`,
      `${t.base}/keys`,
      `${t.base}/control-events`,
      `${t.base}/deals`,
      `${t.base}/members/${t.memberId}/account`,
      `${t.base}/ledger.csv`,
      `${t.base}/users.csv`,
      `${t.base}/users/${hal.id}/sessions`,
      '/me',
    ]) {
      expect([path, (await read(path)).status]).toEqual([path, 200]);
    }
    const write = (path: string, body: unknown = {}, method = 'POST') =>
      send(path, { cookie: ann.cookie, body, method });
    for (const res of [
      await write(`${t.base}/deals`, { idempotencyKey: 'k' }),
      await write(`${t.base}/members/${t.memberId}/suspend`, { reason: 'r' }),
      await write(`${t.base}/members/${t.memberId}/rail-refs`, { refs: {}, reason: 'r' }, 'PUT'),
      await write(`${t.base}/users`, { email: 'x@example.com', name: 'X', role: 'auditor' }),
      await write(`${t.base}/settings`, { reason: 'r', requireTwoStep: false }, 'PATCH'),
      await write(`${t.base}/reconciliation`, { rail: 'mock' }),
      await write(`${t.base}/decisions/${randomUUID()}/recheck`, {}),
    ]) {
      expect(res.status).toBe(403);
    }
    // Their own account is theirs to look after.
    expect(
      (
        await write('/auth/password', {
          current: 'a long enough password',
          next: 'another long enough password',
        })
      ).status,
    ).toBe(200);
  });

  it('takes a reason to resume, and signs off the books, as a signed-in person', async () => {
    const t = await house();
    await call(`${t.base}/settlement/stop`, t.platform, {
      method: 'POST',
      body: { reason: 'checking' },
    });
    expect(
      (
        await call(`${t.base}/settlement/resume`, t.house, {
          method: 'POST',
          body: { reason: 'r' },
        })
      ).status,
    ).toBe(403);
    const hal = await person(t.id, 'house', { name: 'Hal' });
    const resume = (body?: unknown) =>
      send(`${t.base}/settlement/resume`, { cookie: hal.cookie, method: 'POST', body });
    expect((await resume()).status).toBe(422);
    expect((await resume({ reason: 'checked' })).status).toBe(200);

    expect((await call(`${t.base}/books/sign-off`, t.house, { method: 'POST' })).status).toBe(403);
    const signed = await send(`${t.base}/books/sign-off`, { cookie: hal.cookie, method: 'POST' });
    expect(signed.status).toBe(201);
    expect(await signed.json()).toMatchObject({ rails: [], openBreaks: 0, timeZone: 'UTC' });
    expect((await call(`${t.base}/books/sign-off`, t.platform, { method: 'POST' })).status).toBe(
      403,
    );

    const missing = await send(`${t.base}/reconciliation/breaks/${randomUUID()}/resolve`, {
      cookie: hal.cookie,
      body: { resolution: 'explained', reason: 'r' },
    });
    expect(missing.status).toBe(404);
    expect((await call(`${t.base}/reconciliation/breaks`, t.platform)).status).toBe(200);
    // Only the tenant that owns a rail can re-record what it held.
    const opening = await call(`${t.base}/rails/mock/opening`, t.house, {
      method: 'POST',
      body: { reason: 'r' },
    });
    expect(opening.status).toBe(404);
  });
});
