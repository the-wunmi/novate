import { DomainError, type Principal, parseInput, toJson } from '@novate/core';
import * as engine from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { CONSOLE_CSP, CONSOLE_HTML } from './console.ts';
import { handleMcp } from './mcp.ts';
import { fundDealOverX402, type X402Gateway } from './x402.ts';

const STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  insufficient_funds: 402,
  unauthorised_agent: 403,
  policy_error: 422,
};

/** Bodies above this are refused. Base64 documents are the largest thing the API takes. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Webhooks are read before their signature is checked, so they get a tight limit. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

const MAX_REQUESTS_PER_MINUTE = 600;

const tooLarge = () => json({ error: 'too_large', message: 'Body too large' }, 413);

/** JSON with bigint amounts as strings of minor units. */
const json = (value: unknown, status: ContentfulStatusCode = 200) =>
  new Response(toJson(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Env = { Variables: { principal: Principal } };
type Ctx = Context<Env>;

/** The request body, validated by the engine function it is handed to. Malformed JSON fails there. */
const input = <T>(c: Ctx): Promise<T> => c.req.json<T>().catch(() => undefined as T);

const denied = () => new DomainError('unauthorised_agent', 'Not allowed');

/** The caller's tenant. Paths naming any other tenant never reach a handler. */
const tenantOf = (c: Ctx) => c.get('principal').tenantId;

function requireKind(c: Ctx, ...kinds: Principal['kind'][]): void {
  if (!kinds.includes(c.get('principal').kind)) throw denied();
}

/** The platform and the house can act for any member. Anyone else only for their own. */
function ownMemberOnly(c: Ctx): void {
  const { kind, memberId } = c.get('principal');
  if (kind !== 'platform' && kind !== 'house' && memberId !== c.req.param('memberId')) {
    throw denied();
  }
}

const bearer = (req: Request) => req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];

export interface AppOptions {
  x402?: X402Gateway;
  /** Replaced in tests, so that no known key is ever written to a database a server might use. */
  isOperator?: (key: string) => Promise<boolean>;
}

export function createApp(options: AppOptions = {}) {
  const isOperator = options.isOperator ?? engine.isOperatorKey;
  const requireOperator = async (c: Ctx) => {
    const given = bearer(c.req.raw);
    if (!given || !(await isOperator(given))) throw denied();
  };
  const app = new Hono<Env>();

  app.onError((err) => {
    if (err instanceof DomainError) {
      return json(
        { error: err.code, message: err.message, details: err.details },
        STATUS[err.code],
      );
    }
    console.error(err);
    return json({ error: 'internal', message: 'Internal error' }, 500);
  });

  app.use('*', secureHeaders());
  app.use('/rails/*', bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: tooLarge }));
  app.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }));

  app.get('/health', () => json({ ok: true }));
  // Unlike /health, this fails when the database is out of reach, so traffic can be moved away.
  app.get('/ready', async () => {
    await engine.checkDatabase();
    return json({ ok: true });
  });
  app.get(
    '/console',
    () =>
      new Response(CONSOLE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': CONSOLE_CSP,
        },
      }),
  );

  // ── Operator: only the operator's key can create a tenant or issue a house key ──

  app.post('/tenants', async (c) => {
    await requireOperator(c);
    return json(await engine.createTenant(await input(c)), 201);
  });

  app.post('/tenants/:tenantId/house-key', async (c) => {
    await requireOperator(c);
    return json(await engine.createHouseKey(c.req.param('tenantId')), 201);
  });

  app.post('/tenants/:tenantId/platform-key', async (c) => {
    await requireOperator(c);
    return json(await engine.createPlatformKey(c.req.param('tenantId')), 201);
  });

  // Webhooks authenticate by signature instead of a key. Unsigned rails get no endpoint.
  app.post('/rails/:rail/webhooks', async (c) => {
    const rail = c.req.param('rail');
    if (!engine.railAcceptsWebhooks(rail)) throw new DomainError('not_found', 'No such rail');
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    return json(await engine.ingestRailEvent(rail, await c.req.text(), headers));
  });

  // ── Everything below needs a credential, and acts only inside that credential's tenant ──

  app.use('*', async (c, next) => {
    const key = bearer(c.req.raw);
    const principal = key ? await engine.principalForKey(key) : null;
    if (!principal) {
      return json({ error: 'unauthenticated', message: 'Missing or invalid key' }, 401);
    }
    if (!(await engine.withinRateLimit(principal.id, MAX_REQUESTS_PER_MINUTE))) {
      return json({ error: 'rate_limited', message: 'Too many requests' }, 429);
    }
    c.set('principal', principal);
    await next();
  });
  app.use('/tenants/:tenantId/*', async (c, next) => {
    if (c.req.param('tenantId') !== tenantOf(c)) {
      throw new DomainError('not_found', 'Tenant not found');
    }
    await next();
  });

  app.post('/deals/:dealId/x402', async (c) => {
    if (!options.x402) throw new DomainError('not_found', 'x402 is not enabled');
    const offer = await engine.x402Offer(c.req.param('dealId'), c.get('principal'));
    return fundDealOverX402(engine, options.x402, c.req.raw, offer);
  });

  // Airi needs the merchant and exact amount before it will issue a credential.
  app.get('/deals/:dealId/card', async (c) =>
    json({
      ...(await engine.cardOffer(c.req.param('dealId'), c.get('principal'))),
      merchant: {
        name: process.env.NOVATE_MERCHANT_NAME ?? 'novate',
        url: process.env.NOVATE_MERCHANT_URL ?? 'https://novate.example',
        country: process.env.NOVATE_MERCHANT_COUNTRY ?? 'US',
      },
    }),
  );
  // Direct only, never an MCP tool: card details must stay out of a model's context.
  app.post('/deals/:dealId/card', async (c) => {
    const paid = await engine.payDealByCard(
      c.req.param('dealId'),
      c.get('principal'),
      await input(c),
    );
    return json(paid, paid.status === 'failed' ? 402 : paid.status === 'pending' ? 202 : 200);
  });

  app.post('/mcp', (c) => handleMcp(c.get('principal'), c.req.raw));
  // Stateless, so there is no session to stream to or to end.
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      405,
      {
        allow: 'POST',
      },
    ),
  );

  app.get('/presets', () => json(presetInputs));
  app.get('/me', (c) => {
    const { kind, tenantId, memberId } = c.get('principal');
    return json({ kind, tenantId, memberId });
  });

  app.get('/tenants/:tenantId', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.tenantStatus(tenantOf(c)));
  });

  // Members, agents and credentials
  app.post('/tenants/:tenantId/members', async (c) => {
    requireKind(c, 'platform');
    return json(await engine.createMember(tenantOf(c), await input(c)), 201);
  });
  app.get('/tenants/:tenantId/members', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.listMembers(tenantOf(c)));
  });
  app.put('/tenants/:tenantId/members/:memberId/rail-refs', async (c) => {
    requireKind(c, 'house');
    await engine.setMemberRailRefs(tenantOf(c), c.req.param('memberId'), await input(c));
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/members/:memberId/provision', async (c) => {
    requireKind(c, 'house');
    await engine.provisionMember(tenantOf(c), c.req.param('memberId'), await input(c));
    return json({ ok: true }, 201);
  });
  app.get('/tenants/:tenantId/members/:memberId/margin', async (c) => {
    ownMemberOnly(c);
    return json(await engine.memberMargin(tenantOf(c), c.req.param('memberId') as string));
  });
  app.post('/tenants/:tenantId/members/:memberId/withdrawals', async (c) => {
    ownMemberOnly(c);
    const memberId = c.req.param('memberId');
    return json(await engine.requestWithdrawal(tenantOf(c), memberId, await input(c)), 202);
  });
  app.get('/tenants/:tenantId/members/:memberId/withdrawals/:id', async (c) => {
    ownMemberOnly(c);
    const { memberId, id } = c.req.param();
    return json(await engine.withdrawalDetail(tenantOf(c), memberId, id));
  });
  app.get('/tenants/:tenantId/members/:memberId/statement', async (c) => {
    ownMemberOnly(c);
    const before = c.req.query('before');
    const { memberId } = parseInput(z.object({ memberId: z.string().uuid() }), c.req.param());
    const cursor = before ? parseInput(z.coerce.date(), before) : undefined;
    return json(await engine.memberStatement(tenantOf(c), memberId, cursor));
  });
  app.post('/tenants/:tenantId/members/:memberId/suspend', async (c) => {
    requireKind(c, 'platform', 'house');
    await engine.suspendMember(tenantOf(c), c.req.param('memberId'));
    return json({ ok: true });
  });
  app.get('/tenants/:tenantId/desk', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.deskView(tenantOf(c)));
  });

  app.get('/tenants/:tenantId/agents', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.listAgents(tenantOf(c)));
  });
  for (const [path, status] of [
    ['suspend', 'blocked'],
    ['reinstate', 'active'],
  ] as const) {
    app.post(`/tenants/:tenantId/agents/:agentId/${path}`, async (c) => {
      requireKind(c, 'platform', 'house');
      await engine.setAgentStatus(tenantOf(c), c.req.param('agentId'), status);
      return json({ ok: true });
    });
  }
  app.get('/tenants/:tenantId/events', async (c) => {
    requireKind(c, 'platform', 'house');
    const after = parseInput(z.coerce.bigint().min(0n), c.req.query('after') ?? '0');
    return json(await engine.dealEventFeed(tenantOf(c), after));
  });
  app.get('/tenants/:tenantId/decisions', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.decisionFeed(tenantOf(c)));
  });
  app.get('/tenants/:tenantId/decisions/:caseId', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.decisionTrail(tenantOf(c), c.req.param('caseId')));
  });
  app.get('/tenants/:tenantId/track-record', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.trackRecords(tenantOf(c)));
  });
  app.post('/tenants/:tenantId/shadow-runs', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.startShadowRun(tenantOf(c), await input(c)), 202);
  });
  app.get('/tenants/:tenantId/shadow-runs/:runId', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.shadowRunDetail(tenantOf(c), c.req.param('runId')));
  });
  app.get('/tenants/:tenantId/margin-calls', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.openMarginCalls(tenantOf(c)));
  });
  app.get('/tenants/:tenantId/deposits/unattributed', async (c) => {
    requireKind(c, 'house');
    return json(await engine.unattributedDepositsOf(tenantOf(c)));
  });
  app.post('/tenants/:tenantId/deposits/:depositId/assign', async (c) => {
    requireKind(c, 'house');
    await engine.assignDeposit(tenantOf(c), c.req.param('depositId'), await input(c));
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/members/:memberId/reinstate', async (c) => {
    requireKind(c, 'house');
    await engine.reinstateMember(tenantOf(c), c.req.param('memberId'));
    return json({ ok: true });
  });
  app.get('/tenants/:tenantId/members/:memberId/balances', async (c) => {
    ownMemberOnly(c);
    return json(await engine.balances(tenantOf(c), c.req.param('memberId') as string));
  });
  app.post('/tenants/:tenantId/agents', async (c) => {
    requireKind(c, 'platform');
    return json(await engine.createAgent(tenantOf(c), await input(c)), 201);
  });
  app.post('/tenants/:tenantId/keys', async (c) => {
    requireKind(c, 'platform');
    return json(await engine.createApiKey(tenantOf(c), await input(c)), 201);
  });

  app.delete('/tenants/:tenantId/keys/:keyId', async (c) => {
    requireKind(c, 'platform', 'house');
    await engine.revokeApiKey(tenantOf(c), c.req.param('keyId'));
    return json({ ok: true });
  });

  // Programs
  app.post('/tenants/:tenantId/programs', async (c) => {
    requireKind(c, 'platform');
    return json(await engine.publishProgram(tenantOf(c), await input(c)), 201);
  });
  app.get('/tenants/:tenantId/programs/:key', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.latestProgram(tenantOf(c), c.req.param('key')));
  });

  // Money only arrives through a signed webhook or the house's internal credential.
  app.post('/tenants/:tenantId/deposits', async (c) => {
    requireKind(c, 'house');
    await engine.deposit(tenantOf(c), await input(c));
    return json({ ok: true }, 202);
  });

  app.post('/tenants/:tenantId/default-fund/contributions', async (c) => {
    requireKind(c, 'house');
    await engine.contributeToDefaultFund(tenantOf(c), await input(c));
    return json({ ok: true }, 201);
  });
  app.post('/tenants/:tenantId/default-fund/withdrawals', async (c) => {
    requireKind(c, 'house');
    await engine.withdrawFromDefaultFund(tenantOf(c), await input(c));
    return json({ ok: true }, 201);
  });

  // Deals and evidence
  app.post('/tenants/:tenantId/deals', async (c) =>
    json(await engine.submitDeal(c.get('principal'), await input(c)), 202),
  );
  app.get('/tenants/:tenantId/deals', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.listDeals(tenantOf(c)));
  });
  app.get('/deals/:dealId', async (c) =>
    json(await engine.dealDetail(c.req.param('dealId'), c.get('principal'))),
  );
  app.post('/deals/:dealId/facts', async (c) =>
    json(await engine.submitFact(c.req.param('dealId'), c.get('principal'), await input(c)), 201),
  );
  app.post('/deals/:dealId/documents', async (c) =>
    json(
      await engine.submitDocument(c.req.param('dealId'), c.get('principal'), await input(c)),
      201,
    ),
  );

  // Cases
  app.get('/tenants/:tenantId/cases', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.openCases(tenantOf(c)));
  });
  app.get('/cases/:caseId/records', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.caseRecords(tenantOf(c), c.req.param('caseId')));
  });
  app.post('/cases/:caseId/decision', async (c) => {
    await engine.decideCase(c.req.param('caseId'), c.get('principal'), await input(c));
    return json({ ok: true }, 202);
  });

  // Settlement
  app.post('/tenants/:tenantId/cycles', async (c) => {
    requireKind(c, 'platform', 'house');
    return json({ cycleIds: await engine.startCycles(tenantOf(c)) }, 202);
  });
  app.get('/cycles/:cycleId', async (c) => {
    requireKind(c, 'platform', 'house');
    return json(await engine.cycleDetail(tenantOf(c), c.req.param('cycleId')));
  });
  // A rail account's full history is only for the operator of the tenant that owns that account.
  app.post('/tenants/:tenantId/reconciliation', async (c) => {
    requireKind(c, 'house');
    const { rail } = parseInput(z.object({ rail: z.string() }), await input(c));
    if (engine.railOwner(rail) !== tenantOf(c)) {
      throw new DomainError('not_found', 'No such rail for this tenant');
    }
    return json(await engine.runReconciliation(tenantOf(c), rail));
  });
  app.post('/tenants/:tenantId/settlement/stop', async (c) => {
    requireKind(c, 'platform', 'house');
    await engine.stopSettlement(tenantOf(c), await input(c));
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/settlement/resume', async (c) => {
    requireKind(c, 'house');
    await engine.resumeSettlement(tenantOf(c));
    return json({ ok: true });
  });

  return app;
}
