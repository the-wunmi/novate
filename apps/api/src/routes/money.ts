import { DomainError, parseInput } from '@novate/core';
import * as engine from '@novate/engine';
import { z } from 'zod';
import { type App, denied, input, json, memberIdOf, tenantOf } from '../http/context.ts';
import {
  houseOnly,
  memberOrStaff,
  open,
  ownMember,
  ownMemberMoney,
  staff,
} from '../http/guards.ts';

/** Money in and out: rails, deposits, settlement cycles, payouts, withdrawals and the default fund. */
export function moneyRoutes(app: App) {
  // Webhooks authenticate by signature instead of a key. Unsigned rails get no endpoint.
  app.post('/rails/:rail/webhooks', open, async (c) => {
    const rail = c.req.param('rail');
    if (!engine.railAcceptsWebhooks(rail)) throw new DomainError('not_found', 'No such rail');
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    return json(await engine.ingestRailEvent(rail, await c.req.text(), headers));
  });
  app.get('/tenants/:tenantId/rails', staff, (c) => json(engine.tenantRails(tenantOf(c))));
  // A rail account's full history is only for the house of the tenant that owns that account.
  app.post('/tenants/:tenantId/reconciliation', houseOnly, async (c) => {
    const { rail } = parseInput(z.object({ rail: z.string() }), await input(c));
    return json(await engine.runReconciliation(tenantOf(c), rail));
  });
  // Recording an opening again hides differences, so it is held for a second person (/approvals).
  app.post('/tenants/:tenantId/rails/:rail/opening', houseOnly, async (c) =>
    json(
      await engine.requestRailOpening(
        tenantOf(c),
        c.get('principal'),
        c.req.param('rail'),
        await input(c),
      ),
      202,
    ),
  );

  // Money a rail delivered that novate never heard of. A signed-in house person only; above the
  // four-eyes threshold it waits for a second person.
  app.post('/tenants/:tenantId/deposits', houseOnly, async (c) => {
    const out = await engine.creditDeposit(tenantOf(c), c.get('principal'), await input(c));
    return json({ ok: true, ...out }, 202);
  });
  app.get('/tenants/:tenantId/deposits/unattributed', houseOnly, async (c) =>
    json(await engine.unattributedDepositsOf(tenantOf(c))),
  );
  app.post('/tenants/:tenantId/deposits/:depositId/assign', houseOnly, async (c) => {
    await engine.assignDeposit(
      tenantOf(c),
      c.get('principal'),
      c.req.param('depositId'),
      await input(c),
    );
    return json({ ok: true });
  });

  app.get('/tenants/:tenantId/default-fund', staff, async (c) =>
    json(await engine.defaultFund(tenantOf(c))),
  );
  app.post('/tenants/:tenantId/default-fund/contributions', houseOnly, async (c) => {
    await engine.contributeToDefaultFund(tenantOf(c), c.get('principal'), await input(c));
    return json({ ok: true }, 201);
  });
  app.post('/tenants/:tenantId/default-fund/withdrawals', houseOnly, async (c) => {
    await engine.withdrawFromDefaultFund(tenantOf(c), c.get('principal'), await input(c));
    return json({ ok: true }, 201);
  });
  app.get('/tenants/:tenantId/margin-calls', staff, async (c) =>
    json(await engine.openMarginCalls(tenantOf(c))),
  );

  // Settlement
  app.get('/tenants/:tenantId/settlement/preview', staff, async (c) =>
    json(await engine.settlementPreview(tenantOf(c))),
  );
  app.post('/tenants/:tenantId/settlement/stop', staff, async (c) => {
    await engine.stopSettlement(tenantOf(c), c.get('principal'), await input(c));
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/settlement/resume', houseOnly, async (c) => {
    await engine.resumeSettlement(tenantOf(c), c.get('principal'), await input(c));
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/cycles', staff, async (c) =>
    json({ cycleIds: await engine.startCycles(tenantOf(c)) }, 202),
  );
  // The latest settlement cycles that had something to settle, with what was owed and what moved.
  app.get('/tenants/:tenantId/cycles', staff, async (c) =>
    json(await engine.recentCycles(tenantOf(c))),
  );
  // Cycles started in `from`..`to`: counts by status and netting per currency.
  app.get('/tenants/:tenantId/settlement-summary', staff, async (c) =>
    json(await engine.settlementSummary(tenantOf(c), c.req.query())),
  );
  app.get('/cycles/:cycleId', memberOrStaff, async (c) => {
    const { kind, memberId } = c.get('principal');
    if (kind !== 'member')
      return json(await engine.cycleDetail(tenantOf(c), c.req.param('cycleId')));
    if (!memberId) throw denied();
    return json(await engine.memberCycle(tenantOf(c), memberId, c.req.param('cycleId')));
  });

  // Payouts needing someone, across every cycle: `status`, `before` and `limit` (at most 200).
  app.get('/tenants/:tenantId/payouts', staff, async (c) =>
    json(await engine.problemPayouts(tenantOf(c), c.req.query())),
  );
  app.post('/tenants/:tenantId/payouts/:instructionId/refresh', houseOnly, async (c) =>
    json(
      await engine.refreshPayout(
        tenantOf(c),
        c.get('principal'),
        c.req.param('instructionId'),
        await input(c),
      ),
    ),
  );

  // Withdrawals. Newest first, as `{ rows, next }`: pass `next` back as `before`, `limit` at most 200.
  app.get('/tenants/:tenantId/withdrawals', staff, async (c) =>
    json(await engine.tenantWithdrawals(tenantOf(c), c.req.query())),
  );
  app.post('/tenants/:tenantId/members/:memberId/withdrawals', ownMemberMoney, async (c) =>
    json(
      await engine.requestWithdrawal(
        tenantOf(c),
        c.get('principal'),
        c.req.param('memberId'),
        await input(c),
      ),
      202,
    ),
  );
  app.get('/tenants/:tenantId/members/:memberId/withdrawals', ownMember, async (c) => {
    return json(await engine.memberWithdrawals(tenantOf(c), memberIdOf(c), c.req.query()));
  });
  app.get('/tenants/:tenantId/members/:memberId/withdrawals/:id', ownMember, async (c) => {
    const { memberId, id } = c.req.param();
    return json(await engine.withdrawalDetail(tenantOf(c), memberId, id));
  });
}
