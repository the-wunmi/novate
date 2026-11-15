import { DomainError } from '@novate/core';
import * as engine from '@novate/engine';
import { AirwallexError, MetalRefusal } from '@novate/rails';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { consoleFile } from './console.ts';
import { type Env, json } from './http/context.ts';
import { open, operatorKey, signIn } from './http/guards.ts';
import { auditRoutes } from './routes/audit.ts';
import { dealRoutes } from './routes/deals.ts';
import { moneyRoutes } from './routes/money.ts';
import { peopleRoutes } from './routes/people.ts';
import { tenantRoutes } from './routes/tenant.ts';
import type { X402Gateway } from './x402.ts';

const STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  malformed: 400,
  insufficient_funds: 402,
  settlement_held: 409,
  rail_held: 409,
  debt_outstanding: 402,
  no_payout_account: 422,
  unauthorised_agent: 403,
  forbidden: 403,
  person_required: 403,
  invalid_credentials: 401,
  mfa_required: 401,
  policy_error: 422,
  too_large: 413,
  rail_refused: 422,
};

/** Bodies above this are refused. Base64 documents are the largest thing the API takes. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** Webhooks are read before their signature is checked, so they get a tight limit. */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** Sign-in attempts and invite acceptances per address per minute. */
const AUTH_PER_MINUTE = 20;

const tooLarge = () => json({ error: 'too_large', message: 'Body too large' }, 413);

export interface AppOptions {
  x402?: X402Gateway;
  /** Replaced in tests, so that no known key is ever written to a database a server might use. */
  isOperator?: (key: string) => Promise<boolean>;
  /** Sign-in attempts and invite acceptances per address per minute. */
  authPerMinute?: number;
}

/** Every route names its guard where it is registered; see `http/guards.ts`. */
export function createApp(options: AppOptions = {}) {
  const app = new Hono<Env>();

  app.onError((err) => {
    if (err instanceof DomainError) {
      return json(
        { error: err.code, message: err.message, details: err.details },
        STATUS[err.code],
      );
    }
    // A rail error nothing classified: its words are safe to pass on, its details are not.
    if (err instanceof AirwallexError || err instanceof MetalRefusal) {
      console.error(err);
      return json({ error: 'rail_error', message: err.message }, 502);
    }
    console.error(err);
    return json({ error: 'internal', message: 'Internal error' }, 500);
  });

  app.notFound(() => json({ error: 'not_found', message: 'Not found' }, 404));

  app.use('*', secureHeaders());
  app.use('/rails/*', bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: tooLarge }));
  app.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: tooLarge }));

  app.get('/health', open, () => json({ ok: true }));
  // Unlike /health, this fails when the database is out of reach, so traffic can be moved away.
  app.get('/ready', open, async () => {
    await engine.checkDatabase();
    return json({ ok: true });
  });
  app.get('/console', open, () => consoleFile('') as Response);
  app.get('/console/*', open, (c) => {
    const file = consoleFile(c.req.path.slice('/console/'.length));
    if (!file) throw new DomainError('not_found', 'Not found');
    return file;
  });

  const operator = operatorKey(options.isOperator ?? engine.isOperatorKey);
  peopleRoutes(app, { operator, signIn: signIn(options.authPerMinute ?? AUTH_PER_MINUTE) });
  tenantRoutes(app, { operator });
  dealRoutes(app, options.x402);
  moneyRoutes(app);
  auditRoutes(app);

  return app;
}
