import { minBig, parseInput } from '@novate/core';
import {
  cycles,
  dealEvents,
  deals,
  fxConversions,
  ledgerAccounts,
  ledgerTransfers,
  members,
  settlementInstructions,
  type Tx,
} from '@novate/db';
import { type AnyColumn, and, eq, gte, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { moneyColumns } from './csv.ts';
import { deps } from './deps.ts';
import { isMemberFx, MEMBER_FX_KINDS, memberFxExchanges } from './member-fx.ts';
import { Cursor, keyset, newestFirst, pageOf } from './page.ts';
import {
  assertWholeExport,
  type CsvExport,
  EXPORT_MAX_ROWS,
  exportCsv,
  exportRange,
} from './population.ts';
import { impliedRateE8, rateLabel, rateString } from './rates.ts';
import { memberInTenant } from './repo.ts';

const PAGE_SIZE = 200;

export const StatementQuery = z.object({
  /** Start of the period, inclusive. */
  from: z.coerce.date().optional(),
  /** End of the period, exclusive. */
  to: z.coerce.date().optional(),
  /** Page back from here: the previous page's `next`. */
  before: Cursor.optional(),
});

export interface StatementLine {
  at: Date;
  /** What happened to the member, in its own terms. */
  kind: string;
  /** The ledger entry behind it. */
  transferKind: string;
  currency: string;
  /** Change in everything the house holds for the member, locked or not. */
  amount: bigint;
  /** Change in what the member is free to use or withdraw. */
  available: bigint;
  /** Everything held for the member in this currency after this line. */
  balance: bigint;
  /** What it is free to use after this line. */
  availableBalance: bigint;
  dealId: string | null;
  cycleId: string | null;
  counterpartyId: string | null;
  /** Deposit, transfer or conversion id on the rail. */
  externalRef: string | null;
  /** On a conversion, either leg: units of the bought currency per 1 of the sold one. */
  rate: string | null;
  /** The same rate in words, so its direction is plain: "1 GBP = 1.18846696 EUR". */
  rateLabel?: string | null;
  /** On a lock or release held in another currency than the deal's: the rate as quoted. */
  marketRate?: string | null;
  /** On such a lock or release: the FX buffer added on top of the market rate. */
  bufferBps?: number | null;
  /** On a payout: when the rail confirmed it. */
  valueDate: Date | null;
  /** On a netting offset: how much of what it owed was settled against what it was owed. */
  offset?: bigint;
}

export interface StatementBalance {
  currency: string;
  amount: bigint;
  available: bigint;
}

/** How each ledger entry reads to the member it belongs to. */
const KINDS: Record<string, string> = {
  deposit: 'deposit',
  deposit_assignment: 'deposit',
  deposit_reversal: 'deposit_reversal',
  deposit_reversal_shortfall: 'deposit_reversal',
  escrow_lock: 'lock',
  margin_lock: 'lock',
  margin_topup: 'lock',
  portfolio_margin_call: 'lock',
  escrow_refund: 'release',
  margin_release: 'release',
  portfolio_margin_release: 'release',
  collection_returned: 'release',
  collection: 'paid_in',
  collection_from_wallet: 'paid_from_wallet',
  wallet_credit: 'payout_to_wallet',
  payout_fallback_wallet: 'payout_to_wallet',
  payout_returned: 'payout_returned',
  withdrawal: 'withdrawal_requested',
  fx_member_sell: 'fx_conversion',
  fx_member_buy: 'fx_conversion',
  card_fee: 'fee',
  card_fee_shortfall: 'fee',
  platform_fee: 'fee',
  house_fee: 'fee',
  platform_fee_debt: 'fee',
  house_fee_debt: 'fee',
  claim_refund: 'claim_refund',
  claim_refund_shortfall: 'claim_refund',
  claim_payment: 'claim_payment',
  claim_payment_shortfall: 'claim_payment',
  margin_draw: 'margin_draw',
  margin_forfeit: 'margin_draw',
};

interface OwnedAccount {
  /** The member's free balance. */
  available: boolean;
  cycleId: string | null;
  /** On a deal's escrow or margin. */
  dealId: string | null;
}

interface Owned {
  accounts: Map<string, OwnedAccount>;
  deals: Map<string, { buyer: string; seller: string }>;
  /** The same accounts as a subquery, so a filter never lists them. */
  ids: SQL;
  /** Its free balances among them. */
  free: SQL;
}

/**
 * Everything held in the member's name: its own accounts, its position in each cycle, the escrow of
 * deals it buys and the margin of deals it sells.
 */
async function ownedAccounts(db: Tx, tenantId: string, memberId: string): Promise<Owned> {
  const party = (side: 'buyerMemberId' | 'sellerMemberId') =>
    db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.tenantId, tenantId), eq(deals[side], memberId)));
  const mineWhere = and(
    eq(ledgerAccounts.tenantId, tenantId),
    or(
      eq(ledgerAccounts.memberId, memberId),
      and(
        eq(ledgerAccounts.kind, 'escrow'),
        inArray(ledgerAccounts.dealId, party('buyerMemberId')),
      ),
      and(
        eq(ledgerAccounts.kind, 'margin'),
        inArray(ledgerAccounts.dealId, party('sellerMemberId')),
      ),
    ),
  );
  const idsWhere = (where: SQL | undefined) =>
    sql`(${db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where)})`;
  const [mine, rows] = await Promise.all([
    db
      .select({ id: deals.id, buyer: deals.buyerMemberId, seller: deals.sellerMemberId })
      .from(deals)
      .where(
        and(
          eq(deals.tenantId, tenantId),
          or(eq(deals.buyerMemberId, memberId), eq(deals.sellerMemberId, memberId)),
        ),
      ),
    db
      .select({
        id: ledgerAccounts.id,
        kind: ledgerAccounts.kind,
        cycleId: ledgerAccounts.cycleId,
        dealId: ledgerAccounts.dealId,
      })
      .from(ledgerAccounts)
      .where(mineWhere),
  ]);
  return {
    accounts: new Map(
      rows.map((r) => [
        r.id,
        { available: r.kind === 'available', cycleId: r.cycleId, dealId: r.dealId },
      ]),
    ),
    deals: new Map(mine.map((d) => [d.id, { buyer: d.buyer, seller: d.seller }])),
    ids: idsWhere(mineWhere),
    free: idsWhere(
      and(
        eq(ledgerAccounts.tenantId, tenantId),
        eq(ledgerAccounts.memberId, memberId),
        eq(ledgerAccounts.kind, 'available'),
      ),
    ),
  };
}

