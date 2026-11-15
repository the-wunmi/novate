import type { ControlActor } from '@novate/core';
import {
  cardPayments,
  controlEvents,
  cycles,
  decisionCases,
  ledgerAccounts,
  ledgerTransfers,
  reconBreakResolutions,
  reconBreaks,
  reconRuns,
  type Tx,
} from '@novate/db';
import { and, asc, desc, eq, inArray, isNull, max, ne, type SQL, sql } from 'drizzle-orm';
import { deps } from './deps.ts';
import { HOUSE_FX_IN, HOUSE_FX_OUT } from './member-fx.ts';
import { breakAssignees } from './operations.ts';
import { newerThan, newestFirst, pageOf } from './page.ts';
import { type PopulationInput, populationOf, spanning, type Window, within } from './population.ts';

import { openBreakRows } from './recon-breaks.ts';
import { countedBreaks, countsAsItem, openingBalances, tenantRails } from './reconciliation.ts';

export const toStrings = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, String(v)]));

const HISTORY = 30;

/** A break as people read it: open until someone closes it, however clean later runs are. */
function breakView(
  b: typeof reconBreaks.$inferSelect,
  r: typeof reconBreakResolutions.$inferSelect | undefined,
  now: Date,
  /** The breaks it is counted among: its run's, or every open one. */
  among: (typeof reconBreaks.$inferSelect)[] = [b],
) {
  return {
    id: b.id,
    kind: b.kind,
    currency: b.currency,
    expected: b.expected,
    actual: b.actual,
    externalRef: b.externalRef,
    detail: b.detail,
    status: r ? ('resolved' as const) : ('open' as const),
    resolution: r
      ? {
          resolution: r.resolution,
          actor: r.actor,
          reason: r.reason,
          reference: r.reference,
          at: r.createdAt,
        }
      : null,
    openedAt: b.createdAt,
    ageSeconds: Math.floor(((r?.createdAt ?? now).getTime() - b.createdAt.getTime()) / 1000),
    /** False for a balance mismatch its run's item breaks already account for: count it once. */
    countsAsItem: countsAsItem(b, among),
  };
}

/**
 * What the opening in force at a moment took out of the comparison, per currency, beyond the
 * opening before it. Recording an opening again folds any difference into it, so a run that shows
 * no difference next to open breaks is explained by this figure. With no earlier opening, it is the
 * whole of the first.
 */
async function openingAbsorption(db: Tx, tenantId: string) {
  const openings = await db
    .select({ rail: reconRuns.rail, at: reconRuns.createdAt, summary: reconRuns.summary })
    .from(reconRuns)
    .where(and(eq(reconRuns.tenantId, tenantId), eq(reconRuns.status, 'opening')))
    .orderBy(asc(reconRuns.createdAt), asc(reconRuns.id));
  const amount = (balances: Record<string, string>, currency: string) =>
    BigInt(balances[currency] ?? 0);
  return (rail: string, at: Date) => {
    const before = openings.filter((o) => o.rail === rail && o.at <= at);
    const latest = before.at(-1);
    if (!latest) return null;
    const previous = before.at(-2);
    const now = openingBalances(latest.summary);
    const then = previous ? openingBalances(previous.summary) : {};
    const currencies = [...new Set([...Object.keys(now), ...Object.keys(then)])].sort();
    return {
      openingAt: latest.at,
      previousOpeningAt: previous?.at ?? null,
      currencies: currencies.map((currency) => ({
        currency,
        amount: amount(now, currency) - amount(then, currency),
      })),
    };
  };
}

/** Checks of the books against each rail, newest first, with what each side held and any differences. */
export const reconHistory = async (tenantId: string, input?: PopulationInput) =>
  reconRunsIn(tenantId, populationOf(input, HISTORY));

