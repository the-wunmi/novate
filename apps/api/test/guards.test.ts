import { AirwallexError } from '@novate/rails';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { type Env, input, json } from '../src/http/context.ts';
import { isGuard, open } from '../src/http/guards.ts';
import { clientIp } from '../src/http/session.ts';

const app = createApp({ isOperator: async () => false });

/** Each method and path, with its handlers in the order they run. Middleware is registered as ALL. */
function routes() {
  const byRoute = new Map<string, unknown[]>();
  for (const r of app.routes) {
    if (r.method === 'ALL') continue;
    const key = `${r.method} ${r.path}`;
    byRoute.set(key, [...(byRoute.get(key) ?? []), r.handler]);
  }
  return byRoute;
}

describe('route guards', () => {
  it('give every route exactly one guard, ahead of its handler', () => {
    const unguarded: string[] = [];
    for (const [route, handlers] of routes()) {
      const guards = handlers.filter(isGuard);
      if (guards.length !== 1 || !isGuard(handlers[0]) || handlers.length !== 2) {
        unguarded.push(route);
      }
    }
    expect(routes().size).toBeGreaterThan(100);
    expect(unguarded).toEqual([]);
  });

  it('leave only health, the console and signed webhooks open', () => {
    const opened = [...routes()].filter(([, h]) => h[0] === open).map(([route]) => route);
    expect(opened.sort()).toEqual([
      'GET /console',
      'GET /console/*',
      'GET /health',
      'GET /ready',
      'POST /rails/:rail/webhooks',
    ]);
  });

  it('refuses no credential before it looks at the route', async () => {
    expect((await app.request('/tenants/x/members')).status).toBe(401);
    expect((await app.request('/no/such/route')).status).toBe(404);
  });
});

describe('the caller’s address', () => {
  const probe = new Hono<Env>().get('/', (c) => c.text(clientIp(c)));
  const peer = (ip?: string) => ({ incoming: { socket: { remoteAddress: ip } } });
  afterEach(() => {
    delete process.env.NOVATE_TRUST_PROXY_HOPS;
  });

  it('is the socket’s, and never guessed when there is none', async () => {
    expect(await (await probe.request('/', {}, peer('198.51.100.7'))).text()).toBe('198.51.100.7');
    expect((await probe.request('/', {}, peer())).status).toBe(500);
  });

  it('behind proxies, is the entry the outermost trusted proxy added, not one the caller sent', async () => {
    process.env.NOVATE_TRUST_PROXY_HOPS = '2';
    const via = (xff: string) =>
      probe.request('/', { headers: { 'x-forwarded-for': xff } }, peer('10.0.0.2'));
    // The caller forged the first entry; the edge proxy added the caller, the inner one the edge.
    expect(await (await via('6.6.6.6, 203.0.113.5, 10.0.0.1')).text()).toBe('203.0.113.5');
    expect((await via('10.0.0.1')).status).toBe(500);
  });
});

describe('failures', () => {
  const failing = createApp({ isOperator: async () => false });
  failing.post('/probe/echo', open, async (c) => json({ got: (await input(c)) ?? null }));
  failing.get('/probe/deals/:dealId', open, () => json({ ok: true }));
  failing.get('/probe/rail', open, () => {
    throw new AirwallexError(400, 'invalid_argument', 'Amount must be positive', { secret: 'x' });
  });
  failing.get('/probe/crash', open, () => {
    throw new Error('relation "secret_table" does not exist at postgres://owner:pw@db');
  });
  const answer = async (res: Response) => ({ status: res.status, body: await res.json() });

  it('answers a body that is not JSON with 400, and no body as none', async () => {
    const post = (body?: string) => failing.request('/probe/echo', { method: 'POST', body });
    expect(await answer(await post('{"amount": '))).toEqual({
      status: 400,
      body: { error: 'malformed', message: 'The body is not valid JSON' },
    });
    expect(await answer(await post())).toEqual({ status: 200, body: { got: null } });
    expect(await answer(await post('{"a":1}'))).toEqual({ status: 200, body: { got: { a: 1 } } });
  });

  it('answers an id that is not a uuid as not found, before any handler runs', async () => {
    expect((await failing.request('/probe/deals/abc')).status).toBe(404);
    const id = '6f1c2b0e-8d4a-4c1e-9f7b-2a3d4e5f6a7b';
    expect((await failing.request(`/probe/deals/${id}`)).status).toBe(200);
  });

  it('passes on what the rail said, without its details', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await answer(await failing.request('/probe/rail'))).toEqual({
      status: 502,
      body: {
        error: 'rail_error',
        message: 'Airwallex 400 invalid_argument: Amount must be positive',
      },
    });
    quiet.mockRestore();
  });

  it('logs anything unexpected and answers it without saying what it was', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await answer(await failing.request('/probe/crash'))).toEqual({
      status: 500,
      body: { error: 'internal', message: 'Internal error' },
    });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
