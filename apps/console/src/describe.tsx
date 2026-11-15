// Plain-language descriptions of what happened, and who did it. Shared by the activity feed and the
// deal timeline, so the same event reads the same way everywhere.

import type { ControlActor } from '@novate/core';
import type { ReactNode } from 'react';
import type { Activity, Check, Deal } from './types.ts';
import {
  type ActorKind,
  actionLabel,
  actorName,
  actorOf,
  caseKind,
  moneyText,
  railName,
  sentence,
  sentences,
  shortId,
  words,
} from './ui.tsx';

/** What each kind of held action is, as people say it. */
export const APPROVAL_KINDS: Record<string, string> = {
  manual_credit: 'Manual credit',
  break_write_off: 'Books difference write-off',
  case_decision: 'Decision above the AI ceiling',
  rail_opening: 'New rail opening',
  rail_refs: 'Payout details change',
  member_withdrawal: 'Withdrawal',
  member_controls: 'Withdrawal approval limits',
};

export interface Described {
  actor: ActorKind;
  actorName?: string;
  text: ReactNode;
  detail?: ReactNode;
  /** Marks the step on a timeline: money moving, a hold, a failure. */
  tone?: 'key' | 'warn' | 'bad';
  /** The money the line is about, shown in its own column. */
  money?: { amount: string; currency: string };
}

/** A check the gate ran, in an operator's words. */
export function checkText(c: Check): string {
  if (c.code === 'ceiling') return c.passed ? 'Within the AI ceiling' : 'Over the AI ceiling';
  const { action, kind } = c.params ?? {};
  if (c.code === 'allowed_action' && action && kind) {
    return `${actionLabel(action)} is allowed on a ${caseKind(kind).toLowerCase()} case`;
  }
  if (c.code === 'evidence_unchanged') {
    return c.passed ? 'The evidence is unchanged since the AI saw it' : 'The evidence changed';
  }
  return sentence(c.text);
}

export function dealSummary(
  deal: Pick<Deal, 'terms' | 'buyerMemberId' | 'sellerMemberId'>,
  name: (id: string) => string,
) {
  const line = deal.terms?.lines?.[0];
  const what = line ? `${line.quantity.toLocaleString('en')} ${line.description}` : 'goods';
  return `${name(deal.buyerMemberId)} buys ${what} from ${name(deal.sellerMemberId)}`;
}

/**
 * Facts, documents and submissions name the credential they came from, `<kind>:<id>`. An agent's
 * own name is filled in where the event carries its id.
 */
function sourceActor(source: unknown): { actor: ActorKind; actorName?: string } {
  const kind = String(source ?? '').split(':')[0] ?? '';
  if (kind === 'agent') return { actor: 'agent' };
  if (['inspector', 'carrier', 'arbiter', 'member', 'platform', 'house'].includes(kind)) {
    return { actor: 'key', actorName: sentence(kind) };
  }
  return { actor: 'code' };
}

const FACT_NAMES: Record<string, string> = {
  commercial_invoice: 'commercial invoice',
  packing_list: 'packing list',
  bill_of_lading: 'bill of lading',
  inspection: 'inspection result',
  acceptance: 'acceptance',
  delivery: 'delivery confirmation',
};

