import { DomainError, type Principal, parseInput, sha256 } from '@novate/core';
import { reconBreakResolutions, reconRuns, type Tx } from '@novate/db';
import { type RailBalance, railLabel, type SettlementRail } from '@novate/rails';
import { z } from 'zod';
import { personOf, Reason, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { registerApprovalExecutor, requestApproval } from './four-eyes.ts';

import { openBreakRows } from './recon-breaks.ts';
import { toStrings } from './recon-views.ts';
import {
  amountStrings,
  assertRailOwner,
  countedBreaks,
  ledgerPosition,
  openingOf,
} from './reconciliation.ts';

export const RequestOpening = z.object({
  reason: Reason,
  /** Close every unresolved break on the rail as `opening_rebased`. Refused without it. */
  rebaseBreaks: z.boolean().default(false),
});

/** A request older than this must be made again: the balances it saw are no longer current. */
const OPENING_TTL_MS = 24 * 3_600_000;

/** What an opening request saw and would record, per currency, in minor units. */
const OpeningAsked = z.object({
  rail: z.string(),
  rebaseBreaks: z.boolean(),
  /** What the rail reported holding when the request was made. */
  railBalances: z.record(z.string(), z.string()),
  /** The opening it would record: rail minus what the ledger accounts for. */
  balances: z.record(z.string(), z.string()),
  /** How much the new opening hides relative to what the ledger now expects. */
  absorbed: z.record(z.string(), z.string()),
});

const openingRefusedOverBreaks = (n: number, rail: string) =>
  new DomainError(
    'conflict',
    `${n} unresolved ${n === 1 ? 'break' : 'breaks'} on ${railLabel(rail)}: resolve them, or rebase them with rebaseBreaks`,
    { openBreaks: n },
  );

/** What the rail holds, as a record of minor-unit strings, so two readings can be compared. */
const railHoldings = (balances: RailBalance[]) =>
  Object.fromEntries(
    balances
      .filter((b) => b.total !== 0n)
      .map((b) => [b.currency, b.total.toString()])
      .sort(([a], [b]) => (a as string).localeCompare(b as string)),
  ) as Record<string, string>;

/**
 * The opening that would be recorded now, and per currency how much of the rail it would hide:
 * the new opening less the one the ledger counts on today, which is exactly the difference a
 * reconciliation now would find.
 */
async function proposedOpening(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  balances: RailBalance[],
) {
  const previous = await openingOf(db, tenantId, rail.name);
  const before = previous?.balances ?? {};
  const position = await ledgerPosition(db, tenantId, rail);
  const summary = Object.fromEntries(
    balances.map((b) => [b.currency, b.total - position.of(b.currency)]),
  ) as Record<string, bigint>;
  const absorbed: Record<string, bigint> = {};
  for (const currency of new Set([...Object.keys(summary), ...Object.keys(before)])) {
    const change = (summary[currency] ?? 0n) - BigInt(before[currency] ?? 0);
    if (change !== 0n) absorbed[currency] = change;
  }
  return { previous, summary, absorbed };
}

/**
 * Ask to record again what the rail account holds as money belonging to no member. It hides any
 * difference up to now, so it is held for a second person (`rail_opening` in four eyes), with what
 * it would record and how much it would absorb in each currency.
 */
export async function requestRailOpening(
  tenantId: string,
  principal: Principal,
  railName: string,
  input: z.input<typeof RequestOpening>,
) {
  assertRailOwner(tenantId, railName);
  const { reason, rebaseBreaks } = parseInput(RequestOpening, input);
  personOf(principal, 'ask for a new opening');
  const rail = deps().rails.get(railName);
  const balances = await rail.balances();
  return tx('rail_opening_request', async (db) => {
    const open = await openBreakRows(db, tenantId, railName);
    if (open.length && !rebaseBreaks) {
      throw openingRefusedOverBreaks(countedBreaks(open).length, railName);
    }
    const { summary, absorbed } = await proposedOpening(db, tenantId, rail, balances);
    const pending = await requestApproval(db, tenantId, principal, {
      kind: 'rail_opening',
      payload: {
        rail: railName,
        rebaseBreaks,
        railBalances: railHoldings(balances),
        balances: summary,
        absorbed,
      },
      amount: null,
      currency: null,
      reason,
    });
    return { ...pending, absorbed, balances: summary, openBreaks: countedBreaks(open).length };
  });
}

/**
 * A second person applies an opening request. Refused if the rail or the ledger moved since it was
 * made, because then what they would approve is not what was asked for.
 */
registerApprovalExecutor('rail_opening', {
  approvers: ['house'],
  ttlMs: OPENING_TTL_MS,
  prepare: (request) => deps().rails.get(OpeningAsked.parse(request.payload).rail).balances(),
  async run(db, request, approvedBy, balances) {
    const { tenantId } = request;
    const asked = OpeningAsked.parse(request.payload);
    const rail = deps().rails.get(asked.rail);
    const { previous, summary, absorbed } = await proposedOpening(db, tenantId, rail, balances);
    const unchanged =
      sha256(railHoldings(balances)) === sha256(asked.railBalances) &&
      sha256(toStrings(summary)) === sha256(asked.balances);
    if (!unchanged) {
      throw new DomainError(
        'conflict',
        `What ${railLabel(asked.rail)} or the ledger holds has changed since this request: make a new request`,
        { requested: asked.balances, now: summary },
      );
    }
    const open = await openBreakRows(db, tenantId, asked.rail);
    if (open.length && !asked.rebaseBreaks) {
      throw openingRefusedOverBreaks(countedBreaks(open).length, asked.rail);
    }
    await db.insert(reconRuns).values({
      tenantId,
      rail: asked.rail,
      status: 'opening',
      breakCount: 0,
      summary: { kind: 'opening', balances: amountStrings(summary) },
      createdAt: new Date(),
    });
    const eventId = await recordControl(db, tenantId, request.actor, {
      type: 'opening_recorded',
      reason: request.reason,
      payload: {
        rail: asked.rail,
        balances: summary,
        previous: previous?.balances ?? null,
        absorbed,
        rebasedBreaks: open.map((b) => b.id),
        approvalId: request.id,
        approvedBy,
      },
    });
    if (open.length) {
      await db.insert(reconBreakResolutions).values(
        open.map((b) => ({
          breakId: b.id,
          tenantId,
          resolution: 'opening_rebased' as const,
          actor: request.actor,
          reason: request.reason,
          reference: `control:${eventId}`,
        })),
      );
    }
    return { balances: summary, absorbed, rebasedBreaks: open.length };
  },
});
