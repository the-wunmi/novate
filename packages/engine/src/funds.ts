import { DBOS } from '@dbos-inc/dbos-sdk';
import { Currency, DomainError, MinorAmount, parseInput } from '@novate/core';
import { cycles, deals, type Tx, unattributedDeposits } from '@novate/db';
import { type AccountSpec, Accounts, type TransferInput } from '@novate/ledger';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { railRefusal } from './deal-policy.ts';
import { deps, tryPost, tx } from './deps.ts';
import { memberInTenant } from './repo.ts';
import { Topics } from './topics.ts';

export const Deposit = z.object({
  memberId: z.string().uuid(),
  currency: Currency,
  amount: MinorAmount.refine((v) => v > 0n, { message: 'Amount must be positive' }),
  rail: z.string().min(1),
  externalRef: z.string().min(1),
});

/** One rail deposit is one ledger entry, however many times or in whatever order we hear of it. */
export const depositTransfer = (
  d: { rail: string; externalRef: string; currency: string; amount: bigint },
  credit: AccountSpec,
): TransferInput => ({
  key: `deposit:${d.rail}:${d.externalRef}`,
  debit: Accounts.houseCash(d.rail, d.currency),
  credit,
  amount: d.amount,
  kind: 'deposit',
  ref: d.externalRef,
});

/**
 * Record money arriving for a member. Idempotent on `externalRef`. Wakes the member's deals that
 * are waiting for funds, and any cycle waiting for a net debtor to send money in.
 */
export async function deposit(tenantId: string, input: z.input<typeof Deposit>): Promise<void> {
  const d = parseInput(Deposit, input);
  const refusal = railRefusal(tenantId, d.rail);
  if (refusal) throw new DomainError('invalid', refusal);
  const waiting = await tx('deposit', (db) => postDeposit(db, tenantId, d));
  await wakeFundsWaiters(waiting, d.externalRef);
}

/** Book a deposit inside the caller's transaction, and say whose work was waiting for it. */
export async function postDeposit(
  db: Tx,
  tenantId: string,
  d: z.output<typeof Deposit>,
): Promise<string[]> {
  await memberInTenant(db, tenantId, d.memberId);
  await deps().ledger.post(db, tenantId, [
    depositTransfer(d, Accounts.memberAvailable(d.memberId, d.currency)),
  ]);
  return fundsWaiters(db, tenantId, d.memberId);
}

/** Deals held up by this member's funds, and any cycle that could be waiting on it. */
async function fundsWaiters(db: Tx, tenantId: string, memberId: string): Promise<string[]> {
  const blocked = await db
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(
        eq(deals.tenantId, tenantId),
        eq(deals.status, 'awaiting_funding'),
        or(eq(deals.buyerMemberId, memberId), eq(deals.sellerMemberId, memberId)),
      ),
    );
  const settling = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(and(eq(cycles.tenantId, tenantId), eq(cycles.status, 'settling')));
  return [...blocked, ...settling].map((r) => r.id);
}

export async function wakeFundsWaiters(waiting: string[], externalRef: string) {
  for (const id of waiting) {
    await DBOS.send(id, { externalRef }, Topics.funds, `funds:${externalRef}:${id}`);
  }
}

export interface UnmatchedDeposit {
  rail: string;
  externalRef: string;
  depositAccountRef: string;
  currency: string;
  amount: bigint;
}

/**
 * Money with no member to credit still arrived, so the ledger has to show it. It waits in suspense
 * until an operator says whose it is, and reconciliation stays clean in the meantime.
 */
export async function holdUnmatchedDeposit(
  db: Tx,
  tenantId: string,
  d: UnmatchedDeposit,
): Promise<void> {
  await db
    .insert(unattributedDeposits)
    .values({ ...d, tenantId })
    .onConflictDoNothing();
  await deps().ledger.post(db, tenantId, [depositTransfer(d, Accounts.houseSuspense(d.currency))]);
}