/** Where a run of the member's entries ends: before `to`, and past the entry `before` names. */
interface Bound {
  to?: Date;
  before?: string;
}

const bounded = (tenantId: string, b: Bound) => [
  b.to ? lt(ledgerTransfers.createdAt, b.to) : undefined,
  keyset(ledgerTransfers.createdAt, ledgerTransfers.id, tenantId, b.before),
];

/**
 * What was held for the member, per currency, from every entry up to each bound, in one pass over
 * its entries. A currency appears at a bound only once an entry in it falls inside that bound.
 */
async function balancesAt(
  db: Tx,
  tenantId: string,
  owned: Owned,
  bounds: Bound[],
): Promise<StatementBalance[][]> {
  if (!owned.accounts.size) return bounds.map(() => []);
  const inside = bounds.map((b) => and(...bounded(tenantId, b)) ?? sql`true`);
  const sum = (account: AnyColumn, accounts: SQL, cond: SQL) =>
    sql`coalesce(sum(${ledgerTransfers.amount}) filter (where ${account} in ${accounts} and ${cond}), 0)`;
  const signed = (accounts: SQL, cond: SQL) =>
    sql<string>`${sum(ledgerTransfers.creditAccountId, accounts, cond)} - ${sum(ledgerTransfers.debitAccountId, accounts, cond)}`;
  const columns = inside.flatMap((cond, i) => [
    [`seen${i}`, sql<boolean>`coalesce(bool_or(${cond}), false)`],
    [`amount${i}`, signed(owned.ids, cond)],
    [`available${i}`, signed(owned.free, cond)],
  ]);
  const rows: Record<string, unknown>[] = await db
    .select({ currency: ledgerTransfers.currency, ...Object.fromEntries(columns) })
    .from(ledgerTransfers)
    .where(and(eq(ledgerTransfers.tenantId, tenantId), touches(owned), or(...inside)))
    .groupBy(ledgerTransfers.currency);
  return bounds.map((_, i) =>
    rows.flatMap((r) =>
      r[`seen${i}`]
        ? [
            {
              currency: r.currency as string,
              amount: BigInt(r[`amount${i}`] as string),
              available: BigInt(r[`available${i}`] as string),
            },
          ]
        : [],
    ),
  );
}

