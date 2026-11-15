import { api, useAction } from './api.ts';
import type { Agent } from './types.ts';

/** Suspends an agent that may trade, or reinstates a suspended one, for the reason given. */
export function useAgentStatus(tenantId: string, agent: Agent, onDone?: () => void) {
  const blocked = agent.status === 'blocked';
  return useAction(tenantId, {
    run: (reason: string) =>
      api(`/tenants/${tenantId}/agents/${agent.id}/${blocked ? 'reinstate' : 'suspend'}`, {
        body: { reason },
      }),
    done: `${agent.name} ${blocked ? 'reinstated' : 'suspended'}`,
    onDone,
  });
}
