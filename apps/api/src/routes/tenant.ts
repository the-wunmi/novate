import * as engine from '@novate/engine';
import { presets } from '@novate/policy';
import {
  type App,
  csv,
  denied,
  input,
  json,
  memberIdOf,
  operatorOf,
  tenantOf,
} from '../http/context.ts';
import {
  anyCaller,
  type Guard,
  houseOnly,
  memberOrStaff,
  ownMember,
  ownMemberPeople,
  platformOnly,
  staff,
} from '../http/guards.ts';

/** Tenants and their keys, members, agents, programs, settings and approvals. */
export function tenantRoutes(app: App, guards: { operator: Guard }) {
  // Only the operator's key creates a tenant or issues a house or platform key.
  app.post('/operator/tenants', guards.operator, async (c) =>
    json(await engine.createTenant(await input(c)), 201),
  );
  app.post('/operator/tenants/:tenantId/house-key', guards.operator, async (c) =>
    json(await engine.createHouseKey(c.req.param('tenantId'), operatorOf(c)), 201),
  );
  app.post('/operator/tenants/:tenantId/platform-key', guards.operator, async (c) =>
    json(await engine.createPlatformKey(c.req.param('tenantId'), operatorOf(c)), 201),
  );

  app.get('/presets', anyCaller, () => json(presets));
  app.get('/tenants/:tenantId', staff, async (c) => json(await engine.tenantStatus(tenantOf(c))));
  // The house's own controls: two-step sign-in, four-eyes thresholds, the business day's zone.
  app.patch('/tenants/:tenantId/settings', houseOnly, async (c) =>
    json(await engine.updateTenantSettings(tenantOf(c), c.get('principal'), await input(c))),
  );

  // Members
  app.post('/tenants/:tenantId/members', platformOnly, async (c) =>
    json(await engine.createMember(tenantOf(c), c.get('principal'), await input(c)), 201),
  );
  app.get('/tenants/:tenantId/members', staff, async (c) =>
    json(await engine.listMembers(tenantOf(c))),
  );
  app.patch('/tenants/:tenantId/members/:memberId', platformOnly, async (c) =>
    json(
      await engine.updateMember(
        tenantOf(c),
        c.get('principal'),
        c.req.param('memberId'),
        await input(c),
      ),
    ),
  );
  // The platform asks; only the house can open accounts, so it sees the asks still waiting.
  app.post('/tenants/:tenantId/members/:memberId/provision-request', platformOnly, async (c) =>
    json(
      await engine.requestProvision(
        tenantOf(c),
        c.get('principal'),
        c.req.param('memberId'),
        await input(c),
      ),
      201,
    ),
  );
  app.get('/tenants/:tenantId/provision-requests', staff, async (c) =>
    json(await engine.provisionRequests(tenantOf(c))),
  );
  // Where a member is paid: a signed-in house person asks, and a second one approves.
  app.put('/tenants/:tenantId/members/:memberId/rail-refs', houseOnly, async (c) => {
    const out = await engine.setMemberRailRefs(
      tenantOf(c),
      c.get('principal'),
      c.req.param('memberId'),
      await input(c),
    );
    return json(out, out.status === 'pending_approval' ? 202 : 200);
  });
  // A new payee is created on the rail, and switching to it waits for a second house person.
  app.post('/tenants/:tenantId/members/:memberId/payee', houseOnly, async (c) => {
    const out = await engine.changePayee(
      tenantOf(c),
      c.get('principal'),
      c.req.param('memberId'),
      await input(c),
    );
    return json(out, out.status === 'pending_approval' ? 202 : 200);
  });
  app.post('/tenants/:tenantId/members/:memberId/provision', houseOnly, async (c) => {
    await engine.provisionMember(
      tenantOf(c),
      c.get('principal'),
      c.req.param('memberId'),
      await input(c),
    );
    return json({ ok: true }, 201);
  });
  app.post('/tenants/:tenantId/members/:memberId/suspend', staff, async (c) => {
    await engine.suspendMember(
      tenantOf(c),
      c.get('principal'),
      c.req.param('memberId'),
      await input(c),
    );
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/members/:memberId/reinstate', houseOnly, async (c) => {
    await engine.reinstateMember(
      tenantOf(c),
      c.get('principal'),
      c.req.param('memberId'),
      await input(c),
    );
    return json({ ok: true });
  });

  // What a member sees of itself, and the platform and the house of any member
  app.get('/tenants/:tenantId/members/:memberId/margin', ownMember, async (c) =>
    json(await engine.memberMargin(tenantOf(c), c.req.param('memberId'))),
  );
  app.get('/tenants/:tenantId/members/:memberId/balances', ownMember, async (c) =>
    json(await engine.balances(tenantOf(c), c.req.param('memberId'))),
  );
  app.get('/tenants/:tenantId/members/:memberId/account', ownMember, async (c) =>
    json(await engine.memberAccount(tenantOf(c), memberIdOf(c))),
  );
  app.get('/tenants/:tenantId/members/:memberId/agents', ownMember, async (c) =>
    json(await engine.memberAgents(tenantOf(c), memberIdOf(c))),
  );
  // Who of the member can sign in: read only, for the member's own access review.
  app.get('/tenants/:tenantId/members/:memberId/users', ownMemberPeople, async (c) =>
    json(await engine.memberUsers(tenantOf(c), memberIdOf(c))),
  );
  // The member's own controls, set by its own signed-in users; loosening one waits for a second.
  app.put('/tenants/:tenantId/members/:memberId/controls', ownMember, async (c) => {
    const out = await engine.setMemberControls(
      tenantOf(c),
      c.get('principal'),
      memberIdOf(c),
      await input(c),
    );
    return json(out, out.status === 'pending_approval' ? 202 : 200);
  });
  app.get('/tenants/:tenantId/members/:memberId/settlement', ownMember, async (c) =>
    json(await engine.memberSettlement(tenantOf(c), memberIdOf(c))),
  );
  app.get('/tenants/:tenantId/members/:memberId/statement', ownMember, async (c) =>
    json(await engine.memberStatement(tenantOf(c), memberIdOf(c), c.req.query())),
  );
  // The whole period at once, oldest first, for a spreadsheet.
  app.get('/tenants/:tenantId/members/:memberId/statement.csv', ownMember, async (c) => {
    const memberId = memberIdOf(c);
    return csv(
      await engine.memberStatementCsv(tenantOf(c), memberId, c.req.query()),
      `statement-${memberId}`,
    );
  });

  // Agents
  app.post('/tenants/:tenantId/agents', platformOnly, async (c) =>
    json(await engine.createAgent(tenantOf(c), c.get('principal'), await input(c)), 201),
  );
  app.get('/tenants/:tenantId/agents', staff, async (c) =>
    json(await engine.listAgents(tenantOf(c))),
  );
  // A member may stop its own agent, never start one again: the engine checks it is its own.
  app.post('/tenants/:tenantId/agents/:agentId/suspend', memberOrStaff, async (c) => {
    await engine.setAgentStatus(
      tenantOf(c),
      c.get('principal'),
      c.req.param('agentId'),
      'blocked',
      await input(c),
    );
    return json({ ok: true });
  });
  app.post('/tenants/:tenantId/agents/:agentId/reinstate', staff, async (c) => {
    await engine.setAgentStatus(
      tenantOf(c),
      c.get('principal'),
      c.req.param('agentId'),
      'active',
      await input(c),
    );
    return json({ ok: true });
  });
  app.patch('/tenants/:tenantId/agents/:agentId/mandate', platformOnly, async (c) =>
    json(
      await engine.changeAgentMandate(
        tenantOf(c),
        c.get('principal'),
        c.req.param('agentId'),
        await input(c),
      ),
    ),
  );

  // Keys. The list is every key, live and revoked, for an access review, never the key itself.
  app.post('/tenants/:tenantId/keys', platformOnly, async (c) =>
    json(await engine.createApiKey(tenantOf(c), c.get('principal'), await input(c)), 201),
  );
  app.get('/tenants/:tenantId/keys', staff, async (c) =>
    json(await engine.listApiKeys(tenantOf(c))),
  );
  app.post('/tenants/:tenantId/keys/:keyId/rotate', staff, async (c) =>
    json(await engine.rotateApiKey(tenantOf(c), c.get('principal'), c.req.param('keyId')), 201),
  );
  app.delete('/tenants/:tenantId/keys/:keyId', staff, async (c) => {
    await engine.revokeApiKey(tenantOf(c), c.get('principal'), c.req.param('keyId'));
    return json({ ok: true });
  });

  // Programs
  app.post('/tenants/:tenantId/programs', platformOnly, async (c) =>
    json(await engine.publishProgram(tenantOf(c), c.get('principal'), await input(c)), 201),
  );
  app.get('/tenants/:tenantId/programs', staff, async (c) =>
    json(await engine.listPrograms(tenantOf(c))),
  );
  app.get('/tenants/:tenantId/programs/:key', staff, async (c) =>
    json(await engine.latestProgram(tenantOf(c), c.req.param('key'))),
  );

  // Four eyes: actions held for a second signed-in person. `status` is pending (the default),
  // decided or all; `kind`, `from`, `to`, `before` and `limit` as for any population. A member
  // sees and decides only its own requests, such as a withdrawal past its own threshold.
  app.get('/tenants/:tenantId/approvals', memberOrStaff, async (c) => {
    const { kind, memberId } = c.get('principal');
    const scope = kind === 'member' ? (memberId ?? null) : null;
    if (kind === 'member' && !scope) throw denied();
    return json(await engine.listApprovals(tenantOf(c), scope, c.req.query()));
  });
  app.get('/tenants/:tenantId/approvals.csv', staff, async (c) =>
    csv(await engine.approvalsCsv(tenantOf(c), c.req.query()), 'approvals'),
  );
  // The note is optional, so an empty body is an approval without one.
  app.post('/tenants/:tenantId/approvals/:approvalId/approve', memberOrStaff, async (c) =>
    json(
      await engine.approveRequest(
        tenantOf(c),
        c.get('principal'),
        c.req.param('approvalId'),
        await input(c),
      ),
    ),
  );
  app.post('/tenants/:tenantId/approvals/:approvalId/reject', memberOrStaff, async (c) =>
    json(
      await engine.rejectRequest(
        tenantOf(c),
        c.get('principal'),
        c.req.param('approvalId'),
        await input(c),
      ),
    ),
  );
}