export const unattributedDepositsOf = (tenantId: string) =>
  deps()
    .db.select()
    .from(unattributedDeposits)
    .where(
      and(eq(unattributedDeposits.tenantId, tenantId), eq(unattributedDeposits.status, 'open')),
    );

export const AssignDeposit = z.object({ memberId: z.string().uuid() });

/** Credit money held in suspense to the member it belongs to. */
export async function assignDeposit(
  tenantId: string,
  depositId: string,
  input: z.input<typeof AssignDeposit>,
): Promise<void> {
  const { memberId } = parseInput(AssignDeposit, input);
  const { waiting, externalRef } = await tx('deposit_assign', async (db) => {
    const [row] = await db
      .select()
      .from(unattributedDeposits)
      .where(
        and(eq(unattributedDeposits.id, depositId), eq(unattributedDeposits.tenantId, tenantId)),
      )
      .for('update');
    if (!row) throw new DomainError('not_found', 'Deposit not found');
    if (row.status !== 'open') throw new DomainError('conflict', 'Deposit is already assigned');
    await memberInTenant(db, tenantId, memberId);
    await deps().ledger.post(db, tenantId, [
      {
        key: `deposit_assignment:${row.id}`,
        debit: Accounts.houseSuspense(row.currency),
        credit: Accounts.memberAvailable(memberId, row.currency),
        amount: row.amount,
        kind: 'deposit_assignment',
        ref: row.externalRef,
      },
    ]);
    await db
      .update(unattributedDeposits)
      .set({ status: 'assigned', memberId })
      .where(eq(unattributedDeposits.id, row.id));
    return { waiting: await fundsWaiters(db, tenantId, memberId), externalRef: row.externalRef };
  });
  await wakeFundsWaiters(waiting, externalRef);
}

export const DefaultFundMovement = z.object({
  memberId: z.string().uuid(),
  currency: Currency,
  amount: MinorAmount.refine((v) => v > 0n, { message: 'Amount must be positive' }),
  /** Same key, same movement: a retry cannot move the money twice. */
  idempotencyKey: z.string().min(1),
});

async function moveDefaultFund(
  tenantId: string,
  direction: 'contribute' | 'withdraw',
  input: z.input<typeof DefaultFundMovement>,
): Promise<void> {
  const d = parseInput(DefaultFundMovement, input);
  await tx(`default_fund_${direction}`, async (db) => {
    await memberInTenant(db, tenantId, d.memberId);
    const wallet = Accounts.memberAvailable(d.memberId, d.currency);
    const fund = Accounts.memberDefaultFund(d.memberId, d.currency);
    const moved = await tryPost(db, tenantId, [
      {
        key: `default_fund:${direction}:${d.idempotencyKey}`,
        debit: direction === 'contribute' ? wallet : fund,
        credit: direction === 'contribute' ? fund : wallet,
        amount: d.amount,
        kind: `default_fund_${direction}`,
      },
    ]);
    if (!moved) throw new DomainError('insufficient_funds', 'Not enough to move');
  });
}

/** Commit money to the mutual default fund, which covers any member's default. */
export const contributeToDefaultFund = (
  tenantId: string,
  input: z.input<typeof DefaultFundMovement>,
) => moveDefaultFund(tenantId, 'contribute', input);

export const withdrawFromDefaultFund = (
  tenantId: string,
  input: z.input<typeof DefaultFundMovement>,
) => moveDefaultFund(tenantId, 'withdraw', input);

/** What every member holds in one kind of account, in any currency, where it is more than zero. */
export async function memberHoldings(db: Tx, tenantId: string, kind: string) {
  const accounts = await deps().ledger.balances(db, tenantId, 'member:');
  return accounts.flatMap((a) => {
    const [, memberId, currency, accountKind] = a.code.split(':') as [
      string,
      string,
      string,
      string,
    ];
    return accountKind === kind && a.balance > 0n
      ? [{ memberId, currency, amount: a.balance }]
      : [];
  });
}
