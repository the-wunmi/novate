import { minBig } from '@novate/core';
import type { deals, obligations, Tx } from '@novate/db';
import type { FxCollateral } from '@novate/fx';
import { Accounts } from '@novate/ledger';
import type { NettableObligation } from '@novate/netting';
import { deps } from './deps.ts';
import { escrowCurrency } from './repo.ts';

type NettingRow = { o: typeof obligations.$inferSelect; d: typeof deals.$inferSelect };

/**
 * What the netting is given for a set of obligations: each one with what its deal's escrow already
 * covers in the obligation's currency, and escrow held in another currency, which has to be
 * converted first. Every escrow is read in one query. A cycle and its preview both start here, so
 * the preview nets exactly as the cycle will.
 */
export async function nettingInput(
  db: Tx,
  tenantId: string,
  rows: NettingRow[],
): Promise<{ items: NettableObligation[]; collateral: FxCollateral[] }> {
  const principal = rows.filter(({ o }) => o.leg === 'principal');
  const escrows = await deps().ledger.balances(db, tenantId, {
    kinds: ['escrow'],
    dealIds: [...new Set(principal.map(({ o }) => o.dealId))],
  });
  const held = new Map(escrows.map((e) => [e.code, e.balance]));

  const items: NettableObligation[] = [];
  const collateral: FxCollateral[] = [];
  for (const { o, d } of rows) {
    let prefunded = 0n;
    if (o.leg === 'principal') {
      const currency = escrowCurrency(d);
      const escrow = held.get(Accounts.dealEscrow(o.dealId, currency).code) ?? 0n;
      if (currency === o.currency) prefunded = minBig(escrow, o.amount);
      else if (escrow > 0n) collateral.push({ member: o.payerMemberId, currency, amount: escrow });
    }
    items.push({
      id: o.id,
      payer: o.payerMemberId,
      payee: o.payeeMemberId,
      currency: o.currency,
      amount: o.amount,
      prefunded,
    });
  }
  return { items, collateral };
}
