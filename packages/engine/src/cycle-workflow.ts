import { DBOS } from '@dbos-inc/dbos-sdk';
import { minBig } from '@novate/core';
import { cycles, deals, members, obligations, settlementInstructions, type Tx } from '@novate/db';
import { Accounts, type TransferInput } from '@novate/ledger';
import { type NettableObligation, type NettingMode, net } from '@novate/netting';
import type { RailResult } from '@novate/rails';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PolicySnapshot } from './deal-workflow.ts';
import { Topics } from './deal-workflow.ts';
import { deps, tx } from './deps.ts';
import { jsonSafe, record } from './repo.ts';

/** Internal rail: credit the member's wallet at the house instead of paying out externally. */
export const WALLET_RAIL = 'wallet';

type Instruction = typeof settlementInstructions.$inferSelect;

export interface CycleSummary {
  cycleId: string;
  status: 'settled' | 'failed' | 'empty';
  obligations: number;
  totals: Record<
    string,
    { gross: string; net: string; transfersGross: number; transfersNet: number }
  >;
  failures: { memberId: string; reason: string }[];
}

/**
 * One clearing cycle for a tenant: take every eligible obligation, net them, collect from net
 * debtors, then pay net creditors. Payouts never start until every collection has cleared.
 */
async function clearingCycle(tenantId: string, cycleId: string): Promise<CycleSummary> {
  const opened = await tx('net', (db) => openAndNet(db, tenantId, cycleId));
  if (!opened.obligations) {
    return { cycleId, status: 'empty', obligations: 0, totals: {}, failures: [] };
  }

  // Collections first.
  const failures: CycleSummary['failures'] = [];
  for (const ins of opened.instructions.filter((i) => i.direction === 'collect')) {
    const result = await executeOnRail(ins);
    await tx('collect_result', (db) => applyResult(db, ins, result));
    if (result.status !== 'confirmed') {
      const covered = await tx('cover_from_wallet', (db) =>
        coverFromWallet(db, ins, result.reason),
      );
      if (!covered)
        failures.push({ memberId: ins.memberId, reason: result.reason ?? 'collection failed' });
    }
  }
  if (failures.length) {
    await tx('fail', (db) => failCycle(db, tenantId, cycleId, failures));
    return {
      cycleId,
      status: 'failed',
      obligations: opened.obligations,
      totals: opened.totals,
      failures,
    };
  }

  // Then payouts.
  for (const ins of opened.instructions.filter((i) => i.direction === 'payout')) {
    const result =
      ins.rail === WALLET_RAIL
        ? ({ status: 'confirmed', externalRef: `wallet:${ins.id}` } as RailResult)
        : await executeOnRail(ins);
    await tx('payout_result', (db) => applyResult(db, ins, result));
    if (result.status !== 'confirmed')
      failures.push({ memberId: ins.memberId, reason: result.reason ?? 'payout failed' });
  }
  if (failures.length) {
    await tx('fail', (db) => failCycle(db, tenantId, cycleId, failures));
    return {
      cycleId,
      status: 'failed',
      obligations: opened.obligations,
      totals: opened.totals,
      failures,
    };
  }

  const dealIds = await tx('close', (db) => closeCycle(db, tenantId, cycleId, opened.totals));
  for (const dealId of dealIds) {
    await DBOS.send(dealId, { cycleId }, Topics.settled, `${cycleId}:${dealId}`);
  }
  return {
    cycleId,
    status: 'settled',
    obligations: opened.obligations,
    totals: opened.totals,
    failures,
  };
}

export const cycleWorkflow = DBOS.registerWorkflow(clearingCycle, { name: 'clearingCycle' });

async function executeOnRail(ins: Instruction): Promise<RailResult> {
  const rail = deps().rails.get(ins.rail);
  const member = await tx('rail_member', async (db) => {
    const [m] = await db.select().from(members).where(eq(members.id, ins.memberId));
    return { id: ins.memberId, railRefs: m?.railRefs ?? {} };
  });
  const req = {
    idempotencyKey: ins.idempotencyKey,
    member,
    currency: ins.currency,
    amount: ins.amount,
    reference: `novate cycle ${ins.cycleId}`,
  };
  let result = await DBOS.runStep(
    () => (ins.direction === 'collect' ? rail.collect(req) : rail.payout(req)),
    {
      name: `rail_${ins.direction}`,
      retriesAllowed: true,
      maxAttempts: 5,
    },
  );
  // Rails that confirm asynchronously: poll with durable sleeps.
  for (let attempt = 0; result.status === 'submitted' && attempt < 50; attempt++) {
    await DBOS.sleep(Math.min(60_000, 500 * 2 ** attempt));
    const ref = result.externalRef;
    result = await DBOS.runStep(() => rail.status(ref), { name: 'rail_status' });
  }
  return result;
}

