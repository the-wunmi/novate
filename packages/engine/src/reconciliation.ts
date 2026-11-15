import { DBOS } from '@dbos-inc/dbos-sdk';
import { absBig, DomainError, maxBig, toMajor } from '@novate/core';
import {
  cardPayments,
  decisionCases,
  fxConversions,
  ledgerTransfers,
  programs,
  type ReconRunSummary,
  reconBreaks,
  reconRuns,
  settlementInstructions,
  type Tx,
} from '@novate/db';
import { Accounts } from '@novate/ledger';
import { ceilingIn, Decisions, ProgramSpec } from '@novate/policy';
import {
  isRailFee,
  type RailBalance,
  type RailTransaction,
  railLabel,
  type SettlementRail,
} from '@novate/rails';
import { and, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { cardsAwaitingSettlement, settleCardPayments } from './card-funding.ts';
import { recordControl, SYSTEM } from './control.ts';
import { railRefusal } from './deal-policy.ts';
import { resolveCase } from './decisions.ts';
import { deps, networkStep, tx } from './deps.ts';
import { notify } from './notifications.ts';
import { newestFirst } from './page.ts';
import { closeMatchingBreaks, resumeIfClear, stoppedOnlyByReconciliation } from './recon-breaks.ts';
import { haltSettlement } from './repo.ts';

const WINDOW_MS = 30 * 86_400_000;

export interface ReconBreak {
  kind: 'balance_mismatch' | 'missing_on_rail' | 'missing_in_ledger' | 'amount_mismatch';
  currency: string;
  expected: bigint;
  actual: bigint;
  externalRef?: string;
  /** What the rail called the transaction, when the difference is one novate did not make. */
  detail?: { railType?: string; occurredAt?: string };
}

export interface ReconSummary {
  runId: string;
  status: 'clean' | 'breaks';
  breaks: ReconBreak[];
  halted: boolean;
}

/**
 * Compare the ledger with what the rail says it holds. Agents act on balances, so a disagreement
 * stops new settlement until a decider has looked at it. Assumes one rail account per tenant.
 */
async function reconcile(tenantId: string, railName: string): Promise<ReconSummary> {
  const rail = deps().rails.get(railName);
  const opening = await tx('recon_opening', (db) => openingOf(db, tenantId, railName));
  // Anything before the opening is already counted in what it recorded.
  const since = new Date(
    Math.max((await DBOS.now()) - WINDOW_MS, opening?.createdAt.getTime() ?? 0),
  );
  const balances = await networkStep('recon_balances', () => rail.balances());
  const transactions = await networkStep('recon_transactions', () => rail.transactions(since));

  const { runId, breaks } = await tx('recon_compare', async (db) => {
    await settleCardPayments(db, tenantId, railName, transactions);
    const known = await knownReferences(
      db,
      tenantId,
      rail,
      transactions.map((t) => t.externalRef),
    );
    await postRailFees(db, tenantId, rail, transactions, known);
    const { breaks: balanceBreaks, positions } = await compareBalances(
      db,
      tenantId,
      rail,
      balances,
      opening?.balances ?? {},
    );
    const found = [
      ...balanceBreaks,
      ...(await compareTransactions(db, tenantId, rail, { transactions, known, since })),
    ];
    return {
      breaks: found,
      runId: await recordRun(db, tenantId, rail, found, { transactions, positions }),
    };
  });
  if (!breaks.length) return { runId, status: 'clean', breaks, halted: false };

  // Client money that does not add up stops settlement at once. Only a person can accept it.
  const reason = `Reconciliation run ${runId} found ${describeDifferences(breaks, railName)}`;
  const pending = await tx('recon_halt', async (db) => {
    await haltSettlement(db, tenantId, SYSTEM, reason, { rail: railName, runId });
    return openReconCase(db, tenantId, railName);
  });
  // One case per rail at a time: a difference that persists is the same question, not a new one.
  if (!pending) {
    await DBOS.startWorkflow(reconCaseWorkflow, { workflowID: runId })(tenantId, railName, runId);
  }
  await notify({ type: 'settlement_stopped', tenantId, reason, caseId: pending ?? undefined });
  return { runId, status: 'breaks', breaks, halted: true };
}

/**
 * The run's differences go to the deciders. Rules and models may only confirm the stop; a person
 * may acknowledge, which closes the differences as explained and lets settlement go on if nothing
 * else holds it. Its workflow id is the run id, so a person's decision reaches it.
 */
async function decideReconBreak(tenantId: string, railName: string, runId: string) {
  const { breaks, decisions, inFlight } = await tx('recon_case_evidence', async (db) => {
    const rows = await db.select().from(reconBreaks).where(eq(reconBreaks.runId, runId));
    const breaks = rows.map(asReconBreak);
    return {
      breaks,
      decisions: await strictestDecisions(db, tenantId, caseDifference(breaks).currency),
      inFlight: await paymentsInFlight(db, tenantId, deps().rails.get(railName)),
    };
  });
  const size = caseDifference(breaks);
  const res = await resolveCase({
    tenantId,
    kind: 'recon_break',
    subjectType: 'rail',
    subjectId: runId,
    reason: describeDifferences(breaks, railName),
    evidence: {
      breaks: breaks.map(shownBreak),
      inFlight: inFlight.map((p) => ({ ...p, amountShown: shownMoney(p.amount, p.currency) })),
      // How the case amount was reached, per currency, so a decider sees every currency's size.
      difference: {
        currency: size.currency,
        amount: size.amount,
        amountShown: shownMoney(size.amount, size.currency),
        byCurrency: size.byCurrency.map((d) => ({
          ...d,
          amountShown: shownMoney(d.amount, d.currency),
        })),
      },
    },
    amount: size.amount,
    currency: size.currency,
    decisions,
  });
  if (res.outcome !== 'decided' || res.action.type !== 'acknowledge') return;
  const actor = res.decider.actor ?? SYSTEM;
  const note = res.action.note;
  await tx('recon_acknowledged', async (db) => {
    const rows = await db.select().from(reconBreaks).where(eq(reconBreaks.runId, runId));
    const reference = `case:${res.caseId}`;
    const breakIds = await closeMatchingBreaks(db, tenantId, railName, rows, {
      resolution: 'explained',
      actor,
      reason: note,
      reference,
    });
    await recordControl(db, tenantId, actor, {
      type: 'break_resolved',
      reason: note,
      payload: { rail: railName, resolution: 'explained', reference, breakIds, caseId: res.caseId },
    });
    if (await stoppedOnlyByReconciliation(db, tenantId)) {
      await resumeIfClear(db, tenantId, actor, { reason: note, caseId: res.caseId });
    }
  });
}

const reconCaseWorkflow = DBOS.registerWorkflow(decideReconBreak, { name: 'reconBreakCase' });

const asReconBreak = (b: typeof reconBreaks.$inferSelect): ReconBreak => ({
  kind: b.kind,
  currency: b.currency,
  expected: b.expected,
  actual: b.actual,
  ...(b.externalRef ? { externalRef: b.externalRef } : {}),
  ...(Object.keys(b.detail).length ? { detail: b.detail as ReconBreak['detail'] } : {}),
});

/** The open reconciliation case for this rail, if a person has yet to answer one. */
async function openReconCase(db: Tx, tenantId: string, rail: string): Promise<string | null> {
  const [found] = await db
    .select({ id: decisionCases.id })
    .from(decisionCases)
    .innerJoin(reconRuns, eq(sql`${reconRuns.id}::text`, decisionCases.subjectId))
    .where(
      and(
        eq(decisionCases.tenantId, tenantId),
        eq(decisionCases.kind, 'recon_break'),
        eq(decisionCases.status, 'open'),
        eq(reconRuns.rail, rail),
      ),
    )
    .limit(1);
  return found?.id ?? null;
}

export const reconWorkflow = DBOS.registerWorkflow(reconcile, { name: 'reconcile' });

export const differences = (n: number) => `${n} ${n === 1 ? 'difference' : 'differences'}`;

/**
 * The breaks to count. A balance mismatch on a run that also found item-level breaks is the same
 * incident seen from the balance, not one more difference, so it is left out of every count: hold
 * messages, sign-off, the case reason and `countsAsItem` on `/reconciliation/breaks`.
 */
export function countsAsItem<T extends { kind: string; runId?: string }>(b: T, all: T[]): boolean {
  if (b.kind !== 'balance_mismatch') return true;
  return !all.some((o) => o.kind !== 'balance_mismatch' && o.runId === b.runId);
}

export const countedBreaks = <T extends { kind: string; runId?: string }>(all: T[]): T[] =>
  all.filter((b) => countsAsItem(b, all));

/** Money in accounts' style: a negative amount in brackets, `(300.00)`. */
const accounting = (amount: bigint, currency: string) =>
  amount < 0n ? `(${toMajor(-amount, currency)})` : toMajor(amount, currency);

/**
 * One run's differences in words: "3 differences with Airwallex, net (300.00) EUR". The net is
 * what the rail holds beyond the ledger, per currency: the items where there are any, otherwise
 * the balance mismatch.
 */
export function describeDifferences(breaks: ReconBreak[], rail: string): string {
  const counted = countedBreaks(breaks);
  const nets = [...Map.groupBy(breaks, (b) => b.currency)].map(([currency, rows]) => {
    const items = rows.filter((b) => b.kind !== 'balance_mismatch');
    const net = (items.length ? items : rows).reduce((acc, b) => acc + (b.actual - b.expected), 0n);
    return `${accounting(net, currency)} ${currency}`;
  });
  return `${differences(counted.length)} with ${railLabel(rail)}, net ${nets.join(', ')}`;
}

/** Money as people read it, next to the minor units a decider's action uses: `12.34 EUR`. */
export const shownMoney = (amount: bigint, currency: string) =>
  `${toMajor(amount, currency)} ${currency}`;

/** A break as a decider sees it: minor units for the record, major units for the rationale. */
const shownBreak = (b: ReconBreak) => ({
  ...b,
  difference: b.actual - b.expected,
  expectedShown: shownMoney(b.expected, b.currency),
  actualShown: shownMoney(b.actual, b.currency),
  differenceShown: shownMoney(b.actual - b.expected, b.currency),
});

/**
 * How large a run's differences are, per currency and for the case. Amounts in different
 * currencies are never added together. In each currency the size is the larger of the absolute net
 * balance mismatch and the sum of the absolute item differences: items that cancel out still count
 * in full, so a large break cannot be acknowledged under the ceiling, and a balance that no item
 * explains still counts. The case is sized in the currency with the largest difference, and the
 * others are shown to the decider beside it.
 */
export function caseDifference(breaks: ReconBreak[]) {
  const byCurrency = [...Map.groupBy(breaks, (b) => b.currency)].map(([currency, rows]) => {
    const net = rows
      .filter((b) => b.kind === 'balance_mismatch')
      .reduce((acc, b) => acc + (b.actual - b.expected), 0n);
    const items = rows
      .filter((b) => b.kind !== 'balance_mismatch')
      .reduce((acc, b) => acc + absBig(b.expected - b.actual), 0n);
    const amount = maxBig(absBig(net), items);
    return { currency, amount };
  });
  const largest = byCurrency.reduce<(typeof byCurrency)[number] | undefined>(
    (top, d) => (!top || d.amount > top.amount ? d : top),
    undefined,
  ) ?? { currency: 'EUR', amount: 0n };
  return { currency: largest.currency, amount: largest.amount, byCurrency };
}

/** The case amount: see `caseDifference`. */
export const differenceAmount = (breaks: ReconBreak[]): bigint => caseDifference(breaks).amount;

/** What the ledger says should be on the rail, per currency, before any opening balance. */
export async function ledgerPosition(db: Tx, tenantId: string, rail: SettlementRail) {
  const accounts = await deps().ledger.balances(db, tenantId, { rail: rail.name });
  const held = (code: string) => accounts.find((a) => a.code === code)?.balance ?? 0n;
  const awaitingCards = await cardsAwaitingSettlement(db, tenantId, rail.name);
  return {
    currencies: accounts.map((a) => a.currency),
    of(currency: string) {
      const cash = held(Accounts.houseCash(rail.name, currency).code);
      const inFlight = held(Accounts.houseInFlight(rail.name, currency).code);
      // Reserved payouts have left a rail that debits on submit, and not yet left one that does not.
      const onRail = rail.capabilities.debitsOnSubmit ? cash : cash + inFlight;
      const feesPaid = held(Accounts.houseFeesPaid(rail.name, currency).code);
      // Captured card payments are credited to members before the rail pays them over.
      return onRail - feesPaid - (awaitingCards.get(currency) ?? 0n);
    },
  };
}

/**
 * A rail's fee on money novate knows about is the house's cost. It can be in a currency no member
 * holds, so it comes out of the house's own money on the rail, not out of members' cash. A fee on
 * something novate does not recognise is left to show up as a difference.
 */
async function postRailFees(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  transactions: RailTransaction[],
  known: Set<string>,
) {
  const fees = transactions.filter(
    (t) => t.status === 'settled' && isRailFee(t) && known.has(t.externalRef),
  );
  // One batch each: every run sees the fees already booked next to any new ones.
  for (const t of fees) {
    await deps().ledger.post(db, tenantId, [
      {
        key: `rail_fee:${rail.name}:${t.externalRef}:${t.currency}`,
        debit: Accounts.houseRailFees(t.currency),
        credit: Accounts.houseFeesPaid(rail.name, t.currency),
        amount: absBig(t.amount),
        kind: 'rail_fee',
        ref: t.externalRef,
      },
    ]);
  }
}

async function compareBalances(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  balances: RailBalance[],
  opening: Record<string, string>,
): Promise<{ breaks: ReconBreak[]; positions: RailPosition[] }> {
  const position = await ledgerPosition(db, tenantId, rail);
  const currencies = new Set([
    ...balances.map((b) => b.currency),
    ...position.currencies,
    ...Object.keys(opening),
  ]);
  const breaks: ReconBreak[] = [];
  const positions: RailPosition[] = [];
  for (const currency of currencies) {
    const atOpening = BigInt(opening[currency] ?? 0);
    const expected = position.of(currency) + atOpening;
    const actual = balances.find((b) => b.currency === currency)?.total ?? 0n;
    positions.push({ currency, ledger: expected, rail: actual, atOpening });
    if (expected !== actual) breaks.push({ kind: 'balance_mismatch', currency, expected, actual });
  }
  return { breaks, positions };
}

/** One currency as the ledger and the rail each see it, including what was there at the opening. */
interface RailPosition {
  currency: string;
  ledger: bigint;
  rail: bigint;
  atOpening: bigint;
}

export const openingOf = async (db: Tx, tenantId: string, rail: string) => {
  const [run] = await db
    .select({ createdAt: reconRuns.createdAt, summary: reconRuns.summary })
    .from(reconRuns)
    .where(
      and(
        eq(reconRuns.tenantId, tenantId),
        eq(reconRuns.rail, rail),
        eq(reconRuns.status, 'opening'),
      ),
    )
    // The latest: an operator can record it again, and everything after that point must add up.
    .orderBy(...newestFirst(reconRuns.createdAt, reconRuns.id))
    .limit(1);
  return run && { createdAt: run.createdAt, balances: openingBalances(run.summary) };
};

/** What an opening run recorded the account held, per currency. */
export function openingBalances(summary: ReconRunSummary): Record<string, string> {
  if (summary.kind !== 'opening') throw new Error('Not an opening run');
  return summary.balances;
}

/** What a comparison run saw. */
export function comparisonOf(summary: ReconRunSummary) {
  if (summary.kind !== 'comparison') throw new Error('Not a comparison run');
  return summary;
}

/** Amounts per currency as JSON keeps them. */
export const amountStrings = (amounts: Record<string, bigint>) =>
  Object.fromEntries(Object.entries(amounts).map(([c, v]) => [c, v.toString()]));

/**
 * Note what an account already holds when a rail is connected, once. That money belongs to no
 * member, so later comparisons leave it out, and everything after this point must still add up.
 */
export async function recordRailOpening(tenantId: string, railName: string): Promise<void> {
  const rail = deps().rails.get(railName);
  const balances = await rail.balances();
  await tx('rail_opening', async (db) => {
    if (await openingOf(db, tenantId, railName)) return;
    const position = await ledgerPosition(db, tenantId, rail);
    const summary = Object.fromEntries(
      balances.map((b) => [b.currency, b.total - position.of(b.currency)]),
    );
    // The app's clock, because rail transactions are compared against it.
    await db.insert(reconRuns).values({
      tenantId,
      rail: railName,
      status: 'opening',
      breakCount: 0,
      summary: { kind: 'opening', balances: amountStrings(summary) },
      createdAt: new Date(),
    });
    await recordControl(db, tenantId, SYSTEM, {
      type: 'opening_recorded',
      payload: { rail: railName, balances: summary },
    });
  });
}

async function compareTransactions(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  seen: { transactions: RailTransaction[]; known: Set<string>; since: Date },
): Promise<ReconBreak[]> {
  const { transactions, known, since } = seen;
  const settled = transactions.filter((t) => t.status === 'settled');
  // A fee shares the id of the movement it was for, and is not part of that movement's amount.
  const byRef = Map.groupBy(
    settled.filter((t) => !isRailFee(t)),
    (t) => t.externalRef,
  );
  const breaks: ReconBreak[] = [];

  const instructions = await db
    .select()
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.rail, rail.name),
        inArray(settlementInstructions.status, ['confirmed', 'reversed']),
        isNotNull(settlementInstructions.externalRef),
        gte(settlementInstructions.updatedAt, since),
      ),
    );
  for (const i of instructions) {
    const externalRef = i.externalRef as string;
    const found = byRef.get(externalRef);
    if (!found) {
      breaks.push({
        kind: 'missing_on_rail',
        currency: i.currency,
        expected: i.amount,
        actual: 0n,
        externalRef,
        detail: { occurredAt: i.updatedAt.toISOString() },
      });
      continue;
    }
    // A reversed payment has its return under the same reference, so only confirmed ones add up.
    const moved = found.reduce((acc, t) => acc + absBig(t.amount), 0n);
    if (i.status === 'confirmed' && moved !== i.amount) {
      breaks.push({
        kind: 'amount_mismatch',
        currency: i.currency,
        expected: i.amount,
        actual: moved,
        externalRef,
        detail: {
          occurredAt: found
            .map((t) => t.occurredAt)
            .sort()
            .at(-1),
        },
      });
    }
  }

  for (const t of settled) {
    if (known.has(t.externalRef)) continue;
    breaks.push({
      kind: 'missing_in_ledger',
      currency: t.currency,
      expected: 0n,
      actual: t.amount,
      externalRef: t.externalRef,
      detail: { railType: t.sourceType, occurredAt: t.occurredAt },
    });
  }
  return breaks;
}

