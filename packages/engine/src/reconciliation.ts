import { DBOS } from '@dbos-inc/dbos-sdk';
import { absBig } from '@novate/core';
import {
  cardPayments,
  fxConversions,
  ledgerTransfers,
  programs,
  reconBreaks,
  reconRuns,
  settlementInstructions,
  type Tx,
  tenants,
} from '@novate/db';
import { Accounts } from '@novate/ledger';
import { Decisions, ProgramSpec } from '@novate/policy';
import {
  isRailFee,
  type RailBalance,
  type RailTransaction,
  type SettlementRail,
} from '@novate/rails';
import { and, eq, gte, inArray, isNotNull, ne } from 'drizzle-orm';
import { cardsAwaitingSettlement, settleCardPayments } from './card-funding.ts';
import { resolveCase } from './decisions.ts';
import { deps, networkStep, tx } from './deps.ts';
import { notify } from './notifications.ts';
import { haltSettlement } from './repo.ts';

const WINDOW_MS = 30 * 86_400_000;

export interface ReconBreak {
  kind: 'balance_mismatch' | 'missing_on_rail' | 'missing_in_ledger' | 'amount_mismatch';
  currency: string;
  expected: bigint;
  actual: bigint;
  externalRef?: string;
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

  const { runId, breaks, decisions, inFlight } = await tx('recon_compare', async (db) => {
    await settleCardPayments(db, tenantId, railName, transactions);
    await postRailFees(db, tenantId, rail, transactions);
    const found = [
      ...(await compareBalances(db, tenantId, rail, balances, opening?.summary ?? {})),
      ...(await compareTransactions(db, tenantId, rail, transactions, since)),
    ];
    return {
      breaks: found,
      runId: await recordRun(db, tenantId, rail, found, transactions.length),
      decisions: await strictestDecisions(db, tenantId, found[0]?.currency ?? 'EUR'),
      inFlight: found.length ? await paymentsInFlight(db, tenantId, rail) : [],
    };
  });
  if (!breaks.length) return { runId, status: 'clean', breaks, halted: false };

  const res = await resolveCase({
    tenantId,
    kind: 'recon_break',
    subjectType: 'rail',
    subjectId: runId,
    reason: `${breaks.length} difference(s) between the ledger and ${railName}`,
    evidence: { breaks, inFlight },
    // The whole difference, so a large break cannot be acknowledged under the ceiling.
    amount: breaks.reduce((acc, b) => acc + absBig(b.expected - b.actual), 0n),
    currency: (breaks[0] as ReconBreak).currency,
    decisions,
    skipPerson: true,
  });
  // Unless a decider has acknowledged it, the safe response to an unexplained difference is to stop.
  const acknowledged = res.outcome === 'decided' && res.action.type === 'acknowledge';
  if (!acknowledged) {
    const reason = `Reconciliation run ${runId} found ${breaks.length} difference(s)`;
    await tx('recon_halt', (db) => haltSettlement(db, tenantId, reason));
    await notify({ type: 'settlement_stopped', tenantId, reason, caseId: res.caseId });
  }
  return { runId, status: 'breaks', breaks, halted: !acknowledged };
}

export const reconWorkflow = DBOS.registerWorkflow(reconcile, { name: 'reconcile' });

/** What the ledger says should be on the rail, per currency, before any opening balance. */
async function ledgerPosition(db: Tx, tenantId: string, rail: SettlementRail) {
  const accounts = await deps().ledger.balances(db, tenantId, `house:${rail.name}:`);
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
) {
  const known = await knownReferences(db, tenantId, rail);
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
  opening: Record<string, unknown>,
): Promise<ReconBreak[]> {
  const position = await ledgerPosition(db, tenantId, rail);
  const currencies = new Set([
    ...balances.map((b) => b.currency),
    ...position.currencies,
    ...Object.keys(opening),
  ]);
  const breaks: ReconBreak[] = [];
  for (const currency of currencies) {
    const expected = position.of(currency) + BigInt(String(opening[currency] ?? 0));
    const actual = balances.find((b) => b.currency === currency)?.total ?? 0n;
    if (expected !== actual) breaks.push({ kind: 'balance_mismatch', currency, expected, actual });
  }
  return breaks;
}

const openingOf = async (db: Tx, tenantId: string, rail: string) => {
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
    .limit(1);
  return run;
};

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
    await db
      .insert(reconRuns)
      .values({ tenantId, rail: railName, status: 'opening', summary, createdAt: new Date() });
  });
}

async function compareTransactions(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  transactions: RailTransaction[],
  since: Date,
): Promise<ReconBreak[]> {
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
      });
    }
  }

  const known = await knownReferences(db, tenantId, rail);
  for (const t of settled) {
    if (known.has(t.externalRef)) continue;
    breaks.push({
      kind: 'missing_in_ledger',
      currency: t.currency,
      expected: 0n,
      actual: t.amount,
      externalRef: t.externalRef,
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

async function knownReferences(db: Tx, tenantId: string, rail: SettlementRail) {
  const fx = await db
    .select({ ref: fxConversions.externalRef })
    .from(fxConversions)
    .where(and(eq(fxConversions.tenantId, tenantId), eq(fxConversions.rail, rail.name)));
  const deposits = await db
    .select({ ref: ledgerTransfers.ref })
    .from(ledgerTransfers)
    .where(
      and(
        eq(ledgerTransfers.tenantId, tenantId),
        inArray(ledgerTransfers.kind, [
          'deposit',
          'deposit_reversal',
          'deposit_reversal_shortfall',
        ]),
      ),
    );
  const instructions = await db
    .select({ ref: settlementInstructions.externalRef })
    .from(settlementInstructions)
    .where(
      and(
        eq(settlementInstructions.tenantId, tenantId),
        ne(settlementInstructions.status, 'pending'),
      ),
    );
  const cards = await db
    .select({ ref: cardPayments.attemptRef })
    .from(cardPayments)
    .where(and(eq(cardPayments.tenantId, tenantId), eq(cardPayments.rail, rail.name)));
  return new Set(
    [...fx, ...deposits, ...instructions, ...cards].flatMap((r) => (r.ref ? [r.ref] : [])),
  );
}

async function recordRun(
  db: Tx,
  tenantId: string,
  rail: SettlementRail,
  breaks: ReconBreak[],
  transactions: number,
): Promise<string> {
  const [run] = await db
    .insert(reconRuns)
    .values({
      tenantId,
      rail: rail.name,
      status: breaks.length ? 'breaks' : 'clean',
      summary: { transactions, breaks: breaks.length },
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
  const ceiling = (d: Decisions) => d.ceiling[currency] ?? 0;
  return (
    all.reduce<Decisions | undefined>(
      (lowest, d) => (!lowest || ceiling(d) < ceiling(lowest) ? d : lowest),
      undefined,
    ) ?? Decisions.parse({})
  );
}

export const railOwner = (rail: string): string | undefined => deps().railOwners[rail];

/** Reconcile now and wait for the answer. */
export async function runReconciliation(tenantId: string, railName: string): Promise<ReconSummary> {
  const handle = await DBOS.startWorkflow(reconWorkflow)(tenantId, railName);
  return handle.getResult();
}

export async function resumeSettlement(tenantId: string): Promise<void> {
  await deps()
    .db.update(tenants)
    .set({ settlementHaltedAt: null, settlementHaltReason: null })
    .where(eq(tenants.id, tenantId));
}