const touches = (owned: Owned): SQL =>
  sql`(${ledgerTransfers.debitAccountId} in ${owned.ids} or ${ledgerTransfers.creditAccountId} in ${owned.ids})`;

/** The member's entries from `from` up to the bound, newest first, at most `limit` of them. */
function transfersIn(
  db: Tx,
  tenantId: string,
  owned: Owned,
  window: Bound & { from?: Date },
  limit: number,
) {
  return db
    .select()
    .from(ledgerTransfers)
    .where(
      and(
        eq(ledgerTransfers.tenantId, tenantId),
        touches(owned),
        window.from ? gte(ledgerTransfers.createdAt, window.from) : undefined,
        ...bounded(tenantId, window),
      ),
    )
    .orderBy(...newestFirst(ledgerTransfers.createdAt, ledgerTransfers.id))
    .limit(limit);
}

/**
 * The pair each FX leg belongs to, from the exchange its batch records: what the member sold and
 * what it bought with it.
 */
function fxPairs(rows: TransferRow[]) {
  const exchanges = memberFxExchanges(rows);
  const pairs = new Map<string, { sell: string; buy: string }>();
  for (const r of rows) {
    const e = exchanges.find((x) => x.batchId === r.batchId);
    if (e) pairs.set(r.id, { sell: e.sellCurrency, buy: e.buyCurrency });
  }
  return pairs;
}

/**
 * One page of a member's statement, newest first, for a period. Each line says what happened to the
 * member: proceeds and amounts owed per deal, gross, with what netting offset between them; FX with
 * its rate; payouts with the rail's transfer id and value date; deposits, locks, releases and fees.
 * Balances run per currency, and the period's opening and closing balances reconcile with the lines.
 */
export async function memberStatement(
  tenantId: string,
  memberId: string,
  input: z.input<typeof StatementQuery> = {},
) {
  const { from, to, before } = parseInput(StatementQuery, input);
  const { db } = deps();
  await memberInTenant(db, tenantId, memberId);
  const owned = await ownedAccounts(db, tenantId, memberId);
  const [[closingBalance = [], pageEnd = [], openingBalance = []], rows] = await Promise.all([
    balancesAt(db, tenantId, owned, [{ to }, { to, before }, ...(from ? [{ to: from }] : [])]),
    owned.accounts.size
      ? transfersIn(db, tenantId, owned, { from, to, before }, PAGE_SIZE + 1)
      : [],
  ]);
  const page = pageOf(rows, PAGE_SIZE, (r) => r.id);
  const lines = await describe(db, tenantId, owned, page.rows, memberId);
  runBalances(lines, pageEnd);
  return { lines, openingBalance, closingBalance, next: page.next };
}

type TransferRow = typeof ledgerTransfers.$inferSelect;