/** Sent and not yet final. A difference that matches one of these is timing, not missing money. */
const paymentsInFlight = (db: Tx, tenantId: string, rail: SettlementRail) =>
  db
    .select({
      direction: settlementInstructions.direction,
      amount: settlementInstructions.amount,
      currency: settlementInstructions.currency,
      status: settlementInstructions.status,
      externalRef: settlementInstructions.externalRef,
      updatedAt: settlementInstructions.updatedAt,
    })
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        eq(settlementInstructions.rail, rail.name),
        inArray(settlementInstructions.status, ['submitted', 'in_doubt']),
      ),
    );

/** Bind parameters per query stay far below Postgres's limit of 65,535. */
const REF_CHUNK = 5_000;

/**
 * Which of the rail's references the house made or recorded: a deposit, a payment, a conversion or
 * a card payment. Only the references the rail reported are looked up, so the cost follows the
 * reconciliation window rather than the house's whole history.
 */
async function knownReferences(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  refs: string[],
): Promise<Set<string>> {
  const known = new Set<string>();
  const unique = [...new Set(refs)];
  for (let i = 0; i < unique.length; i += REF_CHUNK) {
    const chunk = unique.slice(i, i + REF_CHUNK);
    const found = await Promise.all([
      db
        .select({ ref: fxConversions.externalRef })
        .from(fxConversions)
        .where(
          and(
            eq(fxConversions.tenantId, tenantId),
            inArray(fxConversions.externalRef, chunk),
            eq(fxConversions.rail, rail.name),
          ),
        ),
      db
        .select({ ref: ledgerTransfers.ref })
        .from(ledgerTransfers)
        .where(
          and(
            eq(ledgerTransfers.tenantId, tenantId),
            inArray(ledgerTransfers.ref, chunk),
            inArray(ledgerTransfers.kind, [
              'deposit',
              'deposit_reversal',
              'deposit_reversal_shortfall',
            ]),
          ),
        ),
      db
        .select({ ref: settlementInstructions.externalRef })
        .from(settlementInstructions)
        .where(
          and(
            eq(settlementInstructions.tenantId, tenantId),
            inArray(settlementInstructions.externalRef, chunk),
            ne(settlementInstructions.status, 'pending'),
          ),
        ),
      db
        .select({ ref: cardPayments.attemptRef })
        .from(cardPayments)
        .where(
          and(
            eq(cardPayments.tenantId, tenantId),
            inArray(cardPayments.attemptRef, chunk),
            eq(cardPayments.rail, rail.name),
          ),
        ),
    ]);
    for (const r of found.flat()) if (r.ref) known.add(r.ref);
  }
  return known;
}

