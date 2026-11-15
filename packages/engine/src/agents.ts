import { DomainError, Mandate, type Principal, parseInput } from '@novate/core';
import { agents, apiKeys } from '@novate/db';
import { and, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { committedThisMonth } from './authority.ts';
import { actorOf, Reason, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { type AgentRow, memberInTenant } from './repo.ts';

export const CreateAgent = z.object({
  memberId: z.string().uuid(),
  name: z.string().min(1),
  mandate: Mandate,
});

/** Add an agent for a member, recording who added it and the mandate it started with. */
export async function createAgent(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof CreateAgent>,
) {
  const { mandate, ...values } = parseInput(CreateAgent, input);
  return tx('create_agent', async (db) => {
    await memberInTenant(db, tenantId, values.memberId);
    const [row] = await db
      .insert(agents)
      .values({ ...values, tenantId, mandate: mandate })
      .returning();
    const agent = row as AgentRow;
    await recordControl(db, tenantId, actorOf(principal), {
      type: 'agent_added',
      payload: { agentId: agent.id, memberId: agent.memberId, name: agent.name, mandate },
    });
    return agent;
  });
}

export const SetAgentStatus = z.object({ reason: Reason.optional() });

export async function setAgentStatus(
  tenantId: string,
  principal: Principal,
  agentId: string,
  status: 'active' | 'blocked',
  input?: z.input<typeof SetAgentStatus>,
): Promise<void> {
  // The body is optional: a suspension needs no reason to take effect.
  const { reason } = parseInput(SetAgentStatus, input ?? {});
  const byMember = principal.kind === 'member';
  if (byMember && status !== 'blocked') {
    throw new DomainError('forbidden', 'Only the platform or the house can reinstate an agent');
  }
  if (byMember && !reason) {
    throw new DomainError('invalid', 'Say why the agent is being suspended');
  }
  if (byMember && !principal.memberId) throw new DomainError('forbidden', 'No member on this key');
  await tx('set_agent_status', async (db) => {
    const [row] = await db
      .update(agents)
      .set({ status })
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.tenantId, tenantId),
          // A member may stop its own agents and no one else's.
          byMember ? eq(agents.memberId, principal.memberId as string) : undefined,
        ),
      )
      .returning({ id: agents.id });
    if (!row) throw new DomainError('not_found', 'Agent not found');
    await recordControl(db, tenantId, actorOf(principal), {
      type: status === 'blocked' ? 'agent_suspended' : 'agent_reinstated',
      reason,
      payload: { agentId },
    });
  });
}

export const ChangeMandate = z.object({
  mandate: Mandate,
  reason: Reason.optional(),
});

/** Replace what an agent may do. Deals already authorised keep the mandate they were checked under. */
export async function changeAgentMandate(
  tenantId: string,
  principal: Principal,
  agentId: string,
  input: z.input<typeof ChangeMandate>,
): Promise<AgentRow> {
  const { mandate, reason } = parseInput(ChangeMandate, input);
  return tx('change_agent_mandate', async (db) => {
    const [current] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
      .for('update');
    if (!current) throw new DomainError('not_found', 'Agent not found');
    const [row] = await db
      .update(agents)
      .set({ mandate })
      .where(eq(agents.id, agentId))
      .returning();
    await recordControl(db, tenantId, actorOf(principal), {
      type: 'agent_mandate_changed',
      reason,
      payload: { agentId, from: current.mandate, to: mandate },
    });
    return row as AgentRow;
  });
}

/** Each agent with what it has committed this month, measured as its monthly limit is checked. */
export async function listAgents(tenantId: string, now = new Date(), memberId?: string) {
  const { db } = deps();
  const [rows, used, keys] = await Promise.all([
    db
      .select()
      .from(agents)
      .where(
        and(eq(agents.tenantId, tenantId), memberId ? eq(agents.memberId, memberId) : undefined),
      ),
    committedThisMonth(db, tenantId, now),
    db
      .select({ agentId: apiKeys.agentId, at: max(apiKeys.lastUsedAt) })
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
      .groupBy(apiKeys.agentId),
  ]);
  return rows.map((agent) => {
    const mine = used.rows.filter((u) => u.agentId === agent.id);
    return {
      ...agent,
      /** When any live key of the agent was last used, to the minute. */
      keyLastUsedAt: keys.find((k) => k.agentId === agent.id)?.at ?? null,
      mandate: Mandate.parse(agent.mandate),
      usage: {
        since: used.since.toISOString(),
        amounts: mine.map((u) => ({ side: u.side, currency: u.currency, amount: u.amount })),
        deals: mine.reduce((acc, u) => acc + u.deals, 0),
      },
    };
  });
}

/** One member's agents, each with its mandate and this month's usage, as `listAgents` gives them. */
export async function memberAgents(tenantId: string, memberId: string, now = new Date()) {
  await memberInTenant(deps().db, tenantId, memberId);
  return listAgents(tenantId, now, memberId);
}
