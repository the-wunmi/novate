import { parseInput } from '@novate/core';
import * as engine from '@novate/engine';
import { z } from 'zod';
import { type App, csv, denied, input, json, tenantOf } from '../http/context.ts';
import { houseOnly, memberOrStaff, staff } from '../http/guards.ts';

/** What auditors read: event and decision populations, exports, reconciliation and sign-off. */
export function auditRoutes(app: App) {
  app.get('/tenants/:tenantId/events', staff, async (c) => {
    const after = parseInput(z.coerce.bigint().min(0n), c.req.query('after') ?? '0');
    return json(await engine.dealEventFeed(tenantOf(c), after));
  });

  // Populations, as `{ rows, next }`: `from` and `to` (ISO times), `before` (the previous page's
  // `next`) and `limit` (at most 500).
  app.get('/tenants/:tenantId/decisions', staff, async (c) =>
    json(await engine.decisionFeed(tenantOf(c), c.req.query())),
  );
  // Cases closed in `from`..`to`, counted by who decided them.
  app.get('/tenants/:tenantId/decision-summary', staff, async (c) =>
    json(await engine.decisionSummary(tenantOf(c), c.req.query())),
  );
  app.get('/tenants/:tenantId/activity', staff, async (c) =>
    json(await engine.activityFeed(tenantOf(c), c.req.query())),
  );
  // `type` may repeat: ?type=books_signed_off&type=settlement_resumed
  app.get('/tenants/:tenantId/control-events', staff, async (c) =>
    json(
      await engine.controlEventFeed(tenantOf(c), {
        ...c.req.query(),
        type: c.req.queries('type'),
      }),
    ),
  );
  app.get('/tenants/:tenantId/reconciliation', staff, async (c) =>
    json(await engine.reconHistory(tenantOf(c), c.req.query())),
  );

  app.get('/tenants/:tenantId/decisions.csv', staff, async (c) =>
    csv(await engine.decisionsCsv(tenantOf(c), c.req.query()), 'decisions'),
  );
  app.get('/tenants/:tenantId/decision-records.csv', staff, async (c) =>
    csv(await engine.decisionRecordsCsv(tenantOf(c), c.req.query()), 'decision-records'),
  );
  app.get('/tenants/:tenantId/ledger.csv', staff, async (c) =>
    csv(await engine.ledgerCsv(tenantOf(c), c.req.query()), 'ledger'),
  );
  app.get('/tenants/:tenantId/payouts.csv', staff, async (c) =>
    csv(await engine.payoutsCsv(tenantOf(c), c.req.query()), 'payouts'),
  );
  // A member exports only the deals it is a party to.
  app.get('/tenants/:tenantId/deals.csv', memberOrStaff, async (c) => {
    const { kind, memberId } = c.get('principal');
    if (kind === 'member' && !memberId) throw denied();
    const scope = kind === 'member' ? (memberId as string) : null;
    return csv(await engine.dealsCsv(tenantOf(c), scope, c.req.query()), 'deals');
  });
  app.get('/tenants/:tenantId/activity.csv', staff, async (c) =>
    csv(await engine.activityCsv(tenantOf(c), c.req.query()), 'activity'),
  );
  app.get('/tenants/:tenantId/control-events.csv', staff, async (c) =>
    csv(await engine.controlEventsCsv(tenantOf(c), c.req.query()), 'control-events'),
  );
  app.get('/tenants/:tenantId/reconciliation.csv', staff, async (c) =>
    csv(await engine.reconciliationCsv(tenantOf(c), c.req.query()), 'reconciliation'),
  );
  // What each check compared, per run and currency, clean runs included.
  app.get('/tenants/:tenantId/reconciliation-positions.csv', staff, async (c) =>
    csv(await engine.reconPositionsCsv(tenantOf(c), c.req.query()), 'reconciliation-positions'),
  );
  // Access review: everyone and every key as things stand now, not a range.
  app.get('/tenants/:tenantId/users.csv', staff, async (c) =>
    csv(await engine.usersCsv(tenantOf(c)), 'users'),
  );
  app.get('/tenants/:tenantId/keys.csv', staff, async (c) =>
    csv(await engine.keysCsv(tenantOf(c)), 'keys'),
  );
  app.get('/tenants/:tenantId/economics.csv', staff, async (c) =>
    csv(await engine.economicsCsv(tenantOf(c), c.req.query()), 'economics'),
  );

  // Decisions: the full trail, the track record that earns autonomy, and replays
  app.get('/tenants/:tenantId/decisions/:caseId', staff, async (c) =>
    json(await engine.decisionTrail(tenantOf(c), c.req.param('caseId'))),
  );
  // Nothing is applied: it shows what the same gate would say under different limits.
  app.post('/tenants/:tenantId/decisions/:caseId/recheck', staff, async (c) =>
    json(await engine.recheckDecision(tenantOf(c), c.req.param('caseId'), await input(c))),
  );
  app.get('/tenants/:tenantId/track-record', staff, async (c) =>
    json(await engine.trackRecords(tenantOf(c))),
  );
  app.post('/tenants/:tenantId/shadow-runs', staff, async (c) =>
    json(await engine.startShadowRun(tenantOf(c), await input(c)), 202),
  );
  app.get('/tenants/:tenantId/shadow-runs/:runId', staff, async (c) =>
    json(await engine.shadowRunDetail(tenantOf(c), c.req.param('runId'))),
  );

  app.get('/tenants/:tenantId/exposure', staff, async (c) =>
    json(await engine.exposure(tenantOf(c))),
  );
  app.get('/tenants/:tenantId/economics', staff, async (c) =>
    json(await engine.economics(tenantOf(c), c.req.query())),
  );

  // Reconciliation differences and the day's sign-off
  // Each owned rail as it stands: its latest check, its opening and what of its money is the house's own.
  app.get('/tenants/:tenantId/reconciliation/rails', staff, async (c) =>
    json(await engine.railBooks(tenantOf(c))),
  );
  app.get('/tenants/:tenantId/reconciliation/breaks', staff, async (c) =>
    json(await engine.openBreaks(tenantOf(c))),
  );
  app.post('/tenants/:tenantId/reconciliation/breaks/:breakId/assign', staff, async (c) =>
    json(
      await engine.setBreakAssignee(tenantOf(c), c.get('principal'), c.req.param('breakId'), true),
    ),
  );
  app.post('/tenants/:tenantId/reconciliation/breaks/:breakId/unassign', staff, async (c) =>
    json(
      await engine.setBreakAssignee(tenantOf(c), c.get('principal'), c.req.param('breakId'), false),
    ),
  );
  app.post('/tenants/:tenantId/reconciliation/breaks/:breakId/resolve', houseOnly, async (c) =>
    json(
      await engine.resolveBreak(
        tenantOf(c),
        c.get('principal'),
        c.req.param('breakId'),
        await input(c),
      ),
    ),
  );
  // The note is optional, so an empty body is a sign-off without one.
  app.post('/tenants/:tenantId/books/sign-off', houseOnly, async (c) =>
    json(await engine.signOffBooks(tenantOf(c), c.get('principal'), await input(c)), 201),
  );
}
