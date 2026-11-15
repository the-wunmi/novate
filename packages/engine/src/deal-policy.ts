import { DealTerms } from '@novate/core';
import type { Tx } from '@novate/db';
import { type ProgramSpec, type ResolvedPolicy, resolvePolicy } from '@novate/policy';
import type { SignalReading, SignalSubject } from '@novate/signals';
import { deps } from './deps.ts';
import { type DealRow, getMember, type MemberRow, signalValues } from './repo.ts';

export function signalSubject(deal: DealRow): SignalSubject {
  const terms = DealTerms.parse(deal.terms);
  return {
    tenantId: deal.tenantId,
    dealId: deal.id,
    buyerMemberId: deal.buyerMemberId,
    sellerMemberId: deal.sellerMemberId,
    buyerAgentId: deal.buyerAgentId ?? undefined,
    currency: deal.currency,
    amount: deal.amount,
    category: terms.category,
    attributes: terms.attributes,
  };
}

const party = (m: MemberRow) => ({
  id: m.id,
  name: m.name,
  homeCurrency: m.homeCurrency,
  attributes: m.attributes,
});

/** Resolve a program against a deal as it stands now. Pure apart from reading the two members. */
export async function resolveForDeal(
  db: Tx,
  deal: DealRow,
  program: ProgramSpec,
  signals: Record<string, SignalReading>,
): Promise<ResolvedPolicy> {
  const terms = DealTerms.parse(deal.terms);
  return resolvePolicy(program, {
    deal: {
      amount: deal.amount,
      currency: deal.currency,
      quantity: deal.quantity,
      category: terms.category,
      unitPrice: deal.amount / BigInt(deal.quantity),
      shipmentDate: terms.shipmentDate,
      attributes: terms.attributes,
    },
    buyer: party(await getMember(db, deal.buyerMemberId)),
    seller: party(await getMember(db, deal.sellerMemberId)),
    signals: signalValues(signals),
  });
}

/** Why this tenant cannot use a rail, if it cannot. A rail account belongs to one tenant. */
export function railRefusal(tenantId: string, rail: string): string | null {
  const { rails, railOwners } = deps();
  if (!rails.has(rail)) return `Rail ${rail} is not available`;
  const owner = railOwners[rail];
  return owner && owner !== tenantId ? `Rail ${rail} is not available` : null;
}

/** Why a program will not take these terms, if it will not. */
export function shapeProblem(program: ProgramSpec, terms: DealTerms): string | null {
  const { allowed, requireSku, maxLegsBps } = program.dealShape;
  if (!allowed.includes(terms.shape)) return `This program does not take ${terms.shape} deals`;
  if (requireSku && terms.lines.some((l) => !l.sku))
    return 'This program needs a SKU on every line';
  if (terms.legs.reduce((acc, l) => acc + l.bps, 0) > maxLegsBps) {
    return 'Deal legs exceed the program limit';
  }
  return null;
}