/** Checks in a window already decided, such as an export's. */
export async function reconRunsIn(tenantId: string, w: Window) {
  const { db } = deps();
  const page = pageOf(
    await db
      .select()
      .from(reconRuns)
      .where(
        and(
          eq(reconRuns.tenantId, tenantId),
          ...within(reconRuns.createdAt, reconRuns.id, tenantId, w),
        ),
      )
      .orderBy(...newestFirst(reconRuns.createdAt, reconRuns.id))
      .limit(w.limit + 1),
    w.limit,
    (r) => r.id,
  );
  const runs = page.rows;
  // The breaks and cases of these runs, joined on the same window rather than listed by id.
  const found = and(
    eq(reconRuns.tenantId, tenantId),
    ...within(reconRuns.createdAt, reconRuns.id, tenantId, w),
    ...(runs.length
      ? spanning(
          reconRuns.createdAt,
          runs.map((r) => r.createdAt),
        )
      : []),
  );
  return { next: page.next, rows: await runViews(db as unknown as Tx, tenantId, runs, found) };
}

/** Runs as people read them: each with its differences, the case they went to and the opening. */
async function runViews(
  db: Tx,
  tenantId: string,
  runs: (typeof reconRuns.$inferSelect)[],
  /** Which runs to read breaks and cases for: a window's, or a few by id. */
  found: SQL | undefined,
) {
  const withBreaks = and(found, eq(reconRuns.status, 'breaks'));
  const [breakRows, cases] = runs.some((r) => r.status === 'breaks')
    ? await Promise.all([
        db
          .select({ b: reconBreaks, r: reconBreakResolutions })
          .from(reconBreaks)
          .innerJoin(reconRuns, eq(reconRuns.id, reconBreaks.runId))
          .leftJoin(reconBreakResolutions, eq(reconBreakResolutions.breakId, reconBreaks.id))
          .where(withBreaks),
        // A difference goes to a decider as a case about the run that found it.
        db
          .select({
            id: decisionCases.id,
            runId: decisionCases.subjectId,
            status: decisionCases.status,
            resolution: decisionCases.resolution,
          })
          .from(decisionCases)
          .innerJoin(reconRuns, eq(sql`${reconRuns.id}::text`, decisionCases.subjectId))
          .where(and(eq(decisionCases.tenantId, tenantId), withBreaks)),
      ])
    : [[], []];
  const breaksOf = Map.groupBy(breakRows, (x) => x.b.runId);
  const caseOf = new Map(cases.map((c) => [c.runId, c]));
  const absorbed = await openingAbsorption(db, tenantId);
  const now = new Date();
  return runs.map((r) => {
    const among = (breaksOf.get(r.id) ?? []).map((x) => x.b);
    return {
      id: r.id,
      rail: r.rail,
      status: r.status,
      at: r.createdAt,
      summary: r.summary,
      absorbedByOpening: absorbed(r.rail, r.createdAt),
      decision: caseOf.get(r.id) ?? null,
      breaks: (breaksOf.get(r.id) ?? []).map((x) => breakView(x.b, x.r ?? undefined, now, among)),
    };
  });
}

/**
 * Where each rail the tenant owns stands now: its latest check, the opening in force, since when
 * its checks have kept finding differences, and per currency what each side held at the latest
 * comparison. `houseOwn` is the movement since the opening that is not members' money, and
 * `houseOwnParts` what it is made of (see `houseOwnParts`). The total is null for a currency more
 * than one rail holds, because members' money there cannot be split per rail; only the parts that
 * belong to one rail are listed then.
 */
