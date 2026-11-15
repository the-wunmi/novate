import { DomainError, type Principal } from '@novate/core';
import * as engine from '@novate/engine';
import { z } from 'zod';

/** One thing a trading agent can do. Each runs as the calling key, under the usual permissions. */
export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  run(principal: Principal, input: z.output<S>): Promise<unknown>;
}

const tool = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool;

const DealId = z.object({ dealId: z.string().uuid() });
/** A member's key reads its own books. The platform and house may name one. Nobody else can. */
function memberOf(principal: Principal, requested?: string): string {
  if (principal.kind === 'platform' || principal.kind === 'house') {
    if (!requested) throw new DomainError('invalid', 'memberId is required for this key');
    return requested;
  }
  if (!principal.memberId || (requested && requested !== principal.memberId)) {
    throw new DomainError('unauthorised_agent', 'Not allowed');
  }
  return principal.memberId;
}

/**
 * What an agent trading through novate can do. Deliberately no way to take money out or decide a
 * case: those stay with the house's own process, whatever a calling agent is told to do.
 */
export const AGENT_TOOLS: AgentTool[] = [
  tool({
    name: 'whoami',
    description: 'Who this key acts for: its kind, tenant and member.',
    input: z.object({}),
    run: async ({ kind, tenantId, memberId }) => ({ kind, tenantId, memberId }),
  }),
  tool({
    name: 'submit_deal',
    description:
      'Propose a deal between two members under a program. Amounts are minor units, so EUR 14.00 is 1400. Reuse idempotencyKey when retrying. A deal from one party waits for the other side to submit the same terms.',
    input: engine.SubmitDeal,
    run: (principal, input) => engine.submitDeal(principal, input),
  }),
  tool({
    name: 'get_deal',
    description: 'A deal with its status, events, evidence and obligations.',
    input: DealId,
    run: (principal, { dealId }) => engine.dealDetail(dealId, principal),
  }),
  tool({
    name: 'submit_evidence',
    description:
      'Add a fact to a deal, such as acceptance, delivery, a dispute or an inspection result. What may be asserted depends on who the key belongs to.',
    input: z.object({ dealId: z.string().uuid(), fact: engine.SubmitFact }),
    run: (principal, { dealId, fact }) => engine.submitFact(dealId, principal, fact),
  }),
  tool({
    name: 'file_document',
    description:
      'File a trade document such as a commercial invoice or bill of lading. It is read and checked against the deal.',
    input: z.object({ dealId: z.string().uuid(), document: engine.SubmitDocument }),
    run: (principal, { dealId, document }) => engine.submitDocument(dealId, principal, document),
  }),
  tool({
    name: 'get_balances',
    description: 'Balances for your member. Platform keys must name the member.',
    input: z.object({ memberId: z.string().uuid().optional() }),
    run: async (principal, { memberId }) =>
      engine.balances(principal.tenantId, memberOf(principal, memberId)),
  }),
  tool({
    name: 'get_margin',
    description: 'Collateral posted by your member and any open margin call.',
    input: z.object({ memberId: z.string().uuid().optional() }),
    run: async (principal, { memberId }) =>
      engine.memberMargin(principal.tenantId, memberOf(principal, memberId)),
  }),
];
