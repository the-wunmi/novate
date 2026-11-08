import { randomUUID } from 'node:crypto';
import { type Currency, DomainError } from '@novate/core';
import { ledgerAccounts, ledgerTransfers, type Tx } from '@novate/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AccountSpec } from './accounts.ts';

export interface TransferInput {
  /** Unique per tenant. Re-posting the same keys is a no-op, which makes retries safe. */
  key: string;
  debit: AccountSpec;
  credit: AccountSpec;
  amount: bigint;
  kind: string;
  ref?: string;
}

export interface PostResult {
  batchId: string;
  /** False when every transfer in the batch had already been posted. */
  posted: boolean;
}

export interface Balance {
  code: string;
  currency: Currency;
  debitsPosted: bigint;
  creditsPosted: bigint;
  /** Signed balance on the account's normal side. */
  balance: bigint;
}

/**
 * Double-entry ledger. Implementations must post a batch atomically and idempotently and must
 * reject any transfer that would overdraw a no-overdraft account. Postgres is the default; the
 * interface is shaped so a TigerBeetle implementation can replace it.
 */
export interface Ledger {
  post(tx: Tx, tenantId: string, transfers: TransferInput[]): Promise<PostResult>;
  balance(tx: Tx, tenantId: string, account: AccountSpec): Promise<bigint>;
  balances(tx: Tx, tenantId: string, codePrefix: string): Promise<Balance[]>;
}

const OVERDRAFT_CONSTRAINT = 'ledger_accounts_overdraft';

export class PostgresLedger implements Ledger {
  async post(tx: Tx, tenantId: string, transfers: TransferInput[]): Promise<PostResult> {
    if (transfers.length === 0) return { batchId: randomUUID(), posted: false };
    for (const t of transfers) {
      if (t.amount <= 0n) throw new DomainError('invalid', `Transfer ${t.key} must be positive`);
      if (t.debit.currency !== t.credit.currency) {
        throw new DomainError('invalid', `Transfer ${t.key} crosses currencies`);
      }
    }

    const keys = transfers.map((t) => t.key);
    const existing = await tx
      .select({ key: ledgerTransfers.idempotencyKey, batchId: ledgerTransfers.batchId })
      .from(ledgerTransfers)
      .where(
        and(eq(ledgerTransfers.tenantId, tenantId), inArray(ledgerTransfers.idempotencyKey, keys)),
      );
    if (existing.length === keys.length && existing[0]) {
      return { batchId: existing[0].batchId, posted: false };
    }
    if (existing.length > 0) {
      throw new DomainError('conflict', 'Batch partially posted under a different batch', {
        existing: existing.map((e) => e.key),
      });
    }

    const specs = new Map<string, AccountSpec>();
    for (const t of transfers) {
      specs.set(t.debit.code, t.debit);
      specs.set(t.credit.code, t.credit);
    }
    const ids = await this.#ensureAccounts(tx, tenantId, [...specs.values()]);

    // Lock touched accounts in a stable order so concurrent batches cannot deadlock.
    const lockOrder = [...ids.values()].sort();
    await tx.execute(
      sql`SELECT id FROM ledger_accounts WHERE id IN (${sql.join(
        lockOrder.map((id) => sql`${id}`),
        sql`, `,
      )}) ORDER BY id FOR UPDATE`,
    );

    const batchId = randomUUID();
    await tx.insert(ledgerTransfers).values(
      transfers.map((t) => ({
        tenantId,
        batchId,
        idempotencyKey: t.key,
        debitAccountId: ids.get(t.debit.code) as string,
        creditAccountId: ids.get(t.credit.code) as string,
        currency: t.debit.currency,
        amount: t.amount,
        kind: t.kind,
        ref: t.ref ?? null,
      })),
    );

    const deltas = new Map<string, { debits: bigint; credits: bigint }>();
    for (const t of transfers) {
      const d = ids.get(t.debit.code) as string;
      const c = ids.get(t.credit.code) as string;
      const dd = deltas.get(d) ?? { debits: 0n, credits: 0n };
      dd.debits += t.amount;
      deltas.set(d, dd);
      const cd = deltas.get(c) ?? { debits: 0n, credits: 0n };
      cd.credits += t.amount;
      deltas.set(c, cd);
    }

    try {
      for (const [id, delta] of deltas) {
        await tx
          .update(ledgerAccounts)
          .set({
            debitsPosted: sql`${ledgerAccounts.debitsPosted} + ${delta.debits}`,
            creditsPosted: sql`${ledgerAccounts.creditsPosted} + ${delta.credits}`,
          })
          .where(eq(ledgerAccounts.id, id));
      }
    } catch (err) {
      if (constraintOf(err) === OVERDRAFT_CONSTRAINT) {
        throw new DomainError('insufficient_funds', 'Transfer would overdraw an account', {
          transfers: keys,
        });
      }
      throw err;
    }

    return { batchId, posted: true };
  }

  async balance(tx: Tx, tenantId: string, account: AccountSpec): Promise<bigint> {
    const [row] = await tx
      .select()
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.code, account.code)));
    if (!row) return 0n;
    return toBalance(row).balance;
  }

  async balances(tx: Tx, tenantId: string, codePrefix: string): Promise<Balance[]> {
    const rows = await tx
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          sql`${ledgerAccounts.code} LIKE ${`${codePrefix}%`}`,
        ),
      );
    return rows.map(toBalance);
  }

  async #ensureAccounts(
    tx: Tx,
    tenantId: string,
    specs: AccountSpec[],
  ): Promise<Map<string, string>> {
    await tx
      .insert(ledgerAccounts)
      .values(
        specs.map((s) => ({
          tenantId,
          code: s.code,
          currency: s.currency,
          normal: s.normal,
          noOverdraft: s.noOverdraft ? 1 : 0,
        })),
      )
      .onConflictDoNothing({ target: [ledgerAccounts.tenantId, ledgerAccounts.code] });
    const rows = await tx
      .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.tenantId, tenantId),
          inArray(
            ledgerAccounts.code,
            specs.map((s) => s.code),
          ),
        ),
      );
    return new Map(rows.map((r) => [r.code, r.id]));
  }
}

function toBalance(row: typeof ledgerAccounts.$inferSelect): Balance {
  const balance =
    row.normal === 'credit'
      ? row.creditsPosted - row.debitsPosted
      : row.debitsPosted - row.creditsPosted;
  return {
    code: row.code,
    currency: row.currency,
    debitsPosted: row.debitsPosted,
    creditsPosted: row.creditsPosted,
    balance,
  };
}

function constraintOf(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e === 'object' && e && 'constraint' in e) return String(e.constraint);
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}
