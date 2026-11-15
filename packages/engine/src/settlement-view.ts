import { maxBig } from '@novate/core';
import {
  cycles,
  deals,
  ledgerAccounts,
  ledgerTransfers,
  members,
  obligations,
  programs,
  reconRuns,
  type Tx,
  tenants,
} from '@novate/db';
import { Accounts } from '@novate/ledger';
import { type NettingMode, net } from '@novate/netting';
import type { ProgramSpec } from '@novate/policy';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { deps } from './deps.ts';
import { nettingInput } from './netting-input.ts';
import { heldRails } from './recon-breaks.ts';
import { comparisonOf } from './reconciliation.ts';
import { memberInTenant } from './repo.ts';
import { nextRunAt } from './scheduler.ts';
import { parseGroup } from './settlement-group.ts';

/** Obligations no cycle has taken yet: accepted but not released, or released and waiting. */
const UNCLAIMED = ['pending', 'eligible'] as const;

const MAX_CYCLES = 50;

type Amounts = Map<string, bigint>;
const add = (m: Amounts, currency: string, amount: bigint) =>
  m.set(currency, (m.get(currency) ?? 0n) + amount);
const list = (m: Amounts) => [...m].map(([currency, amount]) => ({ currency, amount }));

/** A settlement group spelled out, with the program it belongs to. */
async function describeGroups(db: Tx, tenantId: string, groups: string[]) {
  const programIds = [...new Set(groups.map((g) => parseGroup(g).programId))];
  const [programRows, lastCycles] = await Promise.all([
    programIds.length
      ? db
          .select({
            id: programs.id,
            key: programs.key,
            version: programs.version,
            spec: programs.spec,
          })
          .from(programs)
          .where(inArray(programs.id, programIds))
      : Promise.resolve([]),
    groups.length
      ? db
          .selectDistinctOn([cycles.settlementGroup], {
            group: cycles.settlementGroup,
            at: cycles.createdAt,
          })
          .from(cycles)
          .where(and(eq(cycles.tenantId, tenantId), inArray(cycles.settlementGroup, groups)))
          .orderBy(cycles.settlementGroup, desc(cycles.createdAt))
      : Promise.resolve([]),
  ]);
  return (group: string) => {
    const { rail, netting, timing, programId } = parseGroup(group);
    const program = programRows.find((p) => p.id === programId);
    if (!program) throw new Error(`Program ${programId} is referenced but missing`);
    return {
      settlementGroup: {
        key: group,
        rail,
        netting,
        timing,
        program: {
          id: program.id,
          key: program.key,
          version: program.version,
          name: (program.spec as ProgramSpec).name,
        },
      },
      lastCycleAt: lastCycles.find((c) => c.group === group)?.at ?? null,
    };
  };
}

async function settlementStopped(db: Tx, tenantId: string) {
  const [t] = await db
    .select({ at: tenants.settlementHaltedAt, reason: tenants.settlementHaltReason })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return t?.at ? { at: t.at, reason: t.reason } : null;
}

/**
 * A member's settlement: its recent cycles with its net in each, and what is waiting to settle,
 * per settlement group, with when the scheduler will next run that group and, from the same
 * preview the house sees, what it would pay in after netting against what is free in its wallet.
 */