async function describe(
  db: Tx,
  tenantId: string,
  owned: Owned,
  rows: TransferRow[],
  memberId: string,
): Promise<StatementLine[]> {
  const instructionIds = [...new Set(rows.flatMap((r) => r.instructionId ?? []))];
  // A sale comes out of a deal's escrow, so its cycle is in its ref rather than its accounts.
  const cycleFor = (r: TransferRow) =>
    owned.accounts.get(r.debitAccountId)?.cycleId ??
    owned.accounts.get(r.creditAccountId)?.cycleId ??
    (isMemberFx(r.kind) ? r.ref : null);
  const cycleIds = [...new Set(rows.flatMap((r) => cycleFor(r) ?? []))];
  const fxCycles = [...new Set(rows.flatMap((r) => (isMemberFx(r.kind) && r.ref ? [r.ref] : [])))];
  // Every FX leg of the member's in those cycles, so a rate can be read from the whole exchange
  // even where the page holds only one side of it.
  const allLegs = fxCycles.length
    ? await db
        .select()
        .from(ledgerTransfers)
        .where(
          and(
            inArray(ledgerTransfers.ref, fxCycles),
            inArray(ledgerTransfers.kind, [...MEMBER_FX_KINDS]),
            touches(owned),
          ),
        )
    : [];
  const pairs = fxPairs(allLegs);
  const exchanged = new Map<string, { sold: bigint; bought: bigint }>();
  for (const leg of allLegs) {
    const pair = pairs.get(leg.id);
    if (!pair) continue;
    const key = `${leg.ref}:${pair.sell}:${pair.buy}`;
    const sum = exchanged.get(key) ?? { sold: 0n, bought: 0n };
    if (leg.kind === 'fx_member_sell') sum.sold += leg.amount;
    else sum.bought += leg.amount;
    exchanged.set(key, sum);
  }
  const [instructions, cycleRows, conversions, offsets] = await Promise.all([
    instructionIds.length
      ? db
          .select()
          .from(settlementInstructions)
          .where(inArray(settlementInstructions.id, instructionIds))
      : [],
    cycleIds.length
      ? db
          .select({ id: cycles.id, kind: cycles.kind })
          .from(cycles)
          .where(inArray(cycles.id, cycleIds))
      : [],
    cycleIds.length
      ? db
          .select()
          .from(fxConversions)
          .where(
            and(inArray(fxConversions.cycleId, cycleIds), eq(fxConversions.status, 'confirmed')),
          )
      : [],
    nettingOffsets(db, tenantId, memberId, cycleIds),
  ]);
  /** The house's conversion rate, or where the house matched members itself, what this one got. */
  const fxRateOf = (cycleId: string | null, pair: { sell: string; buy: string }) => {
    const market = conversions.find(
      (c) => c.cycleId === cycleId && c.sellCurrency === pair.sell && c.buyCurrency === pair.buy,
    );
    if (market) return { rateE8: market.rateE8, externalRef: market.externalRef };
    const sum = exchanged.get(`${cycleId}:${pair.sell}:${pair.buy}`);
    const implied = sum && impliedRateE8(sum.sold, pair.sell, sum.bought, pair.buy);
    return implied ? { rateE8: implied, externalRef: null } : null;
  };
  const lockFx = await lockRates(db, rows, owned);
  const instruction = new Map(instructions.map((i) => [i.id, i]));
  const withdrawals = new Set(cycleRows.filter((c) => c.kind === 'withdrawal').map((c) => c.id));

  const lines: StatementLine[] = [];
  for (const t of rows) {
    const debit = owned.accounts.get(t.debitAccountId);
    const credit = owned.accounts.get(t.creditAccountId);
    const amount = (credit ? t.amount : 0n) - (debit ? t.amount : 0n);
    const available = (credit?.available ? t.amount : 0n) - (debit?.available ? t.amount : 0n);
    // Money moving between two of its own locked places, such as escrow into a cycle, is not news.
    if (amount === 0n && available === 0n) continue;

    const cycleId = cycleFor(t);
    // A sale names the deal whose escrow it came out of.
    const dealId =
      t.ref && owned.deals.has(t.ref) ? t.ref : isMemberFx(t.kind) ? (debit?.dealId ?? null) : null;
    const parties = dealId ? owned.deals.get(dealId) : undefined;
    const ins = t.instructionId ? instruction.get(t.instructionId) : undefined;
    const pair = pairs.get(t.id);
    const fx = pair ? fxRateOf(cycleId, pair) : null;
    const line: StatementLine = {
      at: t.createdAt,
      kind: kindOf(t, Boolean(credit), cycleId !== null && withdrawals.has(cycleId)),
      transferKind: t.kind,
      currency: t.currency,
      amount,
      available,
      balance: 0n,
      availableBalance: 0n,
      dealId,
      cycleId,
      counterpartyId: parties
        ? parties.buyer === memberId
          ? parties.seller
          : parties.buyer
        : null,
      externalRef: ins?.externalRef ?? fx?.externalRef ?? (isDeposit(t.kind) ? t.ref : null),
      rate: fx ? rateString(fx.rateE8) : null,
      ...(isMemberFx(t.kind)
        ? { rateLabel: fx && pair ? rateLabel(pair.sell, pair.buy, fx.rateE8) : null }
        : {}),
      ...(dealId ? lockFx(t.kind, dealId) : {}),
      valueDate: ins?.status === 'confirmed' ? ins.updatedAt : null,
    };
    lines.push(line);
    const netted = offsets.get(t.id);
    if (netted) lines.push(offsetLine(line, netted));
  }
  return lines;
}

