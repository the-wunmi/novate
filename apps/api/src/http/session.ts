import { DomainError } from '@novate/core';
import * as engine from '@novate/engine';
import { serialize } from 'hono/utils/cookie';
import { type Ctx, json } from './context.ts';

export const SESSION_COOKIE = 'novate_session';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function secureCookies(c: Ctx): boolean {
  if (['test', 'development'].includes(process.env.NODE_ENV ?? '')) return false;
  const url = new URL(c.req.url);
  return !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

/** A null token clears the cookie. */
export function withSession<R extends Response>(c: Ctx, res: R, token: string | null): R {
  res.headers.append(
    'set-cookie',
    serialize(SESSION_COOKIE, token ?? '', {
      httpOnly: true,
      secure: secureCookies(c),
      sameSite: 'Strict',
      path: '/',
      maxAge: token ? engine.SESSION_TTL_MS / 1000 : 0,
    }),
  );
  return res;
}

/** Origins the console may be served from: this server, its public URL, and any listed. */
function allowedOrigins(c: Ctx): Set<string> {
  const origins = new Set([new URL(c.req.url).origin]);
  for (const url of [
    process.env.NOVATE_PUBLIC_URL,
    ...(process.env.NOVATE_ALLOWED_ORIGINS ?? '').split(','),
  ]) {
    const trimmed = url?.trim();
    if (trimmed) origins.add(new URL(trimmed).origin);
  }
  return origins;
}

/**
 * Cookies go with every request a browser makes, so a change made with one must prove it came
 * from the console: its own origin, and a header no cross-site form can send.
 */
export function csrfRefusal(c: Ctx): Response | null {
  const origin = c.req.header('origin');
  if (c.req.header('x-requested-with') === 'novate' && origin && allowedOrigins(c).has(origin)) {
    return null;
  }
  return json({ error: 'csrf', message: 'This request did not come from the console' }, 403);
}

/**
 * The caller's address. Behind proxies, `NOVATE_TRUST_PROXY_HOPS` says how many append to
 * X-Forwarded-For: the caller is that many entries from the right, because anything further left
 * is whatever the caller chose to send.
 */
export function clientIp(c: Ctx): string {
  const hops = Number(process.env.NOVATE_TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error('NOVATE_TRUST_PROXY_HOPS must be a whole number');
  }
  if (hops > 0) {
    const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',').map((s) => s.trim());
    const ip = forwarded[forwarded.length - hops];
    if (!ip) throw new Error(`X-Forwarded-For has fewer than ${hops} entries`);
    return ip;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  const ip = incoming?.socket?.remoteAddress;
  if (!ip) throw new Error('The request has no socket address');
  return ip;
}

export const sessionMeta = (c: Ctx): engine.SessionMeta => ({
  ip: clientIp(c),
  userAgent: c.req.header('user-agent'),
});

/** The signed-in person's session. Keys cannot use the routes that need one. */
export function sessionOf(c: Ctx) {
  const session = c.get('session');
  if (!session) throw new DomainError('person_required', 'Sign in as a person to do this');
  return session;
}

export const bearer = (req: Request) =>
  req.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