/** One deal event. `programName` turns a program reference such as "trade@v1" into its name. */
export function describeDealEvent(
  type: string,
  p: Record<string, unknown>,
  programName: (ref: string) => string = (ref) => ref,
): Described {
  const amount = (field = 'amount') =>
    p[field] && p.currency ? moneyText(String(p[field]), String(p.currency)) : '';
  switch (type) {
    case 'submitted':
      return {
        ...sourceActor(p.source),
        text: 'Deal submitted',
        detail: p.awaitingSide
          ? `Waiting for the ${p.awaitingSide} to submit the same terms`
          : undefined,
      };
    case 'confirmed':
      return {
        ...sourceActor(p.source),
        text: `The ${p.side ?? 'other side'} confirmed the same terms`,
      };
    case 'policy_resolved':
      return {
        actor: 'code',
        text: `Runs under ${programName(String(p.program ?? ''))}`,
      };
    case 'verified':
      return { actor: 'code', text: 'Agent authority checked against its mandate' };
    case 'authority_failed':
      return {
        actor: 'code',
        text: 'Refused: the agent was not allowed to make this deal',
        detail: sentences(p.reason),
        tone: 'bad',
      };
    case 'frozen':
      return {
        actor: 'rules',
        text: 'Frozen for review',
        detail: sentences(p.reason),
        tone: 'warn',
      };
    case 'held':
      return {
        actor: 'rules',
        text: 'Held: the evidence did not pass',
        detail: sentences(p.reason),
        tone: 'warn',
      };
    case 'awaiting_funding':
      return { actor: 'code', text: 'Waiting for the buyer to fund' };
    case 'escrow_locked':
      return {
        actor: 'code',
        text: `Buyer funds locked${amount() ? `: ${amount()}` : ''}`,
        detail: fxNote(p),
        tone: 'key',
      };
    case 'margin_locked':
      return {
        actor: 'code',
        text: `Seller margin locked${amount() ? `: ${amount()}` : ''}`,
        detail: fxNote(p),
      };
    case 'awaiting_conditions':
      return { actor: 'code', text: 'Waiting for the release conditions' };
    case 'fact_added': {
      const key = String(p.kind === 'document' ? p.type : p.kind);
      const name = FACT_NAMES[key] ?? words(key);
      return {
        ...sourceActor(p.source),
        text: `Filed ${name}`,
      };
    }
    case 'conditions_evaluated':
      return p.state === 'blocked'
        ? { actor: 'rules', text: 'Evidence checked: did not pass', tone: 'warn' }
        : p.state === 'pending'
          ? { actor: 'rules', text: 'Evidence checked: still waiting on some' }
          : { actor: 'rules', text: 'Evidence checked: release conditions met' };
    case 'held_for_evidence':
      return { actor: 'code', text: 'Waiting for corrected evidence' };
    case 'waived':
      return { actor: 'code', text: 'Findings waived' };
    case 'released':
      return {
        actor: 'rules',
        text: `Cleared to settle${p.amount && p.currency ? `: ${moneyText(String(p.amount), String(p.currency))}` : ''}`,
        detail:
          [
            p.of && p.amount && p.of !== p.amount
              ? `Of ${moneyText(String(p.of), String(p.currency))}, in proportion to what passed inspection; the rest goes back to the buyer`
              : null,
            p.late ? "Shipped after the ship-by date, within the program's tolerance" : null,
          ]
            .filter(Boolean)
            .join('. ') || undefined,
        tone: 'key',
      };
    case 'netted':
      return {
        actor: 'code',
        text: p.cycleId
          ? `Included in cycle ${shortId('CY', String(p.cycleId))}`
          : 'Included in a cycle',
        tone: 'key',
      };
    case 'settled':
      return { actor: 'code', text: 'Settled', tone: 'key' };
    case 'cancelled': {
      const byModel = String(p.reason ?? '').includes('model');
      return {
        actor: byModel ? 'claude' : 'code',
        text: byModel ? 'Cancelled by AI' : 'Cancelled',
        detail: byModel ? undefined : sentence(p.reason),
        tone: 'bad',
      };
    }
    case 'refunded':
      return { actor: 'code', text: 'Refunded to the buyer', tone: 'bad' };
    case 'card_funded':
      return {
        actor: 'rail',
        actorName: 'Airwallex',
        text: `Card payment captured${amount() ? `: ${amount()}` : ''}`,
        tone: 'key',
      };
    case 'card_refused':
      return {
        actor: 'rail',
        actorName: 'Airwallex',
        text: 'Card refused',
        detail: sentences(p.reason),
        tone: 'bad',
      };
    case 'mandate_proof':
      return {
        actor: 'rail',
        actorName: 'Metal',
        text: 'On-chain proof of the buyer’s mandate recorded',
      };
    case 'x402_refused':
      return {
        actor: 'rail',
        actorName: 'Metal',
        text: 'Stablecoin payment refused',
        detail: sentences(p.reason),
        tone: 'bad',
      };
    case 'cycle_failed':
      return { actor: 'code', text: 'Settlement failed', detail: sentences(p.reason), tone: 'bad' };
    case 'claim_filed':
      return { ...sourceActor(p.source), text: 'Claim filed' };
    case 'claim_refunded':
      return { actor: 'code', text: `Claim refunded to the buyer: ${amount()}`, tone: 'bad' };
    case 'claim_paid':
      return { actor: 'code', text: `Claim paid to the seller: ${amount()}`, tone: 'key' };
    case 'claim_closed':
      return { actor: 'code', text: 'Claim closed', detail: sentence(p.outcome) };
    default:
      return {
        actor: 'code',
        text: sentence(type),
        detail: p.reason ? sentences(p.reason) : undefined,
      };
  }
}