/** Which lock a ledger entry locks into or releases from. */
const LOCK_EVENTS: Record<string, 'escrow_locked' | 'margin_locked'> = {
  escrow_lock: 'escrow_locked',
  escrow_refund: 'escrow_locked',
  margin_lock: 'margin_locked',
  margin_topup: 'margin_locked',
  margin_release: 'margin_locked',
};

/**
 * How each converted lock on the page was sized, from the deal's lock event: the rate the member
 * paid, the market rate and the buffer. A release carries the rate of the lock it releases.
 */
async function lockRates(db: Tx, rows: TransferRow[], owned: Owned) {
  const dealIds = [
    ...new Set(
      rows.flatMap((r) => (LOCK_EVENTS[r.kind] && r.ref && owned.deals.has(r.ref) ? [r.ref] : [])),
    ),
  ];
  const events = dealIds.length
    ? await db
        .select({ dealId: dealEvents.dealId, type: dealEvents.type, payload: dealEvents.payload })
        .from(dealEvents)
        .where(
          and(
            inArray(dealEvents.dealId, dealIds),
            inArray(dealEvents.type, ['escrow_locked', 'margin_locked']),
          ),
        )
    : [];
  return (transferKind: string, dealId: string) => {
    const type = LOCK_EVENTS[transferKind];
    const p = type && events.find((e) => e.dealId === dealId && e.type === type)?.payload;
    if (!p || typeof p.rate !== 'string') return {};
    return {
      rate: p.rate,
      rateLabel: typeof p.rateLabel === 'string' ? p.rateLabel : null,
      marketRate: typeof p.marketRate === 'string' ? p.marketRate : null,
      bufferBps: typeof p.bufferBps === 'number' ? p.bufferBps : null,
    };
  };
}

const isDeposit = (kind: string) => kind.startsWith('deposit');

function kindOf(t: TransferRow, credited: boolean, withdrawal: boolean): string {
  if (t.kind === 'novation') return credited ? 'deal_proceeds' : 'amount_owed';
  if (t.kind === 'payout') return withdrawal ? 'withdrawal' : 'payout';
  return KINDS[t.kind] ?? t.kind;
}

/**
 * Where a member both owed and was owed in one cycle and currency, the smaller side was settled by
 * netting rather than by moving money. It is shown, at no amount, after the newest of those gross
 * lines, and summed over the whole cycle so a page boundary never splits it. Keyed by that line's
 * ledger entry.
 */