export async function railBooks(tenantId: string) {
  const db = deps().db as unknown as Tx;
  const owned = tenantRails(tenantId).filter((r) => r.owned);
  const latestOf = (rail: string, ...where: (SQL | undefined)[]) =>
    db
      .select()
      .from(reconRuns)
      .where(and(eq(reconRuns.tenantId, tenantId), eq(reconRuns.rail, rail), ...where))
      .orderBy(...newestFirst(reconRuns.createdAt, reconRuns.id))
      .limit(1)
      .then(([run]) => run);
  const [nets, open, states] = await Promise.all([
    creditNets(db, tenantId),
    openBreakRows(db, tenantId),
    Promise.all(
      owned.map(async (r) => {
        const [latest, comparison, opening, clean, recorded] = await Promise.all([
          latestOf(r.name, ne(reconRuns.status, 'opening')),
          latestOf(r.name, sql`${reconRuns.summary}->>'kind' = 'comparison'`),
          latestOf(r.name, eq(reconRuns.status, 'opening')),
          latestOf(r.name, eq(reconRuns.status, 'clean')),
          openingRecord(db, tenantId, r.name),
        ]);
        // The first check after the last clean one: differences have been found ever since.
        const since =
          latest && latest.status !== 'clean'
            ? await db
                .select({ at: reconRuns.createdAt })
                .from(reconRuns)
                .where(
                  and(
                    eq(reconRuns.tenantId, tenantId),
                    eq(reconRuns.rail, r.name),
                    ne(reconRuns.status, 'opening'),
                    ...(clean
                      ? [newerThan(reconRuns.createdAt, reconRuns.id, tenantId, clean.id)]
                      : []),
                  ),
                )
                .orderBy(asc(reconRuns.createdAt), asc(reconRuns.id))
                .limit(1)
                .then(([first]) => first?.at ?? null)
            : null;
        return { rail: r, latest, comparison, opening, since, recorded };
      }),
    ),
  ]);
  const latestRuns = states.flatMap((s) => (s.latest ? [s.latest] : []));
  const views = await runViews(
    db,
    tenantId,
    latestRuns,
    latestRuns.length
      ? and(
          eq(reconRuns.tenantId, tenantId),
          inArray(
            reconRuns.id,
            latestRuns.map((r) => r.id),
          ),
        )
      : undefined,
  );
  const positionsOf = (run: typeof reconRuns.$inferSelect | undefined) =>
    run?.summary.kind === 'comparison' ? run.summary.positions : [];
  const railsHolding = new Map<string, number>();
  for (const s of states) {
    for (const p of positionsOf(s.comparison)) {
      railsHolding.set(p.currency, (railsHolding.get(p.currency) ?? 0) + 1);
    }
  }
  const [rounding, cards] = await Promise.all([
    fxRounding(db, tenantId),
    cardsFronted(db, tenantId),
  ]);
  return states.map((s) => ({
    rail: s.rail.name,
    environment: s.rail.environment,
    latest: views.find((v) => v.id === s.latest?.id) ?? null,
    openingAt: s.opening?.createdAt ?? null,
    opening: s.recorded,
    differencesSince: s.since,
    openDifferences: countedBreaks(open).filter((b) => b.rail === s.rail.name).length,
    positions: positionsOf(s.comparison).map((p) => {
      const movement = BigInt(p.ledger) - BigInt(p.atOpening);
      const shared = (railsHolding.get(p.currency) ?? 0) > 1;
      const own = houseOwnParts(nets, s.rail.name, p.currency, {
        rounding: rounding.get(p.currency),
        cards: cards.filter((c) => c.rail === s.rail.name && c.currency === p.currency),
      });
      const members = MEMBERS_MONEY.reduce((acc, k) => acc + nets.of(k, p.currency), 0n);
      const houseOwn = movement - members;
      const named = own.reduce((acc, part) => acc + part.amount, 0n);
      return {
        currency: p.currency,
        ledger: BigInt(p.ledger),
        rail: BigInt(p.rail),
        atOpening: BigInt(p.atOpening),
        movement,
        houseOwn: shared ? null : houseOwn,
        houseOwnParts: shared
          ? own.filter((part) => RAIL_PARTS.includes(part.kind))
          : [
              ...own,
              ...(houseOwn !== named
                ? [{ kind: 'other' as const, amount: houseOwn - named, refs: [] }]
                : []),
            ],
      };
    }),
  }));
}