/** One line of the house's activity. */
export function describeActivity(
  a: Activity,
  name: (id: string) => string,
  programName?: (ref: string) => string,
): Described & { href?: string } {
  switch (a.source) {
    case 'deal': {
      // An event that names an amount but not its currency is in the deal's currency.
      const d = describeDealEvent(a.type, { currency: a.currency, ...a.detail.event }, programName);
      const who = `${name(a.detail.buyer)} buys from ${name(a.detail.seller)}`;
      return {
        ...d,
        detail: d.detail ?? `${shortId('DL', a.dealId)}, ${who}`,
        href: `/deals/${a.dealId}`,
        money:
          a.type === 'submitted' || a.type === 'settled' || a.type === 'cancelled'
            ? { amount: a.amount, currency: a.currency }
            : typeof a.detail.event.amount === 'string' &&
                typeof a.detail.event.currency === 'string'
              ? { amount: a.detail.event.amount, currency: a.detail.event.currency }
              : undefined,
      };
    }
    case 'decision': {
      const decider =
        a.detail.decider === 'model'
          ? 'AI'
          : a.detail.decider === 'person'
            ? 'A person'
            : a.detail.decider === 'rule'
              ? 'A rule'
              : 'The house';
      const actor: ActorKind =
        a.detail.decider === 'model'
          ? 'claude'
          : a.detail.decider === 'person'
            ? 'person'
            : a.detail.decider === 'rule'
              ? 'rules'
              : 'code';
      return {
        actor,
        text: a.detail.accepted
          ? `${decider} decided: ${actionLabel(a.type).toLowerCase()}`
          : `${decider} proposed ${actionLabel(a.type).toLowerCase()}, and code refused it`,
        detail: a.detail.accepted
          ? caseKind(a.detail.caseKind)
          : a.detail.failed.map(checkText).join('; '),
        tone: a.detail.accepted ? undefined : 'bad',
        href: `/decisions/${a.caseId}`,
      };
    }
    case 'money': {
      const { rail, memberId } = a.detail;
      const member = memberId ? name(memberId) : undefined;
      if (a.type === 'deposit') {
        return {
          actor: 'rail',
          actorName: rail ? railName(rail) : undefined,
          text: `Deposit arrived${member ? ` for ${member}` : ''}`,
          money: { amount: a.amount, currency: a.currency },
          tone: 'key',
        };
      }
      if (a.type === 'rail_fee') {
        return {
          actor: 'rail',
          actorName: rail ? railName(rail) : undefined,
          text: `Rail fee of ${moneyText(a.amount, a.currency)}, charged to the house`,
        };
      }
      return { actor: 'code', text: `${sentence(a.type)}: ${moneyText(a.amount, a.currency)}` };
    }
    case 'cycle': {
      const text =
        a.type === 'settled'
          ? `Cycle ${shortId('CY', a.detail.cycleId)} paid out and closed`
          : a.type === 'failed'
            ? `Cycle ${shortId('CY', a.detail.cycleId)} failed`
            : a.type === 'deferred'
              ? `Cycle ${shortId('CY', a.detail.cycleId)} held back`
              : `Cycle ${shortId('CY', a.detail.cycleId)} ${words(a.type)}`;
      return {
        actor: 'code',
        text,
        detail: a.detail.rail ? `On ${railName(a.detail.rail)}` : undefined,
        tone: a.type === 'failed' ? 'bad' : 'key',
        href: `/settlement/${a.detail.cycleId}`,
      };
    }
    case 'control': {
      // A signed-in person by name; a key as a key, never as if it were a person or an agent.
      const { payload, reason } = a.detail;
      const { kind: actor, name: who } = actorOf(a.actor);
      const member = name(String(payload.memberId ?? ''));
      const approved = payload.approvedBy
        ? `, approved by ${actorName(payload.approvedBy as ControlActor)}`
        : '';
      const target = String(payload.name ?? payload.email ?? '');
      const rail = railName(String(payload.rail ?? ''));
      const text: Record<string, string> = {
        settlement_stopped: `Settlement stopped by ${who}`,
        settlement_resumed: `Settlement resumed by ${who}`,
        opening_recorded: `Opening balance recorded for ${rail} by ${who}${approved}`,
        program_published: `${programName?.(`${payload.programKey}@v${payload.version}`) ?? 'Program'} published by ${who}`,
        agent_suspended: `Agent suspended by ${who}`,
        agent_reinstated: `Agent reinstated by ${who}`,
        case_assigned: `Case taken by ${who}`,
        case_unassigned: `Case released by ${who}`,
        agent_mandate_changed: `Agent limits changed by ${who}`,
        rail_refs_changed: `${member}'s payout details changed by ${who}${approved}`,
        manual_credit: `Funds credited by hand to ${member} by ${who}`,
        deposit_assigned: `Unmatched deposit credited to ${member} by ${who}`,
        member_suspended: `${member} suspended by ${who}`,
        member_reinstated: `${member} reinstated by ${who}`,
        member_close_only: `${member} limited to closing out, after a default`,
        key_issued: `Key ${payload.name ? `"${payload.name}" ` : ''}issued by ${who}`,
        key_revoked: `Key ${payload.name ? `"${payload.name}" ` : ''}revoked by ${who}`,
        break_resolved: `Books difference resolved by ${who}`,
        books_signed_off: `Books signed off by ${who}`,
        user_invited: `${target} invited as ${String(payload.role ?? '')} by ${who}`,
        user_reset: `${target}'s access reset by ${who}`,
        user_disabled: `${target} disabled by ${who}`,
        user_enabled: `${target} enabled by ${who}`,
        invite_accepted: `${who} accepted their invite`,
        user_signed_in: `${who} signed in`,
        user_login_locked: `${target || 'An account'} locked after failed sign-ins`,
        two_step_enabled: `${who} turned on two-step sign-in`,
        two_step_disabled: `${who} turned off two-step sign-in`,
        password_changed: `${who} changed their password`,
        withdrawal_requested: `${member} withdrawal requested by ${who}`,
        default_fund_moved: `Default fund ${payload.direction === 'withdraw' ? 'withdrawal' : 'contribution'} for ${member} by ${who}`,
        approval_requested: `${APPROVAL_KINDS[String(payload.kind)] ?? 'Approval'} asked by ${who}`,
        approval_approved: `${APPROVAL_KINDS[String(payload.kind)] ?? 'Request'} approved by ${who}`,
        approval_rejected: `${APPROVAL_KINDS[String(payload.kind)] ?? 'Request'} rejected by ${who}`,
        settings_changed: `Settings changed by ${who}`,
        member_added: `${String(payload.name ?? 'Member')} added by ${who}`,
        agent_added: `Agent ${String(payload.name ?? '')} added by ${who}`,
        member_updated: `${member} details changed by ${who}`,
        provision_requested: `Accounts for ${member} asked by ${who}`,
        break_assigned: `Books difference taken by ${who}`,
        break_unassigned: `Books difference released by ${who}`,
        payout_refreshed: `Payout checked with the rail by ${who}`,
        member_controls_changed: `${member} withdrawal approval limits changed by ${who}`,
      };
      return {
        actor,
        text: text[a.type] ?? sentence(a.type),
        detail: reason ? sentences(reason) : undefined,
        tone: ['settlement_stopped', 'member_suspended', 'member_close_only'].includes(a.type)
          ? 'bad'
          : 'key',
        href:
          payload.memberId && (a.type.startsWith('member_') || a.type === 'rail_refs_changed')
            ? `/members/${payload.memberId}`
            : ['break_resolved', 'books_signed_off'].includes(a.type)
              ? '/books'
              : a.type === 'case_assigned' || a.type === 'case_unassigned'
                ? `/decisions/${payload.caseId}`
                : a.type === 'program_published'
                  ? `/programs/${payload.programKey}`
                  : a.type === 'opening_recorded'
                    ? '/books'
                    : undefined,
      };
    }
    case 'recon':
      return a.type === 'clean'
        ? {
            actor: 'code',
            text: `${railName(a.detail.rail)} checked, no new differences`,
            href: '/books',
          }
        : {
            actor: 'code',
            text: `${a.detail.differences} difference${a.detail.differences === 1 ? '' : 's'} with ${railName(a.detail.rail)}`,
            detail: 'Settlement stopped',
            tone: 'bad',
            href: '/books',
          };
  }
}

/**
 * A lock taken in another currency: the rate the member paid, the market rate and the buffer
 * between them, said the same way on the deal and on the statement.
 */
export function lockRateText(p: {
  rate?: unknown;
  rateLabel?: unknown;
  marketRate?: unknown;
  bufferBps?: unknown;
}) {
  if (!p.rateLabel) return undefined;
  const buffer =
    typeof p.bufferBps === 'number' && p.bufferBps > 0 ? `, ${p.bufferBps / 100}% buffer` : '';
  const market =
    p.marketRate && p.marketRate !== p.rate ? ` (market ${p.marketRate}${buffer})` : '';
  return `${p.rateLabel}${market}`;
}

const fxNote = (p: Record<string, unknown>) => {
  const rate = lockRateText(p);
  return rate ? `Converted at ${rate}` : undefined;
};