export async function memberSettlement(tenantId: string, memberId: string, now = new Date()) {
  const { db } = deps();
  await memberInTenant(db, tenantId, memberId);
  const party = or(
    eq(obligations.payerMemberId, memberId),
    eq(obligations.payeeMemberId, memberId),
  );
  const [recent, waiting, stopped] = await Promise.all([
    db
      .selectDistinct({
        id: cycles.id,
        status: cycles.status,
        createdAt: cycles.createdAt,
        closedAt: cycles.closedAt,
      })
      .from(cycles)
      .innerJoin(obligations, eq(obligations.cycleId, cycles.id))
      .where(and(eq(cycles.tenantId, tenantId), party))
      .orderBy(desc(cycles.createdAt))
      .limit(MAX_CYCLES),
    db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.tenantId, tenantId),
          isNull(obligations.cycleId),
          inArray(obligations.status, [...UNCLAIMED]),
          party,
        ),
      ),
    settlementStopped(db, tenantId),
  ]);
  const inCycles = recent.length
    ? await db
        .select()
        .from(obligations)
        .where(
          and(
            inArray(
              obligations.cycleId,
              recent.map((c) => c.id),
            ),
            party,
          ),
        )
    : [];
  const signed = (o: typeof obligations.$inferSelect) =>
    o.payeeMemberId === memberId ? o.amount : -o.amount;

  const groups = [...new Set(waiting.flatMap((o) => o.settlementGroup ?? []))];
  const [described, eligibleGroups, preview] = await Promise.all([
    describeGroups(db, tenantId, groups),
    groups.length
      ? db
          .selectDistinct({ group: obligations.settlementGroup })
          .from(obligations)
          .where(
            and(
              eq(obligations.tenantId, tenantId),
              eq(obligations.status, 'eligible'),
              inArray(obligations.settlementGroup, groups),
            ),
          )
      : Promise.resolve([]),
    groups.length ? settlementPreview(tenantId, now) : null,
  ]);
  const fundingOf = (group: string) =>
    (preview?.groups.find((g) => g.settlementGroup.key === group)?.positions ?? [])
      .filter((p) => p.memberId === memberId)
      .map((p) => ({
        currency: p.currency,
        payIn: p.payIn,
        receive: p.receive,
        free: p.walletAvailable,
        short: p.shortfall,
      }));
  return {
    cycles: recent.map((c) => {
      const netted: Amounts = new Map();
      for (const o of inCycles.filter((o) => o.cycleId === c.id))
        add(netted, o.currency, signed(o));
      return { ...c, net: list(netted) };
    }),
    upcoming: groups.map((group) => {
      const mine = waiting.filter((o) => o.settlementGroup === group);
      const payable: Amounts = new Map();
      const receivable: Amounts = new Map();
      const netted: Amounts = new Map();
      for (const o of mine) {
        add(o.payerMemberId === memberId ? payable : receivable, o.currency, o.amount);
        add(netted, o.currency, signed(o));
      }
      const { settlementGroup, lastCycleAt } = described(group);
      const eligible = eligibleGroups.some((g) => g.group === group);
      return {
        settlementGroup,
        // Nothing starts while settlement is stopped.
        nextRunAt: stopped ? null : nextRunAt(group, eligible, lastCycleAt, now),
        payable: list(payable),
        receivable: list(receivable),
        net: list(netted),
        /** Per currency, what it would pay in or receive if the group ran now, and any shortfall. */
        funding: fundingOf(group),
        deals: new Set(mine.map((o) => o.dealId)).size,
      };
    }),
  };
}

/** What a rail account held at the latest reconciliation that compared it, per currency. */
async function lastRailBalances(db: Tx, tenantId: string, rail: string) {
  const [run] = await db
    .select({ at: reconRuns.createdAt, summary: reconRuns.summary })
    .from(reconRuns)
    .where(
      and(
        eq(reconRuns.tenantId, tenantId),
        eq(reconRuns.rail, rail),
        inArray(reconRuns.status, ['clean', 'breaks']),
      ),
    )
    .orderBy(desc(reconRuns.createdAt))
    .limit(1);
  const positions = run ? comparisonOf(run.summary).positions : [];
  return {
    at: run?.at ?? null,
    of: (currency: string) => {
      const p = positions.find((x) => x.currency === currency);
      return p ? BigInt(p.rail) : run ? 0n : null;
    },
  };
}

/**
 * What each settlement group's next cycle would do if it ran now: per member and currency what it
 * pays in and receives after netting, computed by the same netting as the cycle, whether its free
 * balance covers what it owes, and per currency whether the rail holds enough for the payouts.
 * Obligations not yet released and deals held back by a suspended member are counted, not netted.
 */