async function openAndNet(db: Tx, tenantId: string, cycleId: string) {
  const { ledger } = deps();
  await db.insert(cycles).values({ id: cycleId, tenantId }).onConflictDoNothing();

  const rows = await db
    .select({ o: obligations, snapshot: deals.policySnapshot })
    .from(obligations)
    .innerJoin(deals, eq(deals.id, obligations.dealId))
    .where(and(eq(obligations.tenantId, tenantId), eq(obligations.status, 'eligible')))
    .for('update', { of: obligations, skipLocked: true });

  const groups = new Map<
    string,
    { rail: string; mode: NettingMode; items: NettableObligation[] }
  >();
  const transfers: TransferInput[] = [];
  for (const { o, snapshot } of rows) {
    const settlement = (snapshot as unknown as PolicySnapshot).resolved.policy.settlement;
    const escrow = Accounts.dealEscrow(o.dealId, o.currency);
    const held = await ledger.balance(db, tenantId, escrow);
    const prefunded = minBig(held, o.amount);
    const k = `${settlement.rail}|${settlement.netting}`;
    const g = groups.get(k) ?? { rail: settlement.rail, mode: settlement.netting, items: [] };
    g.items.push({
      id: o.id,
      payer: o.payerMemberId,
      payee: o.payeeMemberId,
      currency: o.currency,
      amount: o.amount,
      prefunded,
    });
    groups.set(k, g);

    const payer = Accounts.memberSettlement(o.payerMemberId, o.currency);
    const payee = Accounts.memberSettlement(o.payeeMemberId, o.currency);
    const clearing = Accounts.houseClearing(o.currency);
    const key = `cycle:${cycleId}:obligation:${o.id}`;
    if (prefunded > 0n) {
      transfers.push({
        key: `${key}:prefund`,
        debit: escrow,
        credit: payer,
        amount: prefunded,
        kind: 'escrow_apply',
        ref: o.dealId,
      });
    }
    // Novation: payer pays the house, the house pays the payee.
    transfers.push({
      key: `${key}:payer`,
      debit: payer,
      credit: clearing,
      amount: o.amount,
      kind: 'novation',
      ref: o.dealId,
    });
    transfers.push({
      key: `${key}:payee`,
      debit: clearing,
      credit: payee,
      amount: o.amount,
      kind: 'novation',
      ref: o.dealId,
    });
  }
  if (!rows.length) {
    await db
      .update(cycles)
      .set({ status: 'settled', closedAt: new Date(), summary: { obligations: 0 } })
      .where(eq(cycles.id, cycleId));
    return { obligations: 0, instructions: [] as Instruction[], totals: {} };
  }
  await ledger.post(db, tenantId, transfers);

  const ids = rows.map((r) => r.o.id);
  await db
    .update(obligations)
    .set({ status: 'netted', cycleId })
    .where(inArray(obligations.id, ids));
  await db
    .update(deals)
    .set({ status: 'settling' })
    .where(
      inArray(
        deals.id,
        rows.map((r) => r.o.dealId),
      ),
    );
  for (const { o } of rows) await record(db, o.dealId, 'netted', { cycleId });

  const payoutPrefs = new Map(
    (
      await db
        .select({ id: members.id, attributes: members.attributes })
        .from(members)
        .where(eq(members.tenantId, tenantId))
    ).map((m) => [
      m.id,
      (m.attributes as { payout?: string }).payout === 'wallet' ? 'wallet' : 'external',
    ]),
  );

  const values: (typeof settlementInstructions.$inferInsert)[] = [];
  const totals: CycleSummary['totals'] = {};
  for (const g of groups.values()) {
    const result = net(g.items, g.mode);
    for (const [ccy, t] of Object.entries(result.totals)) {
      const acc = totals[ccy] ?? { gross: '0', net: '0', transfersGross: 0, transfersNet: 0 };
      totals[ccy] = acc;
      acc.gross = (BigInt(acc.gross) + t.gross).toString();
      acc.net = (BigInt(acc.net) + t.net).toString();
      acc.transfersGross += t.transfersGross;
      acc.transfersNet += t.transfersNet;
    }
    for (const p of result.positions) {
      const base = { tenantId, cycleId, memberId: p.member, currency: p.currency };
      if (p.collect > 0n) {
        values.push({
          ...base,
          direction: 'collect',
          amount: p.collect,
          rail: g.rail,
          idempotencyKey: `${cycleId}:${g.rail}:${p.member}:${p.currency}:collect`,
        });
      }
      if (p.payout > 0n) {
        const rail = payoutPrefs.get(p.member) === 'wallet' ? WALLET_RAIL : g.rail;
        values.push({
          ...base,
          direction: 'payout',
          amount: p.payout,
          rail,
          idempotencyKey: `${cycleId}:${rail}:${p.member}:${p.currency}:payout`,
        });
      }
    }
  }
  const instructions = values.length
    ? await db.insert(settlementInstructions).values(values).returning()
    : [];
  await db
    .update(cycles)
    .set({ status: 'settling', summary: jsonSafe({ obligations: rows.length, totals }) })
    .where(eq(cycles.id, cycleId));
  return { obligations: rows.length, instructions, totals };
}

