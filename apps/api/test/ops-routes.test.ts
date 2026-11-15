import { randomUUID } from 'node:crypto';
import { runMigrations } from '@novate/db/migrate';
import { testPoolSize } from '@novate/db/test-databases';
import { launchEngine } from '@novate/engine';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { testEngine } from './people.ts';

let engine: Awaited<ReturnType<typeof launchEngine>>;
const ADMIN = 'test-admin-key';
const app = createApp({ isOperator: async (key) => key === ADMIN });

const call = (path: string, key: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const body = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

beforeAll(async () => {
  await runMigrations();
  engine = await launchEngine({
    ...testEngine(),
    pace: 0.01,
    poolSize: testPoolSize,
    appName: `novate-ops-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail()),
  });
});
afterAll(() => engine?.shutdown());

async function setUp() {
  const { tenant, apiKey } = await body<{ tenant: { id: string }; apiKey: string }>(
    await call('/operator/tenants', ADMIN, { method: 'POST', body: { name: 'ops' } }),
  );
  const base = `/tenants/${tenant.id}`;
  const member = async (name: string, extra = {}) =>
    (
      await body<{ id: string }>(
        await call(`${base}/members`, apiKey, {
          method: 'POST',
          body: { name, homeCurrency: 'EUR', ...extra },
        }),
      )
    ).id;
  const agent = async (memberId: string) =>
    (
      await body<{ id: string }>(
        await call(`${base}/agents`, apiKey, {
          method: 'POST',
          body: { memberId, name: 'buyer', mandate: { roles: ['buy'], limits: { EUR: {} } } },
        }),
      )
    ).id;
  const memberKey = async (memberId: string) =>
    (
      await body<{ key: string }>(
        await call(`${base}/keys`, apiKey, {
          method: 'POST',
          body: { name: 'portal', principal: 'member', memberId },
        }),
      )
    ).key;
  return { base, apiKey, member, agent, memberKey };
}

describe('routes for treasurers, operations and the platform', () => {
  it('lets a member suspend only its own agent, and never reinstate it', async () => {
    const t = await setUp();
    const mine = await t.member('Mine');
    const other = await t.member('Other');
    const myAgent = await t.agent(mine);
    const theirAgent = await t.agent(other);
    const key = await t.memberKey(mine);
    const suspend = (agentId: string, b: unknown = { reason: 'it misbehaved' }) =>
      call(`${t.base}/agents/${agentId}/suspend`, key, { method: 'POST', body: b });
    expect((await suspend(myAgent, {})).status).toBe(422);
    expect((await suspend(theirAgent)).status).toBe(404);
    expect((await suspend(myAgent)).status).toBe(200);
    const reinstate = await call(`${t.base}/agents/${myAgent}/reinstate`, key, {
      method: 'POST',
      body: { reason: 'back' },
    });
    expect(reinstate.status).toBe(403);
  });

  it('answers a refused withdrawal with its own code', async () => {
    const t = await setUp();
    const mine = await t.member('Mine');
    const key = await t.memberKey(mine);
    const res = await call(`${t.base}/members/${mine}/withdrawals`, key, {
      method: 'POST',
      body: { currency: 'EUR', amount: '100', idempotencyKey: randomUUID() },
    });
    expect(res.status).toBe(422);
    expect(await body(res)).toMatchObject({ error: 'no_payout_account' });
    const account = await body(await call(`${t.base}/members/${mine}/account`, key));
    expect(account.holds).toEqual({ settlement: null, rails: [], withdrawals: null });
  });

  it('keeps onboarding facts and asks the house for accounts', async () => {
    const t = await setUp();
    const id = await t.member('Lisbon ceramics', { country: 'PT', legalName: 'Cerâmica Lda' });
    const key = await t.memberKey(id);
    const patch = (k: string) =>
      call(`${t.base}/members/${id}`, k, {
        method: 'PATCH',
        body: { contactEmail: 'ops@ceramica.example', reason: 'onboarding call' },
      });
    expect((await patch(key)).status).toBe(403);
    expect(await body(await patch(t.apiKey))).toMatchObject({
      contactEmail: 'ops@ceramica.example',
      country: 'PT',
    });
    const asked = await call(`${t.base}/members/${id}/provision-request`, t.apiKey, {
      method: 'POST',
      body: { note: 'EUR please' },
    });
    expect(asked.status).toBe(201);
    const pending = await body<{ memberId: string }[]>(
      await call(`${t.base}/provision-requests`, t.apiKey),
    );
    expect(pending.map((p) => p.memberId)).toEqual([id]);
    const exposure = await body<{ members: { memberId: string; waitingSince: string }[] }>(
      await call(`${t.base}/exposure`, t.apiKey),
    );
    expect(exposure.members.find((m) => m.memberId === id)?.waitingSince).toBeTruthy();
    expect((await call(`${t.base}/users?memberId=${id}`, t.apiKey)).status).toBe(200);
    expect((await call(`${t.base}/users?memberId=nope`, t.apiKey)).status).toBe(422);
  });

  it('serves payouts, withdrawals and control events by type, to the house and platform only', async () => {
    const t = await setUp();
    const mine = await t.member('Mine');
    const key = await t.memberKey(mine);
    for (const path of ['payouts', 'payouts?status=in_doubt', 'withdrawals?status=failed']) {
      expect((await call(`${t.base}/${path}`, t.apiKey)).status).toBe(200);
      expect((await call(`${t.base}/${path}`, key)).status).toBe(403);
    }
    expect((await call(`${t.base}/payouts?status=confirmed`, t.apiKey)).status).toBe(422);
    const refresh = await call(`${t.base}/payouts/${randomUUID()}/refresh`, t.apiKey, {
      method: 'POST',
    });
    expect(refresh.status).toBe(403);
    const assign = await call(`${t.base}/reconciliation/breaks/${randomUUID()}/assign`, t.apiKey, {
      method: 'POST',
    });
    expect(assign.status).toBe(404);

    await call(`${t.base}/members/${mine}`, t.apiKey, {
      method: 'PATCH',
      body: { legalName: 'Mine BV' },
    });
    const { rows: events } = await body<{ rows: { type: string }[] }>(
      await call(`${t.base}/control-events?type=member_updated&type=agent_added`, t.apiKey),
    );
    expect(events.map((e) => e.type)).toEqual(['member_updated']);
    expect((await call(`${t.base}/control-events?type=nope`, t.apiKey)).status).toBe(422);
    const status = await body(await call(t.base, t.apiKey));
    expect(status.heldRails).toEqual([]);
  });

  it('names the field a bad input got wrong, and finds nothing at an id that is not one', async () => {
    const t = await setUp();
    const res = await call(`${t.base}/members`, t.apiKey, { method: 'POST', body: { name: 7 } });
    expect(res.status).toBe(422);
    expect((await body<{ message: string }>(res)).message).toMatch(/^Invalid input: name: /);
    expect((await call('/deals/not-a-uuid', t.apiKey)).status).toBe(404);
    expect((await call(`${t.base}/members/not-a-uuid/balances`, t.apiKey)).status).toBe(404);
  });
});
