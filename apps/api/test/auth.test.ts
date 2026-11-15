import { randomUUID } from 'node:crypto';
import { runMigrations } from '@novate/db/migrate';
import { launchEngine } from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

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
  process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname);
  await runMigrations();
  engine = await launchEngine({
    appName: `novate-api-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail()),
  });
});
afterAll(() => engine?.shutdown());

const makeTenant = async () =>
  (await (await call('/tenants', ADMIN, { method: 'POST', body: { name: 'x' } })).json()) as {
    tenant: { id: string };
    apiKey: string;
  };

describe('api security', () => {
  it('refuses to create a tenant without the operator key', async () => {
    expect((await call('/tenants', 'nope', { method: 'POST', body: { name: 'x' } })).status).toBe(
      403,
    );
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
    expect((await call(`/tenants/${tenant.id}/house-key`, apiKey, { method: 'POST' })).status).toBe(
      403,
    );
    expect((await call(`/tenants/${tenant.id}/house-key`, ADMIN, { method: 'POST' })).status).toBe(
      201,
    );
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
        body: { memberId: member.id, name: 'a', mandate: { roles: ['buy'], currencies: ['EUR'] } },
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

  it('keeps a rail account away from tenants that do not own it', async () => {
    const { tenant } = await makeTenant();
    const house = (await (
      await call(`/tenants/${tenant.id}/house-key`, ADMIN, { method: 'POST' })
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
      await call(`/tenants/${a.tenant.id}/house-key`, ADMIN, { method: 'POST' })
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