async function nettingOffsets(db: Tx, tenantId: string, memberId: string, cycleIds: string[]) {
  const offsets = new Map<string, bigint>();
  if (!cycleIds.length) return offsets;
  const rows = await db
    .select({
      owed: sql<string>`sum(case when ${ledgerTransfers.debitAccountId} = ${ledgerAccounts.id} then ${ledgerTransfers.amount} else 0 end)`,
      due: sql<string>`sum(case when ${ledgerTransfers.creditAccountId} = ${ledgerAccounts.id} then ${ledgerTransfers.amount} else 0 end)`,
      newest: sql<string>`(array_agg(${ledgerTransfers.id} order by ${ledgerTransfers.createdAt} desc, ${ledgerTransfers.id} desc))[1]`,
    })
    .from(ledgerTransfers)
    .innerJoin(
      ledgerAccounts,
      or(
        eq(ledgerAccounts.id, ledgerTransfers.debitAccountId),
        eq(ledgerAccounts.id, ledgerTransfers.creditAccountId),
      ),
    )
    .where(
      and(
        eq(ledgerTransfers.tenantId, tenantId),
        eq(ledgerTransfers.kind, 'novation'),
        eq(ledgerAccounts.tenantId, tenantId),
        eq(ledgerAccounts.memberId, memberId),
        inArray(ledgerAccounts.cycleId, cycleIds),
      ),
    )
    .groupBy(ledgerAccounts.cycleId, ledgerTransfers.currency);
  for (const r of rows) {
    const offset = minBig(BigInt(r.owed), BigInt(r.due));
    if (offset > 0n) offsets.set(r.newest, offset);
  }
  return offsets;
}

const offsetLine = (line: StatementLine, offset: bigint): StatementLine => ({
  ...line,
  kind: 'netting_offset',
  transferKind: 'netting',
  amount: 0n,
  available: 0n,
  dealId: null,
  counterpartyId: null,
  externalRef: null,
  rate: null,
  valueDate: null,
  offset,
});

/** Lines are newest first, so balances are walked back from where the page ends. */
function runBalances(lines: StatementLine[], closing: StatementBalance[]) {
  const total = new Map(closing.map((b) => [b.currency, b.amount]));
  const free = new Map(closing.map((b) => [b.currency, b.available]));
  for (const line of lines) {
    line.balance = total.get(line.currency) ?? 0n;
    line.availableBalance = free.get(line.currency) ?? 0n;
    total.set(line.currency, line.balance - line.amount);
    free.set(line.currency, line.availableBalance - line.available);
  }
}

/** The words the console shows for each kind of line. */
const DESCRIPTIONS: Record<string, string> = {
  deposit: 'Deposit received',
  deposit_reversal: 'Deposit reversed',
  lock: 'Locked for a deal',
  release: 'Released from a deal',
  deal_proceeds: 'Proceeds of a sale',
  amount_owed: 'Owed for a purchase',
  netting_offset: 'Offset by netting',
  fx_conversion: 'Currency converted',
  paid_in: 'Paid in for settlement',
  paid_from_wallet: 'Paid from balance',
  payout: 'Paid to your bank',
  payout_to_wallet: 'Payout kept in balance',
  payout_returned: 'Payout returned',
  withdrawal_requested: 'Withdrawal requested',
  withdrawal: 'Withdrawal',
  fee: 'Fee',
  claim_refund: 'Claim refunded',
  margin_draw: 'Paid from margin',
  opening_balance: 'Opening balance',
  closing_balance: 'Closing balance',
};