export async function settlementPreview(tenantId: string, now = new Date()) {
  const { db, ledger } = deps();
  const [rows, memberRows, stopped, railsHeld] = await Promise.all([
    db
      .select({ o: obligations, d: deals })
      .from(obligations)
      .innerJoin(deals, eq(deals.id, obligations.dealId))
      .where(
        and(
          eq(obligations.tenantId, tenantId),
          isNull(obligations.cycleId),
          inArray(obligations.status, [...UNCLAIMED]),
        ),
      ),
    db.select().from(members).where(eq(members.tenantId, tenantId)),
    settlementStopped(db, tenantId),
    heldRails(db, tenantId),
  ]);
  const suspended = new Set(memberRows.filter((m) => m.status === 'suspended').map((m) => m.id));
  const toWallet = new Set(
    memberRows
      .filter((m) => (m.attributes as { payout?: string }).payout === 'wallet')
      .map((m) => m.id),
  );
  const nameOf = (id: string) => memberRows.find((m) => m.id === id)?.name ?? null;
  const groups = [...new Set(rows.flatMap((r) => r.o.settlementGroup ?? []))];
  const described = await describeGroups(db, tenantId, groups);
  const railBalances = new Map<string, Awaited<ReturnType<typeof lastRailBalances>>>();

  const out = [];
  for (const group of groups) {
    const inGroup = rows.filter((r) => r.o.settlementGroup === group);
    const held = new Set(
      inGroup
        .filter(({ o }) => suspended.has(o.payerMemberId) || suspended.has(o.payeeMemberId))
        .map(({ o }) => o.dealId),
    );
    const eligible = inGroup.filter(({ o }) => o.status === 'eligible' && !held.has(o.dealId));
    const { settlementGroup, lastCycleAt } = described(group);
    const mode = settlementGroup.netting as NettingMode;

    const { items, collateral } = await nettingInput(db, tenantId, eligible);
    const result = net(items, mode);
    const wallets = await ledger.balances(db, tenantId, {
      kinds: ['available'],
      memberIds: [...new Set(result.positions.map((p) => p.member))],
    });
    const walletOf = new Map(wallets.map((w) => [w.code, w.balance]));

    const positions = result.positions.map((p) => {
      const wallet = walletOf.get(Accounts.memberAvailable(p.member, p.currency).code) ?? 0n;
      return {
        memberId: p.member,
        name: nameOf(p.member),
        currency: p.currency,
        payable: p.payable,
        receivable: p.receivable,
        net: p.net,
        prefunded: p.prefunded,
        payIn: p.collect,
        receive: p.payout,
        paidTo: toWallet.has(p.member) ? ('wallet' as const) : ('rail' as const),
        walletAvailable: wallet,
        shortfall: maxBig(p.collect - wallet, 0n),
      };
    });

    const rail = settlementGroup.rail;
    if (!railBalances.has(rail)) railBalances.set(rail, await lastRailBalances(db, tenantId, rail));
    const onRail = railBalances.get(rail) as Awaited<ReturnType<typeof lastRailBalances>>;
    const currencies = [...new Set(positions.map((p) => p.currency))].map((currency) => {
      const here = positions.filter((p) => p.currency === currency);
      const payouts = here
        .filter((p) => p.paidTo === 'rail')
        .reduce((acc, p) => acc + p.receive, 0n);
      const railBalance = onRail.of(currency);
      return {
        currency,
        payIn: here.reduce((acc, p) => acc + p.payIn, 0n),
        payInShortfall: here.reduce((acc, p) => acc + p.shortfall, 0n),
        payouts,
        toWallets: here
          .filter((p) => p.paidTo === 'wallet')
          .reduce((acc, p) => acc + p.receive, 0n),
        railBalance,
        railBalanceAt: onRail.at,
        railShortfall: railBalance === null ? null : maxBig(payouts - railBalance, 0n),
      };
    });

    const railHeld = railsHeld.find((h) => h.rail === rail) ?? null;
    out.push({
      settlementGroup,
      nextRunAt:
        stopped || railHeld ? null : nextRunAt(group, eligible.length > 0, lastCycleAt, now),
      /** Open reconciliation differences on this group's rail: nothing settles on it until closed. */
      railHeld,
      obligations: eligible.length,
      deals: new Set(eligible.map(({ o }) => o.dealId)).size,
      notYetReleased: inGroup.filter(({ o }) => o.status === 'pending').length,
      heldForSuspendedMembers: held.size,
      positions,
      foreignCollateral: collateral.map((c) => ({
        memberId: c.member,
        currency: c.currency,
        amount: c.amount,
      })),
      currencies,
    });
  }
  return { at: now, settlementStopped: stopped, heldRails: railsHeld, groups: out };
}

/**
 * The mutual default fund as the ledger has it: what each member has in it, what each put in and
 * took out, every draw a default made on it, and the rest of the waterfall in each currency.
 */
