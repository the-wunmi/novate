import { DomainError, type Principal, type PrincipalKind, readsAsStaff } from '@novate/core';
import * as engine from '@novate/engine';
import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono/types';
import { type Ctx, denied, type Env, json, operatorOf } from './context.ts';
import { bearer, clientIp, csrfRefusal, SESSION_COOKIE } from './session.ts';

/**
 * Every route declares who may call it with exactly one guard, given before its handler:
 * `app.get(path, staff, handler)`. A guard authenticates the caller and refuses anyone the route is
 * not for, so a handler only runs for the callers its guard names. `guards.test.ts` fails on a route
 * without one.
 */
export type Guard = MiddlewareHandler<Env>;

const GUARDS = new WeakSet<Guard>();

export const isGuard = (handler: unknown): boolean =>
  typeof handler === 'function' && GUARDS.has(handler as Guard);

function guard(check: (c: Ctx) => Promise<Response | undefined> | Response | undefined): Guard {
  const g: Guard = async (c, next) => {
    const refused = await check(c);
    if (refused) return refused;
    // Every `*Id` in a path is a uuid; anything else would reach Postgres as a type error.
    for (const [name, value] of Object.entries(c.req.param() as Record<string, string>)) {
      if (name.endsWith('Id') && !UUID.test(value)) throw new DomainError('not_found', 'Not found');
    }
    await next();
  };
  GUARDS.add(g);
  return g;
}

const MAX_REQUESTS_PER_MINUTE = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * Who is calling, from a key or a session cookie, and only inside that credential's tenant: a path
 * naming any other tenant is not found. House and platform people change things only with two-step
 * sign-in on, unless the tenant turned the requirement off; `ownAccount` is for their own account
 * routes, so they can turn it on. An auditor changes nothing but their own account.
 */
async function authenticate(c: Ctx, { ownAccount = false } = {}): Promise<Response | undefined> {
  const key = bearer(c.req.raw);
  let principal: Principal | null = null;
  if (key) {
    principal = await engine.principalForKey(key);
  } else {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await engine.sessionFor(token) : null;
    if (token && session) {
      if (!SAFE_METHODS.includes(c.req.method)) {
        const refusal = csrfRefusal(c);
        if (refusal) return refusal;
      }
      principal = session.principal;
      c.set('session', { token, user: session.user });
    }
  }
  if (!principal) {
    return json({ error: 'unauthenticated', message: 'Sign in, or send a valid key' }, 401);
  }
  if (!(await engine.withinRateLimit(principal.id, MAX_REQUESTS_PER_MINUTE))) {
    return json({ error: 'rate_limited', message: 'Too many requests' }, 429);
  }
  const tenantId = c.req.param('tenantId');
  if (tenantId !== undefined && tenantId !== principal.tenantId) {
    throw new DomainError('not_found', 'Tenant not found');
  }
  if (principal.kind === 'auditor' && !ownAccount && !SAFE_METHODS.includes(c.req.method)) {
    throw new DomainError('forbidden', 'An auditor reads; it changes nothing');
  }
  const session = c.get('session');
  if (
    !ownAccount &&
    session &&
    session.user.role !== 'member' &&
    !session.user.totpEnabledAt &&
    !SAFE_METHODS.includes(c.req.method) &&
    (await engine.readTenantSettings(principal.tenantId)).requireTwoStep
  ) {
    return json(
      { error: 'two_step_required', message: 'Turn on two-step sign-in before making changes' },
      403,
    );
  }
  // A signed-in person is named by their account. `X-Operator` only names who holds a key.
  const operator = session ? undefined : operatorOf(c);
  c.set('principal', operator ? { ...principal, operator } : principal);
  return undefined;
}

/** An auditor reads whatever the house may read; `authenticate` has already refused its writes. */
const auditorReads = (c: Ctx, kinds: PrincipalKind[]) =>
  c.get('principal').kind === 'auditor' && kinds.includes('house');

function allow(...kinds: PrincipalKind[]): Guard {
  return guard(async (c) => {
    const refused = await authenticate(c);
    if (refused) return refused;
    if (!kinds.includes(c.get('principal').kind) && !auditorReads(c, kinds)) throw denied();
    return undefined;
  });
}

/** No credential: health, the console's files, and webhooks, which are signed instead. */
export const open = guard(() => undefined);

export const operatorKey = (isOperator: (key: string) => Promise<boolean>) =>
  guard(async (c) => {
    const given = bearer(c.req.raw);
    if (!given || !(await isOperator(given))) throw denied();
    return undefined;
  });

/** Signing in from the console: its origin and header, and a cap per address per minute. */
export const signIn = (perMinute: number) =>
  guard(async (c) => {
    const refusal = csrfRefusal(c);
    if (refusal) return refusal;
    if (!(await engine.withinRateLimit(`auth-ip:${clientIp(c)}`, perMinute))) {
      return json({ error: 'rate_limited', message: 'Too many attempts. Wait a minute.' }, 429);
    }
    return undefined;
  });

/** From the console, with or without a session: signing out. */
export const fromConsole = guard((c) => csrfRefusal(c) ?? undefined);

/** Any credential. The engine decides what each caller may do with the deal, case or tool. */
export const anyCaller = guard((c) => authenticate(c));

/** A signed-in person's own account. Open without two-step sign-in, so they can turn it on. */
export const ownAccount = guard(async (c) => {
  const refused = await authenticate(c, { ownAccount: true });
  if (refused) return refused;
  if (!c.get('session')) throw new DomainError('person_required', 'Sign in as a person to do this');
  return undefined;
});

export const staff = allow('platform', 'house');
export const houseOnly = allow('house');
export const platformOnly = allow('platform');
/** A member acts for itself; the platform and the house for any member. */
export const memberOrStaff = allow('member', 'platform', 'house');

/** The platform, the house and an auditor for any member in the path. Anyone else only for their own. */
export const ownMember = guard(async (c) => {
  const refused = await authenticate(c);
  if (refused) return refused;
  const principal = c.get('principal');
  if (!readsAsStaff(principal) && principal.memberId !== c.req.param('memberId')) {
    throw denied();
  }
  return undefined;
});

/** A member's own people, seen by the member's users and staff: never by its agents' keys. */
export const ownMemberPeople = guard(async (c) => {
  const refused = await authenticate(c);
  if (refused) return refused;
  const principal = c.get('principal');
  const allowed =
    readsAsStaff(principal) ||
    (principal.kind === 'member' && principal.memberId === c.req.param('memberId'));
  if (!allowed) throw denied();
  return undefined;
});

/** A member's own money, moved by the member, the platform or the house: never by its agents. */
export const ownMemberMoney = guard(async (c) => {
  const refused = await authenticate(c);
  if (refused) return refused;
  const { kind, memberId } = c.get('principal');
  const allowed =
    kind === 'platform' ||
    kind === 'house' ||
    (kind === 'member' && memberId === c.req.param('memberId'));
  if (!allowed) throw denied();
  return undefined;
});