async function recordRun(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  breaks: ReconBreak[],
  seen: { transactions: RailTransaction[]; positions: RailPosition[] },
): Promise<string> {
  // Currencies that never held anything are noise on the books page.
  const positions = seen.positions.filter((p) => p.ledger !== 0n || p.rail !== 0n);
  const [run] = await db
    .insert(reconRuns)
    .values({
      tenantId,
      rail: rail.name,
      status: breaks.length ? 'breaks' : 'clean',
      breakCount: breaks.length,
      summary: {
        kind: 'comparison',
        transactions: seen.transactions.length,
        positions: positions.map((p) => ({
          currency: p.currency,
          ledger: p.ledger.toString(),
          rail: p.rail.toString(),
          atOpening: p.atOpening.toString(),
        })),
        fees: seen.transactions.filter((t) => t.status === 'settled' && isRailFee(t)).length,
      },
    })
    .returning({ id: reconRuns.id });
  const runId = run?.id as string;
  if (breaks.length) {
    await db.insert(reconBreaks).values(breaks.map((b) => ({ ...b, runId, tenantId })));
  }
  return runId;
}

/** Of all the tenant's programs, the one that trusts agents least with this currency. */
export async function strictestDecisions(db: Tx, tenantId: string, currency: string) {
  const rows = await db
    .select({ spec: programs.spec })
    .from(programs)
    .where(eq(programs.tenantId, tenantId));
  const all = rows.map((r) => ProgramSpec.parse(r.spec).decisions);
  return (
    all.reduce<Decisions | undefined>(
      (lowest, d) => (!lowest || ceilingIn(d, currency) < ceilingIn(lowest, currency) ? d : lowest),
      undefined,
    ) ?? Decisions.parse({})
  );
}

