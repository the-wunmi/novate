import { createHash } from 'node:crypto';

interface SettlementPolicy {
  netting: string;
  rail: string;
  timing: { mode: string; every?: string };
}

/**
 * Obligations settle together only when they share a rail, a netting mode, a timing and a program.
 * The program is in the key because risk bearer, funding window and decision limits come from it.
 */
export function settlementGroup(
  deal: { id: string; programId: string },
  s: SettlementPolicy,
): string {
  const timing =
    s.timing.mode === 'immediate'
      ? `deal:${deal.id}`
      : s.timing.mode === 'cycle'
        ? `every:${s.timing.every}`
        : 'manual';
  return `${s.rail}|${s.netting}|${timing}|${deal.programId}`;
}

export function parseGroup(group: string): { rail: string; netting: string; timing: string } {
  const [rail, netting, timing] = group.split('|') as [string, string, string];
  return { rail, netting, timing };
}

/** A UUID derived from a string, so repeating a scheduled job cannot start it twice. */
export function stableUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Rail request ids have tight limits (50 characters on Airwallex account transfers). */
export const shortKey = (seed: string) =>
  createHash('sha256').update(seed).digest('hex').slice(0, 40);
