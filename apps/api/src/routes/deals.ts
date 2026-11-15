import { DomainError } from '@novate/core';
import * as engine from '@novate/engine';
import { type App, denied, input, json, tenantOf } from '../http/context.ts';
import { anyCaller, memberOrStaff, staff } from '../http/guards.ts';
import { handleMcp } from '../mcp.ts';
import { fundDealOverX402, type X402Gateway } from '../x402.ts';

/** Deals, their evidence and funding, the cases they raise, and the MCP surface for agents. */
export function dealRoutes(app: App, x402: X402Gateway | undefined) {
  app.post('/tenants/:tenantId/deals', anyCaller, async (c) =>
    json(await engine.submitDeal(c.get('principal'), await input(c)), 202),
  );
  app.get('/tenants/:tenantId/deals', memberOrStaff, async (c) => {
    const { kind, memberId } = c.get('principal');
    if (kind !== 'member') return json(await engine.listDeals(tenantOf(c), c.req.query()));
    if (c.req.query('memberId') && c.req.query('memberId') !== memberId) throw denied();
    return json(await engine.listDeals(tenantOf(c), { ...c.req.query(), memberId }));
  });
  app.get('/deals/:dealId', anyCaller, async (c) =>
    json(await engine.dealDetail(c.req.param('dealId'), c.get('principal'))),
  );
  app.post('/deals/:dealId/facts', anyCaller, async (c) =>
    json(await engine.submitFact(c.req.param('dealId'), c.get('principal'), await input(c)), 201),
  );
  app.post('/deals/:dealId/documents', anyCaller, async (c) =>
    json(
      await engine.submitDocument(c.req.param('dealId'), c.get('principal'), await input(c)),
      201,
    ),
  );

  app.post('/deals/:dealId/x402', anyCaller, async (c) => {
    if (!x402) throw new DomainError('not_found', 'x402 is not enabled');
    const offer = await engine.x402Offer(c.req.param('dealId'), c.get('principal'));
    return fundDealOverX402(engine, x402, c.req.raw, offer);
  });
  // Airi needs the merchant and exact amount before it will issue a credential.
  app.get('/deals/:dealId/card', anyCaller, async (c) =>
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
  app.post('/deals/:dealId/card', anyCaller, async (c) => {
    const paid = await engine.payDealByCard(
      c.req.param('dealId'),
      c.get('principal'),
      await input(c),
    );
    return json(paid, paid.status === 'failed' ? 402 : paid.status === 'pending' ? 202 : 200);
  });

  app.post('/mcp', anyCaller, (c) => handleMcp(c.get('principal'), c.req.raw));
  // Stateless, so there is no session to stream to or to end.
  app.on(['GET', 'DELETE'], '/mcp', anyCaller, (c) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
      405,
      { allow: 'POST' },
    ),
  );

  // Cases. A party's decision is checked by the engine against its own interest.
  app.get('/tenants/:tenantId/cases', staff, async (c) =>
    json(await engine.openCases(tenantOf(c))),
  );
  app.get('/cases/:caseId/records', staff, async (c) =>
    json(await engine.caseRecords(tenantOf(c), c.req.param('caseId'))),
  );
  app.post('/cases/:caseId/assign', staff, async (c) =>
    json(
      await engine.setCaseAssignee(tenantOf(c), c.get('principal'), c.req.param('caseId'), true),
    ),
  );
  app.post('/cases/:caseId/unassign', staff, async (c) =>
    json(
      await engine.setCaseAssignee(tenantOf(c), c.get('principal'), c.req.param('caseId'), false),
    ),
  );
  app.post('/cases/:caseId/decision', anyCaller, async (c) => {
    const out = await engine.decideCase(c.req.param('caseId'), c.get('principal'), await input(c));
    return json({ ok: true, ...out }, 202);
  });
}