/**
 * A rail account's history and opening belong to the one tenant that owns it. Anyone else, and
 * everyone for a rail nobody owns, is told it does not exist.
 */
export function assertRailOwner(tenantId: string, railName: string): void {
  if (deps().railOwners[railName] !== tenantId) {
    throw new DomainError('not_found', 'No such rail for this tenant');
  }
}

/**
 * The rails this server runs, whether their money is real, which of them the tenant owns, and on
 * which the house can open a member's accounts, with the details that takes.
 */
export const tenantRails = (tenantId: string) =>
  deps()
    .rails.all()
    .map((r) => ({
      name: r.name,
      environment: r.environment,
      owned: deps().railOwners[r.name] === tenantId,
      opensAccounts:
        r.provision && railRefusal(tenantId, r.name) === null ? (r.provisionNeeds ?? null) : null,
    }));

/** Reconcile now and wait for the answer. */
export async function runReconciliation(tenantId: string, railName: string) {
  assertRailOwner(tenantId, railName);
  const handle = await DBOS.startWorkflow(reconWorkflow)(tenantId, railName);
  const summary = await handle.getResult();
  const { breaks } = summary;
  return {
    ...summary,
    breaks: breaks.map((b) => ({ ...b, countsAsItem: countsAsItem(b, breaks) })),
  };
}
