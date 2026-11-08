import { Currency, DomainError, MinorAmount } from '@novate/core';
import * as engine from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

const STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  insufficient_funds: 402,
  unauthorised_agent: 403,
  policy_error: 422,
};

/** JSON with bigint amounts as strings of minor units. */
const json = (value: unknown, status: ContentfulStatusCode = 200) =>
  new Response(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );

async function body<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success)
    throw new DomainError('invalid', 'Invalid request body', parsed.error.issues);
  return parsed.data;
}

export function createApp() {
  const app = new Hono();

  app.onError((err) => {
    if (err instanceof DomainError) {
      return json(
        { error: err.code, message: err.message, details: err.details },
        STATUS[err.code],
      );
    }
    if (err instanceof z.ZodError) {
      return json({ error: 'invalid', message: 'Invalid request', details: err.issues }, 422);
    }
    console.error(err);
    return json({ error: 'internal', message: 'Internal error' }, 500);
  });

  app.get('/health', () => json({ ok: true }));
  app.get('/presets', () => json(presetInputs));

  // Tenancy
  app.post('/tenants', async (c) =>
    json(await engine.createTenant(await body(c.req.raw, z.object({ name: z.string() }))), 201),
  );

  app.post('/tenants/:tenantId/members', async (c) => {
    const input = await body(
      c.req.raw,
      z.object({
        name: z.string(),
        homeCurrency: Currency,
        railRefs: z.record(z.string(), z.string()).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
      }),
    );
    return json(await engine.createMember({ tenantId: c.req.param('tenantId'), ...input }), 201);
  });
  app.get('/tenants/:tenantId/members', async (c) =>
    json(await engine.listMembers(c.req.param('tenantId'))),
  );
  app.get('/tenants/:tenantId/members/:memberId/balances', async (c) =>
    json(await engine.balances(c.req.param('tenantId'), c.req.param('memberId'))),
  );

  app.post('/tenants/:tenantId/agents', async (c) => {
    const input = await body(
      c.req.raw,
      z.object({
        memberId: z.string().uuid(),
        name: z.string(),
        mandate: z.record(z.string(), z.unknown()),
      }),
    );
    return json(
      await engine.createAgent({ tenantId: c.req.param('tenantId'), ...input } as Parameters<
        typeof engine.createAgent
      >[0]),
      201,
    );
  });

  // Programs
  app.post('/tenants/:tenantId/programs', async (c) => {
    const input = await body(
      c.req.raw,
      z.object({ key: z.string().regex(/^[a-z0-9-]+$/), spec: z.record(z.string(), z.unknown()) }),
    );
    return json(
      await engine.publishProgram({
        tenantId: c.req.param('tenantId'),
        key: input.key,
        spec: input.spec as never,
      }),
      201,
    );
  });
  app.get('/tenants/:tenantId/programs/:key', async (c) =>
    json(await engine.latestProgram(undefined, c.req.param('tenantId'), c.req.param('key'))),
  );

  // Funds
  app.post('/tenants/:tenantId/deposits', async (c) => {
    const input = await body(
      c.req.raw,
      z.object({
        memberId: z.string().uuid(),
        currency: Currency,
        amount: MinorAmount,
        rail: z.string().optional(),
        externalRef: z.string(),
      }),
    );
    await engine.deposit({ tenantId: c.req.param('tenantId'), ...input });
    return json({ ok: true }, 202);
  });

  // Deals
  app.post('/tenants/:tenantId/deals', async (c) => {
    const raw = (await c.req.json()) as Record<string, unknown>;
    return json(
      await engine.submitDeal({ ...raw, tenantId: c.req.param('tenantId') } as engine.SubmitDeal),
      202,
    );
  });
  app.get('/tenants/:tenantId/deals', async (c) =>
    json(await engine.listDeals(c.req.param('tenantId'))),
  );
  app.get('/deals/:dealId', async (c) => json(await engine.dealDetail(c.req.param('dealId'))));
  app.post('/deals/:dealId/facts', async (c) =>
    json(
      await engine.submitFact(c.req.param('dealId'), await body(c.req.raw, engine.SubmitFact)),
      201,
    ),
  );

  // Approvals
  app.get('/tenants/:tenantId/approvals', async (c) =>
    json(await engine.pendingApprovals(c.req.param('tenantId'))),
  );
  app.post('/approvals/:approvalId/decision', async (c) => {
    const input = await body(
      c.req.raw,
      z.object({ bindingHash: z.string(), decision: engine.Decision, decidedBy: z.string() }),
    );
    await engine.decideApproval(c.req.param('approvalId'), input);
    return json({ ok: true }, 202);
  });

  // Cycles
  app.post('/tenants/:tenantId/cycles', async (c) =>
    json(await engine.runCycle(c.req.param('tenantId'))),
  );
  app.get('/cycles/:cycleId', async (c) => json(await engine.cycleDetail(c.req.param('cycleId'))));

  return app;
}
