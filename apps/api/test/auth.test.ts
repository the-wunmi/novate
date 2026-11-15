import { randomUUID } from 'node:crypto';
import { runMigrations } from '@novate/db/migrate';
import { testPoolSize } from '@novate/db/test-databases';
import { launchEngine } from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { testEngine } from './people.ts';

let engine: Awaited<ReturnType<typeof launchEngine>>;
const app = createApp({ isOperator: async (key) => key === 'test-admin-key' });
const ADMIN = 'test-admin-key';

const call = (
  path: string,
  key: string | undefined,
  init: { method?: string; body?: unknown } = {},
) =>
  app.request(path, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

beforeAll(async () => {
  await runMigrations();
  engine = await launchEngine({
    ...testEngine(),
    pace: 0.01,
    poolSize: testPoolSize,
    appName: `novate-api-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail()),
  });
});
afterAll(() => engine?.shutdown());

const makeTenant = async () =>
  (await (
    await call('/operator/tenants', ADMIN, { method: 'POST', body: { name: 'x' } })
  ).json()) as {
    tenant: { id: string };
    apiKey: string;
  };

describe('api security', () => {
  it('refuses to create a tenant without the operator key', async () => {
    expect(
      (await call('/operator/tenants', 'nope', { method: 'POST', body: { name: 'x' } })).status,
    ).toBe(403);
  });

  it('refuses requests with no valid key', async () => {
    const { tenant } = await makeTenant();
    expect((await call(`/tenants/${tenant.id}/deals`, undefined)).status).toBe(401);
    expect((await call(`/tenants/${tenant.id}/deals`, 'wrong')).status).toBe(401);
  });

  it('does not let a platform read another tenant', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    expect((await call(`/tenants/${b.tenant.id}/deals`, a.apiKey)).status).toBe(404);
  });

  it('lets only the tenant take a case, and checks the deal list query', async () => {
    const { tenant, apiKey } = await makeTenant();
    const caseId = randomUUID();
    for (const path of ['assign', 'unassign']) {
      const res = await call(`/cases/${caseId}/${path}`, apiKey, { method: 'POST' });
      expect(res.status).toBe(404);
    }
    const deals = (q: string) => call(`/tenants/${tenant.id}/deals?${q}`, apiKey);
    expect((await deals('limit=201')).status).toBe(422);
    expect((await deals('memberId=nope')).status).toBe(422);
    expect((await deals(`before=${randomUUID()}&limit=1`)).status).toBe(200);
    expect((await deals(`before=${new Date().toISOString()}`)).status).toBe(422);
  });

  it('does not let a platform key credit funds', async () => {
    const { tenant, apiKey } = await makeTenant();
    const res = await call(`/tenants/${tenant.id}/deposits`, apiKey, {
      method: 'POST',
      body: { memberId: tenant.id, currency: 'EUR', amount: '100', externalRef: 'x' },
    });
    expect(res.status).toBe(403);
  });

  it('does not let a platform mint a house key', async () => {
    const { tenant, apiKey } = await makeTenant();
    const res = await call(`/tenants/${tenant.id}/keys`, apiKey, {
      method: 'POST',
      body: { name: 'x', principal: 'house' },
    });
    expect(res.status).toBe(422);
    expect(
      (await call(`/operator/tenants/${tenant.id}/house-key`, apiKey, { method: 'POST' })).status,
    ).toBe(403);
    expect(
      (await call(`/operator/tenants/${tenant.id}/house-key`, ADMIN, { method: 'POST' })).status,
    ).toBe(201);
  });

  it('does not let a key be bound to another tenant’s member', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const res = await call(`/tenants/${a.tenant.id}/keys`, a.apiKey, {
      method: 'POST',
      body: { name: 'x', principal: 'member', memberId: b.tenant.id },
    });
    expect(res.status).toBe(404);
  });

  it('does not let a member’s agent withdraw its money', async () => {
    const { tenant, apiKey } = await makeTenant();
    const member = (await (
      await call(`/tenants/${tenant.id}/members`, apiKey, {
        method: 'POST',
        body: { name: 'm', homeCurrency: 'EUR' },
      })
    ).json()) as { id: string };
    const { id: agentId } = (await (
      await call(`/tenants/${tenant.id}/agents`, apiKey, {
        method: 'POST',
        body: { memberId: member.id, name: 'a', mandate: { roles: ['buy'], limits: { EUR: {} } } },
      })
    ).json()) as { id: string };
    const agent = (await (
      await call(`/tenants/${tenant.id}/keys`, apiKey, {
        method: 'POST',
        body: { name: 'a', principal: 'agent', memberId: member.id, agentId },
      })
    ).json()) as { key: string };
    const res = await call(`/tenants/${tenant.id}/members/${member.id}/withdrawals`, agent.key, {
      method: 'POST',
      body: { currency: 'EUR', amount: '1' },
    });
    expect(res.status).toBe(403);
  });

  it('serves a member portal only its own deals, statement and cycles', async () => {
    const { tenant, apiKey } = await makeTenant();
    const base = `/tenants/${tenant.id}`;
    const member = async () =>
      (
        (await (
          await call(`${base}/members`, apiKey, {
            method: 'POST',
            body: { name: 'm', homeCurrency: 'EUR' },
          })
        ).json()) as { id: string }
      ).id;
    const mine = await member();
    const other = await member();
    const { key } = (await (
      await call(`${base}/keys`, apiKey, {
        method: 'POST',
        body: { name: 'portal', principal: 'member', memberId: mine },
      })
    ).json()) as { key: string };

    expect((await call(`${base}/deals`, key)).status).toBe(200);
    expect((await call(`${base}/deals?memberId=${mine}`, key)).status).toBe(200);
    expect((await call(`${base}/deals?memberId=${other}`, key)).status).toBe(403);
    expect((await call(`/cycles/${randomUUID()}`, key)).status).toBe(404);
    expect((await call(`${base}/exposure`, key)).status).toBe(403);
    expect((await call(`${base}/economics`, key)).status).toBe(403);
    expect((await call(`${base}/exposure`, apiKey)).status).toBe(200);
    expect((await call(`${base}/economics?from=2026-01-01`, apiKey)).status).toBe(200);

    const statement = await call(`${base}/members/${mine}/statement?from=2026-01-01`, key);
    expect(await statement.json()).toMatchObject({ lines: [], closingBalance: [], next: null });
    expect((await call(`${base}/members/${other}/statement`, key)).status).toBe(403);
    const csv = await call(`${base}/members/${mine}/statement.csv`, key);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect((await csv.text()).startsWith('at,kind,currency,amount_minor,amount_major')).toBe(true);
  });

  it('serves a member its account, agents, withdrawals and settlement, and nobody else’s', async () => {
    const { tenant, apiKey } = await makeTenant();
    const base = `/tenants/${tenant.id}`;
    const member = async () =>
      (
        (await (
          await call(`${base}/members`, apiKey, {
            method: 'POST',
            body: { name: 'm', homeCurrency: 'EUR' },
          })
        ).json()) as { id: string }
      ).id;
    const mine = await member();
    const other = await member();
    const { key } = (await (
      await call(`${base}/keys`, apiKey, {
        method: 'POST',
        body: { name: 'portal', principal: 'member', memberId: mine },
      })
    ).json()) as { key: string };

    const account = await call(`${base}/members/${mine}/account`, key);
    expect(await account.json()).toMatchObject({
      id: mine,
      depositAccounts: [],
      payoutAccount: null,
      defaultWithdrawalRail: null,
    });
    expect(await (await call(`${base}/members/${mine}/agents`, key)).json()).toEqual([]);
    expect(await (await call(`${base}/members/${mine}/withdrawals`, key)).json()).toEqual({
      rows: [],
      next: null,
    });
    expect(await (await call(`${base}/members/${mine}/settlement`, key)).json()).toEqual({
      cycles: [],
      upcoming: [],
    });
    for (const path of ['account', 'agents', 'withdrawals', 'settlement']) {
      const refused = await call(`${base}/members/${other}/${path}`, key);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: 'forbidden',
        message: "This key can't see that",
      });
    }
    // With no payout account on record, a withdrawal must name its rail.
    const withdrawal = await call(`${base}/members/${mine}/withdrawals`, key, {
      method: 'POST',
      body: { currency: 'EUR', amount: '100', idempotencyKey: randomUUID() },
    });
    expect(withdrawal.status).toBe(422);

    for (const path of [
      'settlement/preview',
      'default-fund',
      'economics.csv',
      'settlement-summary',
      'decision-summary',
      'exposure',
    ]) {
      expect((await call(`${base}/${path}`, key)).status).toBe(403);
      expect((await call(`${base}/${path}`, apiKey)).status).toBe(200);
    }
    expect(await (await call(`${base}/settlement/preview`, apiKey)).json()).toMatchObject({
      groups: [],
    });
  });

  it('lets only the platform change an agent’s mandate', async () => {
    const { tenant, apiKey } = await makeTenant();
    const base = `/tenants/${tenant.id}`;
    const { id: memberId } = (await (
      await call(`${base}/members`, apiKey, {
        method: 'POST',
        body: { name: 'm', homeCurrency: 'EUR' },
      })
    ).json()) as { id: string };
    const { id: agentId } = (await (
      await call(`${base}/agents`, apiKey, {
        method: 'POST',
        body: { memberId, name: 'a', mandate: { roles: ['buy'], limits: { EUR: {} } } },
      })
    ).json()) as { id: string };
    const mandate = { roles: ['buy'], limits: { EUR: { maxPerDeal: '50000' } } };
    const path = `${base}/agents/${agentId}/mandate`;
    const changed = await call(path, apiKey, { method: 'PATCH', body: { mandate, reason: 'cap' } });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      mandate: { limits: { EUR: { maxPerDeal: '50000' } } },
    });
    const bad = await call(path, apiKey, { method: 'PATCH', body: { mandate: { roles: [] } } });
    expect(bad.status).toBe(422);
  });

  it('keeps a rail account away from tenants that do not own it', async () => {
    const { tenant } = await makeTenant();
    const house = (await (
      await call(`/operator/tenants/${tenant.id}/house-key`, ADMIN, { method: 'POST' })
    ).json()) as { key: string };
    const body = { rail: 'mock' };
    expect(
      (await call(`/tenants/${tenant.id}/reconciliation`, house.key, { method: 'POST', body }))
        .status,
    ).toBe(404);
  });

  it('keeps unmatched deposits to the house and margin to the member and platform', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const deposits = `/tenants/${a.tenant.id}/deposits/unattributed`;
    expect((await call(deposits, a.apiKey)).status).toBe(403);
    const house = (await (
      await call(`/operator/tenants/${a.tenant.id}/house-key`, ADMIN, { method: 'POST' })
    ).json()) as { key: string };
    expect((await call(deposits, house.key)).status).toBe(200);
    expect((await call(`/tenants/${a.tenant.id}/margin-calls`, a.apiKey)).status).toBe(200);
    expect((await call(`/tenants/${a.tenant.id}/margin-calls`, b.apiKey)).status).toBe(404);
  });

  it('has no public webhook for an unsigned rail', async () => {
    expect(
      (await call('/rails/mock/webhooks', undefined, { method: 'POST', body: {} })).status,
    ).toBe(404);
  });
});

describe('MCP endpoint', () => {
  const rpc = async (key: string | undefined, method: string, params: unknown = {}) => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return { status: res.status, body: res.status === 200 ? await res.json() : undefined } as {
      status: number;
      body: {
        result: { tools: { name: string }[]; content: { text: string }[]; isError?: boolean };
      };
    };
  };
  it('answers 405 to GET and DELETE, because it keeps no session', async () => {
    const { apiKey } = await makeTenant();
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request('/mcp', {
        method,
        headers: { accept: 'text/event-stream', authorization: `Bearer ${apiKey}` },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  const callTool = async (key: string, name: string, args: unknown = {}) =>
    (await rpc(key, 'tools/call', { name, arguments: args })).body.result;

  const world = async () => {
    const { tenant, apiKey } = await makeTenant();
    const member = async (name: string) =>
      (
        (await (
          await call(`/tenants/${tenant.id}/members`, apiKey, {
            method: 'POST',
            body: { name, homeCurrency: 'EUR' },
          })
        ).json()) as { id: string }
      ).id;
    const spec = { ...presetInputs.netSettlement, overrides: [], settlement: { rail: 'mock' } };
    await call(`/tenants/${tenant.id}/programs`, apiKey, {
      method: 'POST',
      body: { key: 'net', spec },
    });
    return { tenant, apiKey, buyer: await member('Buyer'), seller: await member('Seller') };
  };

  it('needs a key like everything else', async () => {
    expect((await rpc(undefined, 'tools/list')).status).toBe(401);
  });

  it('lists tools an agent can read, including how to shape a deal', async () => {
    const { apiKey } = await makeTenant();
    const { tools } = (await rpc(apiKey, 'tools/list')).body.result;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['whoami', 'submit_deal', 'get_deal', 'submit_evidence']),
    );
  });

  it('runs a deal end to end as the calling key, and keeps other tenants out', async () => {
    const { apiKey, buyer, seller } = await world();
    const submitted = await callTool(apiKey, 'submit_deal', {
      idempotencyKey: randomUUID(),
      programKey: 'net',
      buyerMemberId: buyer,
      sellerMemberId: seller,
      terms: {
        category: 'homeware',
        currency: 'EUR',
        lines: [{ sku: 'MUG-01', description: 'Mug', quantity: 2, unitPrice: '1400' }],
      },
    });
    expect(submitted.isError).toBeFalsy();
    const deal = JSON.parse(submitted.content[0]?.text as string) as { id: string; amount: string };
    expect(deal.amount).toBe('2800');

    const read = await callTool(apiKey, 'get_deal', { dealId: deal.id });
    expect(read.isError).toBeFalsy();

    const stranger = await makeTenant();
    const denied = await callTool(stranger.apiKey, 'get_deal', { dealId: deal.id });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toMatch(/not_found/);
  });

  it('rejects malformed input as an error the agent can read', async () => {
    const { apiKey } = await makeTenant();
    const result = await callTool(apiKey, 'get_deal', { dealId: 'not-a-uuid' });
    expect(result.isError).toBe(true);
  });
});