/** Money the house holds for members, or owes them: what is left of a movement is the house's own. */
const MEMBERS_MONEY = [
  'available',
  'escrow',
  'margin',
  'settlement',
  'default_fund',
  'portfolio_margin',
  'suspense',
] as const;

type Nets = Awaited<ReturnType<typeof creditNets>>;

/** Per account kind, currency and rail: credits less debits, so a sum over every account is zero. */
async function creditNets(db: Tx, tenantId: string) {
  const rows = await db
    .select({
      kind: ledgerAccounts.kind,
      currency: ledgerAccounts.currency,
      rail: ledgerAccounts.rail,
      net: sql<string>`sum(${ledgerAccounts.creditsPosted} - ${ledgerAccounts.debitsPosted})`,
    })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.tenantId, tenantId))
    .groupBy(ledgerAccounts.kind, ledgerAccounts.currency, ledgerAccounts.rail);
  return {
    of: (kind: string, currency: string, rail?: string) =>
      rows
        .filter(
          (r) =>
            r.kind === kind && r.currency === currency && (rail === undefined || r.rail === rail),
        )
        .reduce((acc, r) => acc + BigInt(r.net), 0n),
  };
}

type Ref = { type: 'cycle' | 'deal'; id: string; amount: bigint };

/** The parts that belong to one rail, which can be told apart even where several hold a currency. */
const RAIL_PARTS = ['rail_fees', 'cards_fronted'];

interface Rounding {
  amount: bigint;
  refs: Ref[];
  more: number;
}

/**
 * What the house's own money on a rail is made of, in one currency. Every ledger account sums to
 * zero, so after members' money what moves the rail balance is: rail fees it paid, card captures
 * credited to members before the card network pays them over, what members owe it, program fees it
 * holds, what it kept from rounding in members' exchanges in settled cycles, what a conversion under
 * way or a stopped cycle left in its FX position, and losses it bore in a default. The rest, money
 * passing through clearing or already reserved for a payout, is `other`. Rounding names the newest
 * cycles it came from and how many more there are, and fronted card money the deals it funded.
 */
function houseOwnParts(
  nets: Nets,
  rail: string,
  currency: string,
  refs: { rounding: Rounding | undefined; cards: (Ref & { currency: string })[] },
) {
  const rounding = refs.rounding?.amount ?? 0n;
  const parts: { kind: string; amount: bigint; refs: Ref[]; more?: number }[] = [
    { kind: 'rail_fees', amount: -nets.of('fees_paid', currency, rail), refs: [] },
    {
      kind: 'cards_fronted',
      amount: -refs.cards.reduce((acc, c) => acc + c.amount, 0n),
      refs: refs.cards.map(({ type, id, amount }) => ({ type, id, amount })),
    },
    { kind: 'member_debt', amount: nets.of('debt', currency), refs: [] },
    {
      kind: 'program_fees',
      amount: nets.of('house_fee_revenue', currency) + nets.of('platform_fee_revenue', currency),
      refs: [],
    },
    {
      kind: 'fx_rounding',
      amount: rounding,
      refs: refs.rounding?.refs ?? [],
      more: refs.rounding?.more ?? 0,
    },
    { kind: 'fx_open', amount: nets.of('fx', currency) - rounding, refs: [] },
    { kind: 'default_losses', amount: nets.of('default_loss', currency), refs: [] },
  ];
  return parts.filter((p) => p.amount !== 0n);
}

const FX_KEPT = sql<string>`sum(case when ${inArray(ledgerTransfers.kind, [...HOUSE_FX_IN])} then ${ledgerTransfers.amount} else -${ledgerTransfers.amount} end)`;

const ROUNDING_REFS = 100;

/**
 * Per currency, what members' exchanges and the house's conversions left with the house in settled
 * cycles, the newest cycles it came from and how many more there are.
 */
