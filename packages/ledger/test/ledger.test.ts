import { randomUUID } from 'node:crypto';
import {
  createDb,
  createPool,
  ledgerAccounts,
  ledgerTransfers,
  type Tx,
  tenants,
} from '@novate/db';
import { runMigrations } from '@novate/db/migrate';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Accounts, PostgresLedger } from '../src/index.ts';

let pool: ReturnType<typeof createPool>;
let db: Tx;
let tenantId: string;
const ledger = new PostgresLedger();
const house = Accounts.houseCash('mock', 'EUR');
const wallet = (m: string) => Accounts.memberAvailable(m, 'EUR');
const feeSink = randomUUID();

beforeAll(async () => {
  await runMigrations();
  pool = createPool(process.env.DATABASE_URL as string);
  db = createDb(pool) as unknown as Tx;
  const [t] = await db.insert(tenants).values({ name: 'ledger-test' }).returning();
  tenantId = t?.id as string;
});
afterAll(() => pool.end());

const fund = (m: string, amount: bigint, key = randomUUID()) =>
  ledger.post(db, tenantId, [{ key, debit: house, credit: wallet(m), amount, kind: 'deposit' }]);

describe('ledger', () => {
  it('posts balanced entries on both sides', async () => {
    const m = randomUUID();
    await fund(m, 500n);
    expect(await ledger.balance(db, tenantId, wallet(m))).toBe(500n);
  });
  it('treats a repeated key as a no-op', async () => {
    const m = randomUUID();
    const key = randomUUID();
    await fund(m, 500n, key);
    expect((await fund(m, 500n, key)).posted).toBe(false);
    expect(await ledger.balance(db, tenantId, wallet(m))).toBe(500n);
  });
  it('posts once when the same key arrives from two places at the same moment', async () => {
    const m = randomUUID();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.transaction((t) =>
          ledger.post(t as unknown as Tx, tenantId, [
            { key, debit: house, credit: wallet(m), amount: 500n, kind: 'x' },
          ]),
        ),
      ),
    );
    expect(results.filter((r) => r.posted)).toHaveLength(1);
    expect(await ledger.balance(db, tenantId, wallet(m))).toBe(500n);
  });
  it('refuses to overdraw a protected account', async () => {
    const m = randomUUID();
    await fund(m, 100n);
    await expect(
      ledger.post(db, tenantId, [
        {
          key: randomUUID(),
          debit: wallet(m),
          credit: Accounts.memberAvailable(feeSink, 'EUR'),
          amount: 200n,
          kind: 'x',
        },
      ]),
    ).rejects.toThrow(/overdraw/);
    expect(await ledger.balance(db, tenantId, wallet(m))).toBe(100n);
  });
  it('refuses to cross currencies in one transfer', async () => {
    await expect(
      ledger.post(db, tenantId, [
        {
          key: randomUUID(),
          debit: house,
          credit: Accounts.memberAvailable(randomUUID(), 'GBP'),
          amount: 1n,
          kind: 'x',
        },
      ]),
    ).rejects.toThrow(/crosses/);
  });
  it('holds concurrent spends to what is there', async () => {
    const m = randomUUID();
    await fund(m, 100n);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        (db as unknown as { transaction: Tx['transaction'] }).transaction((t) =>
          ledger.post(t, tenantId, [
            {
              key: randomUUID(),
              debit: wallet(m),
              credit: Accounts.memberAvailable(feeSink, 'EUR'),
              amount: 40n,
              kind: 'x',
            },
          ]),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(await ledger.balance(db, tenantId, wallet(m))).toBe(20n);
  });
  it('keeps total debits equal to total credits', async () => {
    const [row] = await db
      .select({
        d: sql<string>`sum(${ledgerAccounts.debitsPosted})`,
        c: sql<string>`sum(${ledgerAccounts.creditsPosted})`,
      })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.tenantId, tenantId));
    expect(row?.d).toBe(row?.c);
  });
  it('finds accounts by kind and owner', async () => {
    const m = randomUUID();
    const deal = randomUUID();
    await fund(m, 300n);
    await ledger.post(db, tenantId, [
      {
        key: randomUUID(),
        debit: wallet(m),
        credit: Accounts.dealEscrow(deal, 'EUR'),
        amount: 100n,
        kind: 'escrow_lock',
      },
      {
        key: randomUUID(),
        debit: Accounts.memberDebt(m, 'EUR'),
        credit: Accounts.memberAvailable(m, 'EUR'),
        amount: 1n,
        kind: 'x',
      },
    ]);
    const mine = await ledger.balances(db, tenantId, { memberId: m });
    expect(mine.map((b) => [b.kind, b.balance]).sort()).toEqual([
      ['available', 201n],
      ['debt', -1n],
    ]);
    expect(await ledger.balances(db, tenantId, { memberId: m, positive: true })).toHaveLength(1);
    const [escrow] = await ledger.balances(db, tenantId, { dealIds: [deal], kinds: ['escrow'] });
    expect(escrow).toMatchObject({ dealId: deal, memberId: null, balance: 100n });
  });
  it('cannot be rewritten', async () => {
    await expect(
      db.delete(ledgerTransfers).where(eq(ledgerTransfers.tenantId, tenantId)),
    ).rejects.toThrow();
  });
});