async function applyResult(db: Tx, ins: Instruction, result: RailResult) {
  await db
    .update(settlementInstructions)
    .set({
      status:
        result.status === 'confirmed'
          ? 'confirmed'
          : result.status === 'failed'
            ? 'failed'
            : 'submitted',
      externalRef: result.externalRef,
      failureReason: result.reason ?? null,
    })
    .where(eq(settlementInstructions.id, ins.id));
  if (result.status !== 'confirmed') return;

  const settlement = Accounts.memberSettlement(ins.memberId, ins.currency);
  const transfer: TransferInput =
    ins.direction === 'collect'
      ? {
          key: `instruction:${ins.id}`,
          debit: Accounts.houseCash(ins.rail, ins.currency),
          credit: settlement,
          amount: ins.amount,
          kind: 'collection',
          ref: ins.cycleId,
        }
      : ins.rail === WALLET_RAIL
        ? {
            key: `instruction:${ins.id}`,
            debit: settlement,
            credit: Accounts.memberAvailable(ins.memberId, ins.currency),
            amount: ins.amount,
            kind: 'wallet_credit',
            ref: ins.cycleId,
          }
        : {
            key: `instruction:${ins.id}`,
            debit: settlement,
            credit: Accounts.houseCash(ins.rail, ins.currency),
            amount: ins.amount,
            kind: 'payout',
            ref: ins.cycleId,
          };
  await deps().ledger.post(db, ins.tenantId, [transfer]);
}

/** First line of default handling: use the member's own wallet balance at the house. */
async function coverFromWallet(db: Tx, ins: Instruction, reason?: string): Promise<boolean> {
  const { ledger } = deps();
  const available = Accounts.memberAvailable(ins.memberId, ins.currency);
  if ((await ledger.balance(db, ins.tenantId, available)) < ins.amount) return false;
  await ledger.post(db, ins.tenantId, [
    {
      key: `instruction:${ins.id}:wallet`,
      debit: available,
      credit: Accounts.memberSettlement(ins.memberId, ins.currency),
      amount: ins.amount,
      kind: 'collection_from_wallet',
      ref: ins.cycleId,
    },
  ]);
  await db
    .update(settlementInstructions)
    .set({
      status: 'confirmed',
      externalRef: `wallet:${ins.id}`,
      failureReason: `rail failed (${reason ?? 'unknown'}); covered from wallet`,
    })
    .where(eq(settlementInstructions.id, ins.id));
  return true;
}

async function failCycle(
  db: Tx,
  tenantId: string,
  cycleId: string,
  failures: CycleSummary['failures'],
) {
  const memberIds = [...new Set(failures.map((f) => f.memberId))];
  await db
    .update(members)
    .set({ status: 'suspended' })
    .where(and(eq(members.tenantId, tenantId), inArray(members.id, memberIds)));
  await db
    .update(cycles)
    .set({
      status: 'failed',
      summary: sql`coalesce(${cycles.summary}, '{}'::jsonb) || ${JSON.stringify({ failures })}::jsonb`,
    })
    .where(eq(cycles.id, cycleId));
}

async function closeCycle(
  db: Tx,
  tenantId: string,
  cycleId: string,
  totals: CycleSummary['totals'],
): Promise<string[]> {
  const { ledger } = deps();
  const ins = await db
    .select()
    .from(settlementInstructions)
    .where(eq(settlementInstructions.cycleId, cycleId));
  const touched = new Set(ins.map((i) => `${i.memberId}|${i.currency}`));
  const netted = await db.select().from(obligations).where(eq(obligations.cycleId, cycleId));
  for (const o of netted) {
    touched.add(`${o.payerMemberId}|${o.currency}`);
    touched.add(`${o.payeeMemberId}|${o.currency}`);
  }
  for (const k of touched) {
    const [memberId, currency] = k.split('|') as [string, string];
    const bal = await ledger.balance(db, tenantId, Accounts.memberSettlement(memberId, currency));
    if (bal !== 0n)
      throw new Error(
        `Cycle ${cycleId} does not balance: member ${memberId} ${currency} settlement = ${bal}`,
      );
  }
  await db.update(obligations).set({ status: 'settled' }).where(eq(obligations.cycleId, cycleId));
  await db
    .update(cycles)
    .set({
      status: 'settled',
      closedAt: new Date(),
      summary: jsonSafe({ obligations: netted.length, totals }),
    })
    .where(eq(cycles.id, cycleId));
  return netted.map((o) => o.dealId);
}