async function fxRounding(db: Tx, tenantId: string): Promise<Map<string, Rounding>> {
  const perCycle = db
    .select({
      cycleId: cycles.id,
      currency: ledgerTransfers.currency,
      amount: FX_KEPT.as('amount'),
      at: max(ledgerTransfers.createdAt).as('at'),
    })
    .from(ledgerTransfers)
    .innerJoin(cycles, sql`${cycles.id}::text = ${ledgerTransfers.ref}`)
    .where(
      and(
        eq(ledgerTransfers.tenantId, tenantId),
        eq(cycles.tenantId, tenantId),
        eq(cycles.status, 'settled'),
        inArray(ledgerTransfers.kind, [...HOUSE_FX_IN, ...HOUSE_FX_OUT]),
      ),
    )
    .groupBy(cycles.id, ledgerTransfers.currency)
    .having(sql`${FX_KEPT} <> 0`)
    .as('per_cycle');
  const [totals, newest] = await Promise.all([
    db
      .select({
        currency: perCycle.currency,
        amount: sql<string>`sum(${perCycle.amount})`,
        cycles: sql<number>`count(*)::int`,
      })
      .from(perCycle)
      .groupBy(perCycle.currency),
    db
      .select()
      .from(perCycle)
      .orderBy(desc(perCycle.at), desc(perCycle.cycleId))
      .limit(ROUNDING_REFS),
  ]);
  return new Map(
    totals.map((t) => {
      const refs = newest
        .filter((r) => r.currency === t.currency)
        .map((r) => ({ type: 'cycle' as const, id: r.cycleId, amount: BigInt(r.amount) }));
      return [t.currency, { amount: BigInt(t.amount), refs, more: t.cycles - refs.length }];
    }),
  );
}

/** Card captures credited to members that the card network has not yet paid over, by deal. */
async function cardsFronted(db: Tx, tenantId: string) {
  const rows = await db
    .select({
      dealId: cardPayments.dealId,
      rail: cardPayments.rail,
      currency: cardPayments.currency,
      amount: cardPayments.amount,
    })
    .from(cardPayments)
    .where(
      and(
        eq(cardPayments.tenantId, tenantId),
        eq(cardPayments.status, 'succeeded'),
        isNull(cardPayments.settledAt),
      ),
    );
  return rows.map((r) => ({
    type: 'deal' as const,
    id: r.dealId,
    rail: r.rail,
    currency: r.currency,
    amount: r.amount,
  }));
}

/**
 * Who recorded the opening in force, why, and who approved it: novate on its own at first boot,
 * two people after that.
 */
async function openingRecord(db: Tx, tenantId: string, rail: string) {
  const [e] = await db
    .select()
    .from(controlEvents)
    .where(
      and(
        eq(controlEvents.tenantId, tenantId),
        eq(controlEvents.type, 'opening_recorded'),
        sql`${controlEvents.payload}->>'rail' = ${rail}`,
      ),
    )
    .orderBy(...newestFirst(controlEvents.createdAt, controlEvents.id))
    .limit(1);
  if (!e) return null;
  const p = e.payload as { approvalId?: string; approvedBy?: ControlActor };
  return {
    at: e.createdAt,
    requestedBy: e.actor,
    reason: e.reason,
    approvalId: p.approvalId ?? null,
    approvedBy: p.approvedBy ?? null,
  };
}

/** Every break still open, of any age, oldest first. */
export async function openBreaks(tenantId: string) {
  const db = deps().db as unknown as Tx;
  const rows = await openBreakRows(db, tenantId);
  const owners = await breakAssignees(
    db,
    rows.map((b) => b.id),
  );
  const now = new Date();
  return rows.map((b) => {
    const owner = owners.get(b.id);
    return {
      ...breakView(b, undefined, now, rows),
      runId: b.runId,
      rail: b.rail,
      /** Who has taken it, from the latest assignment; null when nobody holds it. */
      assignee: owner?.assignee ?? null,
      assignedAt: owner?.assignee ? owner.createdAt : null,
    };
  });
}