export const describeKind = (kind: string) => {
  const known = DESCRIPTIONS[kind];
  if (known) return known;
  const words = kind.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A short reference a person can read out, as the console shows it: DL-7F3A. */
export const dealRef = (dealId: string) =>
  `DL-${dealId.replaceAll('-', '').slice(0, 4).toUpperCase()}`;

/** Entries described at once, so the ids each batch looks up stay well inside a query's limits. */
const DESCRIBE_BATCH = 1_000;

/** A line of the spreadsheet: a statement line, or an opening or closing balance. */
interface CsvRow {
  at: Date;
  kind: string;
  currency: string;
  balance: bigint;
  availableBalance: bigint;
  line?: StatementLine;
}

/**
 * The whole period, oldest first, with signed amounts in each line's currency,
 * opened and closed with the balance in each currency. Without `from`, the last 31 days.
 */
export async function memberStatementCsv(
  tenantId: string,
  memberId: string,
  input?: { from?: unknown; to?: unknown },
): Promise<CsvExport> {
  const { range } = exportRange(input);
  const { db } = deps();
  await memberInTenant(db, tenantId, memberId);
  const owned = await ownedAccounts(db, tenantId, memberId);
  const [[opening = [], closing = []], transfers, names] = await Promise.all([
    balancesAt(db, tenantId, owned, [{ to: range.from }, { to: range.to }]),
    owned.accounts.size
      ? transfersIn(db, tenantId, owned, { from: range.from, to: range.to }, EXPORT_MAX_ROWS + 1)
      : [],
    db
      .select({ id: members.id, name: members.name })
      .from(members)
      .where(eq(members.tenantId, tenantId)),
  ]);
  assertWholeExport(transfers.length, range);
  const lines: StatementLine[] = [];
  for (let i = 0; i < transfers.length; i += DESCRIBE_BATCH) {
    lines.push(
      ...(await describe(db, tenantId, owned, transfers.slice(i, i + DESCRIBE_BATCH), memberId)),
    );
  }
  runBalances(lines, closing);
  lines.reverse();

  const name = new Map(names.map((m) => [m.id, m.name]));
  const currencies = [
    ...new Set(
      [...opening, ...closing].map((b) => b.currency).concat(lines.map((l) => l.currency)),
    ),
  ].sort();
  const balanceRows = (kind: string, at: Date, balances: StatementBalance[]): CsvRow[] =>
    currencies.map((currency) => {
      const b = balances.find((x) => x.currency === currency);
      return {
        at,
        kind,
        currency,
        balance: b?.amount ?? 0n,
        availableBalance: b?.available ?? 0n,
      };
    });
  const rows: CsvRow[] = [
    ...balanceRows('opening_balance', range.from, opening),
    ...lines.map((line) => ({
      at: line.at,
      kind: line.kind,
      currency: line.currency,
      balance: line.balance,
      availableBalance: line.availableBalance,
      line,
    })),
    ...balanceRows('closing_balance', range.to, closing),
  ];
  const money = (column: string, pick: (r: CsvRow) => bigint | undefined) =>
    moneyColumns<CsvRow>(column, pick, (r) => r.currency);
  return exportCsv<CsvRow>(
    [
      ['at', (r) => r.at],
      ['kind', (r) => r.kind],
      ['currency', (r) => r.currency],
      ...money('amount', (r) => r.line?.amount),
      ...money('available', (r) => r.line?.available),
      ...money('balance', (r) => r.balance),
      ...money('available_balance', (r) => r.availableBalance),
      ['deal_id', (r) => r.line?.dealId],
      ['cycle_id', (r) => r.line?.cycleId],
      ['counterparty_id', (r) => r.line?.counterpartyId],
      ['external_ref', (r) => r.line?.externalRef],
      ['rate', (r) => r.line?.rate],
      // Anything that moved money has a value date: the rail's, or failing that the posting date.
      [
        'value_date',
        ({ line: l }) =>
          l && (l.valueDate ?? (l.amount !== 0n || l.available !== 0n ? l.at : null)),
      ],
      ...money('offset', (r) => r.line?.offset),
      ['transfer_kind', (r) => r.line?.transferKind],
      ['deal_ref', (r) => (r.line?.dealId ? dealRef(r.line.dealId) : null)],
      [
        'counterparty_name',
        (r) => (r.line?.counterpartyId ? (name.get(r.line.counterpartyId) ?? null) : null),
      ],
      ['description', (r) => describeKind(r.kind)],
    ],
    rows,
    range,
  );
}
