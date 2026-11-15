import type { ReconBreak } from './types.ts';

/** The server decides what counts as one difference; every page counts the same way. */
export const differenceItems = <B extends { countsAsItem: boolean }>(breaks: B[]) =>
  breaks.filter((b) => b.countsAsItem);

/** The net balance difference per currency: what the rail holds that the ledger does not. */
export function differenceNet(breaks: ReconBreak[]) {
  const net = new Map<string, bigint>();
  for (const b of breaks.filter((x) => x.kind === 'balance_mismatch')) {
    net.set(b.currency, (net.get(b.currency) ?? 0n) + BigInt(b.actual) - BigInt(b.expected));
  }
  return [...net].map(([currency, amount]) => ({ currency, amount }));
}
