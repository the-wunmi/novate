import { randomBytes } from 'node:crypto';
import { workerDatabases } from '@novate/db/test-databases';
import { authClock, base32Decode, inviteToken, totpAt, totpStep } from '@novate/engine';
import { expect } from 'vitest';
import type { createApp } from '../src/app.ts';

/** `app.request` resolves paths against http://localhost, so that is the console's own origin. */
export const CONSOLE = { origin: 'http://localhost', 'x-requested-with': 'novate' };
export const PASSWORD = 'a long enough password';

/** What the Node server gives every request: the address it came from. Sign-ins need it. */
export const PEER = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

export const cookieOf = (res: Response) =>
  res.headers.get('set-cookie')?.match(/novate_session=([^;]*)/)?.[1] ?? '';

/** This worker's databases, and accounts under a key of this process's own. */
export const testEngine = () => ({
  ...workerDatabases(),
  auth: { secretKey: randomBytes(32).toString('base64'), publicUrl: 'http://localhost:4000' },
});

let n = 0;
/** A new email address, with capitals, which novate stores in lower case. */
export const address = (who: string) => `${who}.${++n}.${Date.now()}@Example.com`;

export interface Send {
  method?: string;
  body?: unknown;
  key?: string;
  cookie?: string;
  headers?: Record<string, string>;
}

/**
 * Signed-in people for API tests: invited with the operator key (or whatever credential is given),
 * the invite accepted, and two-step sign-in turned on, unless asked not to, for house and platform
 * people, who need it before changing anything.
 */
export function people(app: ReturnType<typeof createApp>, admin: string) {
  /** A request as the console makes it (same origin, the novate header, the cookie), or a key's. */
  const send = (path: string, init: Send = {}) =>
    app.request(
      path,
      {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          'content-type': 'application/json',
          ...(init.key ? { authorization: `Bearer ${init.key}` } : CONSOLE),
          ...(init.cookie ? { cookie: `novate_session=${init.cookie}` } : {}),
          ...init.headers,
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      PEER,
    );

  /** Turn two-step sign-in on for a signed-in person, at the step of novate's clock. */
  async function twoStep(cookie: string) {
    const setup = await send('/auth/mfa/setup', { cookie, method: 'POST' });
    const { secret } = (await setup.json()) as { secret: string };
    const code = totpAt(base32Decode(secret), totpStep(authClock.now()));
    expect((await send('/auth/mfa/enable', { cookie, body: { code } })).status).toBe(200);
    return secret;
  }

  async function person(
    tenantId: string,
    role: 'house' | 'platform' | 'member' | 'auditor',
    opts: {
      name?: string;
      twoStep?: boolean;
      memberId?: string;
      /** Who invites: the operator key unless given. */
      as?: Pick<Send, 'key' | 'cookie'>;
    } = {},
  ) {
    const email = address(role);
    const as = opts.as ?? { key: admin };
    // The operator invites through its own route; anyone else through the tenant's.
    const invited = await send(
      as.key === admin ? `/operator/tenants/${tenantId}/users` : `/tenants/${tenantId}/users`,
      {
        ...as,
        body: { email, name: opts.name ?? `A ${role}`, role, memberId: opts.memberId },
      },
    );
    expect(invited.status).toBe(201);
    const { user, inviteUrl } = (await invited.json()) as {
      user: { id: string; email: string; status: string };
      inviteUrl: string;
    };
    expect(user).toMatchObject({ status: 'invited', email: email.toLowerCase() });
    const token = inviteToken(inviteUrl);
    const accepted = await send('/auth/invites/accept', { body: { token, password: PASSWORD } });
    expect(accepted.status).toBe(200);
    const cookie = cookieOf(accepted);
    if (opts.twoStep ?? role !== 'member') await twoStep(cookie);
    return { id: user.id, email: user.email, cookie, token };
  }

  return { send, person, twoStep };
}