export async function defaultFund(tenantId: string) {
  const { db } = deps();
  const debit = alias(ledgerAccounts, 'debit');
  const credit = alias(ledgerAccounts, 'credit');
  const [moves, memberRows] = await Promise.all([
    db
      .select({
        at: ledgerTransfers.createdAt,
        kind: ledgerTransfers.kind,
        ref: ledgerTransfers.ref,
        currency: ledgerTransfers.currency,
        amount: ledgerTransfers.amount,
        debitMember: debit.memberId,
        creditMember: credit.memberId,
      })
      .from(ledgerTransfers)
      .innerJoin(debit, eq(debit.id, ledgerTransfers.debitAccountId))
      .innerJoin(credit, eq(credit.id, ledgerTransfers.creditAccountId))
      .where(
        and(
          eq(ledgerTransfers.tenantId, tenantId),
          inArray(ledgerTransfers.kind, [
            'default_fund_contribute',
            'default_fund_withdraw',
            'default_fund_draw',
            'default_margin_draw',
            'default_portfolio_margin',
            'default_loss',
          ]),
        ),
      )
      .orderBy(desc(ledgerTransfers.createdAt)),
    db
      .select({ id: members.id, name: members.name, homeCurrency: members.homeCurrency })
      .from(members)
      .where(eq(members.tenantId, tenantId)),
  ]);
  const contributions = new Map<
    string,
    {
      memberId: string;
      name: string | null;
      currency: string;
      contributed: bigint;
      withdrawn: bigint;
      drawn: bigint;
      balance: bigint;
    }
  >();
  const row = (memberId: string, currency: string) => {
    const key = `${memberId}:${currency}`;
    const found = contributions.get(key) ?? {
      memberId,
      name: memberRows.find((m) => m.id === memberId)?.name ?? null,
      currency,
      contributed: 0n,
      withdrawn: 0n,
      drawn: 0n,
      balance: 0n,
    };
    contributions.set(key, found);
    return found;
  };
  const waterfall = new Map<
    string,
    {
      currency: string;
      dealMargin: bigint;
      portfolioMargin: bigint;
      defaultFund: bigint;
      house: bigint;
    }
  >();
  const step = (currency: string) => {
    const found = waterfall.get(currency) ?? {
      currency,
      dealMargin: 0n,
      portfolioMargin: 0n,
      defaultFund: 0n,
      house: 0n,
    };
    waterfall.set(currency, found);
    return found;
  };
  const draws = [];
  for (const m of moves) {
    // A member's fund account is the credit of a contribution and the debit of a withdrawal or draw.
    if (m.kind === 'default_fund_contribute') {
      row(m.creditMember as string, m.currency).contributed += m.amount;
    }
    if (m.kind === 'default_fund_withdraw') {
      row(m.debitMember as string, m.currency).withdrawn += m.amount;
    }
    if (m.kind === 'default_margin_draw') step(m.currency).dealMargin += m.amount;
    if (m.kind === 'default_portfolio_margin') step(m.currency).portfolioMargin += m.amount;
    if (m.kind === 'default_loss') step(m.currency).house += m.amount;
    if (m.kind === 'default_fund_draw') {
      const contributor = m.debitMember as string;
      row(contributor, m.currency).drawn += m.amount;
      step(m.currency).defaultFund += m.amount;
      // A draw is paid into the defaulter's position in the cycle.
      const defaulter = m.creditMember;
      draws.push({
        at: m.at,
        cycleId: m.ref,
        currency: m.currency,
        amount: m.amount,
        defaulterId: defaulter,
        defaulterName: memberRows.find((x) => x.id === defaulter)?.name ?? null,
        contributorId: contributor,
        contributorName: memberRows.find((x) => x.id === contributor)?.name ?? null,
      });
    }
  }
  // What each member has in the fund now, from its account rather than added up here.
  for (const a of await deps().ledger.balances(db, tenantId, { kinds: ['default_fund'] })) {
    row(a.memberId as string, a.currency).balance = a.balance;
  }
  // Every currency members trade in has a fund, so an empty one still says which it is.
  const balances: Amounts = new Map(memberRows.map((m) => [m.homeCurrency, 0n]));
  for (const c of contributions.values()) add(balances, c.currency, c.balance);
  return {
    balances: list(balances),
    contributions: [...contributions.values()],
    draws,
    /** Each default's losses by who bore them, in order: deal margin, portfolio margin, fund, house. */
    waterfall: [...waterfall.values()],
  };
}
