import * as engine from '@novate/engine';
import { getCookie } from 'hono/cookie';
import { type App, input, json, operatorOf, tenantOf } from '../http/context.ts';
import { anyCaller, fromConsole, type Guard, ownAccount, staff } from '../http/guards.ts';
import { SESSION_COOKIE, sessionMeta, sessionOf, withSession } from '../http/session.ts';

/** Signing in and out, a person's own account, and the people of a tenant. */
export function peopleRoutes(app: App, guards: { operator: Guard; signIn: Guard }) {
  // People get a session cookie; machines use keys.
  app.post('/auth/login', guards.signIn, async (c) => {
    const { user, token, mfaRequired } = await engine.login(sessionMeta(c), await input(c));
    return withSession(c, json({ user, ...(mfaRequired ? { mfaRequired } : {}) }), token);
  });
  app.post('/auth/logout', fromConsole, async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await engine.logout(token);
    return withSession(c, json({ ok: true }), null);
  });
  app.post('/auth/invites/accept', guards.signIn, async (c) => {
    const { user, token } = await engine.acceptInvite(sessionMeta(c), await input(c));
    return withSession(c, json({ user }), token);
  });

  app.get('/me', anyCaller, async (c) =>
    json(await engine.whoAmI(c.get('session')?.user, c.get('principal'))),
  );
  app.post('/auth/mfa/setup', ownAccount, async (c) =>
    json(await engine.startMfaSetup(c.get('principal'))),
  );
  app.post('/auth/mfa/enable', ownAccount, async (c) =>
    json(await engine.enableMfa(c.get('principal'), await input(c))),
  );
  app.post('/auth/mfa/disable', ownAccount, async (c) =>
    json(await engine.disableMfa(c.get('principal'), await input(c))),
  );
  app.post('/auth/password', ownAccount, async (c) => {
    const { token } = sessionOf(c);
    return json(await engine.changePassword(c.get('principal'), token, await input(c)));
  });

  // The operator key makes a tenant's first house user. Anyone else uses the tenant's own route.
  app.post('/operator/tenants/:tenantId/users', guards.operator, async (c) => {
    const manager = { kind: 'operator' as const, operator: operatorOf(c) };
    return json(await engine.inviteUser(c.req.param('tenantId'), manager, await input(c)), 201);
  });

  // The house manages anyone; the platform manages platform and member users.
  app.get('/tenants/:tenantId/users', staff, async (c) =>
    json(await engine.listUsers(tenantOf(c), c.req.query())),
  );
  app.post('/tenants/:tenantId/users', staff, async (c) =>
    json(await engine.inviteUser(tenantOf(c), c.get('principal'), await input(c)), 201),
  );
  app.post('/tenants/:tenantId/users/:userId/disable', staff, async (c) =>
    json(
      await engine.setUserStatus(
        tenantOf(c),
        c.get('principal'),
        c.req.param('userId'),
        'disabled',
        await input(c),
      ),
    ),
  );
  app.post('/tenants/:tenantId/users/:userId/enable', staff, async (c) =>
    json(
      await engine.setUserStatus(
        tenantOf(c),
        c.get('principal'),
        c.req.param('userId'),
        'enabled',
        await input(c),
      ),
    ),
  );
  // A new link, only for someone who never accepted their first.
  app.post('/tenants/:tenantId/users/:userId/invite', staff, async (c) =>
    json(await engine.reissueInvite(tenantOf(c), c.get('principal'), c.req.param('userId')), 201),
  );
  // The way back in for someone who has signed in before: sessions end, password and two-step
  // are cleared, and they are invited again. Needs a reason.
  app.post('/tenants/:tenantId/users/:userId/reset', staff, async (c) =>
    json(
      await engine.resetUser(
        tenantOf(c),
        c.get('principal'),
        c.req.param('userId'),
        await input(c),
      ),
      201,
    ),
  );
  app.get('/tenants/:tenantId/users/:userId/sessions', staff, async (c) =>
    json(await engine.userSessions(tenantOf(c), c.get('principal'), c.req.param('userId'))),
  );
}
