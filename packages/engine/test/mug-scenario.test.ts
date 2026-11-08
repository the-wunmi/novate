import { fromMajor } from '@novate/core';
import { runMigrations } from '@novate/db/migrate';
import { presetInputs } from '@novate/policy';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balances,
  createAgent,
  createMember,
  createTenant,
  dealDetail,
  decideApproval,
  deposit,
  launchEngine,
  pendingApprovals,
  publishProgram,
  runCycle,
  submitDeal,
  submitFact,
} from '../src/index.ts';

const eur = (v: string) => fromMajor(v, 'EUR');
const rail = new MockRail();
let engine: Awaited<ReturnType<typeof launchEngine>>;
let tenantId: string;
const ids = {} as Record<
  | 'brand'
  | 'supplier'
  | 'retailer'
  | 'brandBuyer'
  | 'brandSeller'
  | 'supplierAgent'
  | 'retailerAgent',
  string
>;

async function waitFor(dealId: string, statuses: string[], timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { deal } = await dealDetail(dealId);
    if (statuses.includes(deal.status)) return deal;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { deal, events } = await dealDetail(dealId);
  throw new Error(
    `deal ${dealId} stuck in ${deal.status}: ${events.map((e) => e.type).join(' → ')}`,
  );
}

const mugs = (quantity: number, unitPrice: string, shipmentDate = '2026-11-02') => ({
  category: 'homeware',
  currency: 'EUR',
  shipmentDate,
  lines: [
    { sku: 'MUG-CER-01', description: 'Ceramic mug, 350ml', quantity, unitPrice: eur(unitPrice) },
  ],
  attributes: { sellerListUnitPrice: Number(eur(unitPrice)) },
});

const shippingDocs = async (
  dealId: string,
  amount: string,
  quantity: number,
  shipmentDate: string,
) => {
  await submitFact(dealId, {
    kind: 'document',
    type: 'commercial_invoice',
    source: 'seller_agent',
    data: { fields: { amount: Number(eur(amount)), currency: 'EUR', quantity } },
  });
  await submitFact(dealId, {
    kind: 'document',
    type: 'packing_list',
    source: 'seller_agent',
    data: { fields: { quantity } },
  });
  await submitFact(dealId, {
    kind: 'document',
    type: 'bill_of_lading',
    source: 'carrier',
    data: { fields: { shipmentDate } },
  });
};

beforeAll(async () => {
  process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname);
  await runMigrations();
  engine = await launchEngine({
    rails: new RailRegistry().register(rail),
    appName: `novate-test-${Date.now()}`,
  });

  tenantId = (await createTenant({ name: 'Homeware marketplace' })).id;
  ids.brand = (
    await createMember({
      tenantId,
      name: 'Homeware brand',
      homeCurrency: 'GBP',
      attributes: { payout: 'wallet' },
    })
  ).id;
  ids.supplier = (
    await createMember({ tenantId, name: 'Portuguese ceramics supplier', homeCurrency: 'EUR' })
  ).id;
  ids.retailer = (await createMember({ tenantId, name: 'Dutch retailer', homeCurrency: 'EUR' })).id;

  ids.brandBuyer = (
    await createAgent({
      tenantId,
      memberId: ids.brand,
      name: 'Brand purchasing agent',
      mandate: {
        roles: ['buy'],
        currencies: ['EUR'],
        categories: ['homeware'],
        monthlyLimit: eur('20000'),
      },
    })
  ).id;
  ids.brandSeller = (
    await createAgent({
      tenantId,
      memberId: ids.brand,
      name: 'Brand sales agent',
      mandate: { roles: ['sell'], currencies: ['EUR'] },
    })
  ).id;
  ids.supplierAgent = (
    await createAgent({
      tenantId,
      memberId: ids.supplier,
      name: 'Supplier sales agent',
      mandate: { roles: ['sell'], currencies: ['EUR'] },
    })
  ).id;
  ids.retailerAgent = (
    await createAgent({
      tenantId,
      memberId: ids.retailer,
      name: 'Retailer buying agent',
      mandate: { roles: ['buy'], currencies: ['EUR'] },
    })
  ).id;

  await publishProgram({ tenantId, key: 'trade-assurance', spec: presetInputs.tradeAssurance });

  await deposit({
    tenantId,
    memberId: ids.brand,
    currency: 'EUR',
    amount: eur('15000'),
    externalRef: 'dep-brand-1',
  });
  await deposit({
    tenantId,
    memberId: ids.retailer,
    currency: 'EUR',
    amount: eur('9000'),
    externalRef: 'dep-retailer-1',
  });
  await deposit({
    tenantId,
    memberId: ids.supplier,
    currency: 'EUR',
    amount: eur('1000'),
    externalRef: 'dep-supplier-1',
  });
}, 60_000);

afterAll(async () => {
  await engine?.shutdown();
});

const available = async (memberId: string) =>
  (await balances(tenantId, memberId)).find((b) => b.code.endsWith(':EUR:available'))?.balance ??
  0n;

describe('mug scenario', () => {
  it('runs both deals through authority, funding, documents, inspection, netting and settlement', async () => {
    const buy = await submitDeal({
      tenantId,
      idempotencyKey: 'po-1001',
      programKey: 'trade-assurance',
      buyerMemberId: ids.brand,
      sellerMemberId: ids.supplier,
      buyerAgentId: ids.brandBuyer,
      sellerAgentId: ids.supplierAgent,
      terms: mugs(1_000, '14'),
    });
    const sell = await submitDeal({
      tenantId,
      idempotencyKey: 'so-2001',
      programKey: 'trade-assurance',
      buyerMemberId: ids.retailer,
      sellerMemberId: ids.brand,
      buyerAgentId: ids.retailerAgent,
      sellerAgentId: ids.brandSeller,
      terms: mugs(600, '15'),
    });

    await waitFor(buy.id, ['awaiting_conditions']);
    await waitFor(sell.id, ['awaiting_conditions']);
    // €14,000 held from the brand, 5% margin from the supplier.
    expect(await available(ids.brand)).toBe(eur('15000') - eur('14000') - eur('450'));
    expect(await available(ids.supplier)).toBe(eur('300'));

    // Supplier ships; the bill of lading is a day late — inside the 3-day tolerance.
    await shippingDocs(buy.id, '14000', 1_000, '2026-11-03');
    await submitFact(buy.id, {
      kind: 'inspection',
      type: 'third_party',
      source: 'inspector',
      data: { inspected: 1_000, passed: 920 },
    });
    const released = await waitFor(buy.id, ['eligible']);
    expect(released.releaseAmount).toBe(eur('12880'));

    await shippingDocs(sell.id, '9000', 600, '2026-11-02');
    await submitFact(sell.id, {
      kind: 'inspection',
      type: 'third_party',
      source: 'inspector',
      data: { passRate: 1 },
    });
    await waitFor(sell.id, ['eligible']);

    const cycle = await runCycle(tenantId);
    expect(cycle.status).toBe('settled');
    expect(cycle.obligations).toBe(2);
    await waitFor(buy.id, ['settled']);
    await waitFor(sell.id, ['settled']);

    // The brand paid €3,880 net for the week: 15,000 deposited, 11,120 left.
    expect(await available(ids.brand)).toBe(eur('11120'));
    // The supplier was paid €12,880 externally and got its margin back.
    expect(await available(ids.supplier)).toBe(eur('1000'));
    const payouts = rail.log.filter(
      (l) => l.direction === 'payout' && l.req.member.id === ids.supplier,
    );
    expect(payouts.map((p) => p.req.amount)).toEqual([eur('12880')]);
    // Retailer's prefunded €9,000 was used in full; nothing collected from anyone.
    expect(rail.log.filter((l) => l.direction === 'collect')).toHaveLength(0);
    expect(await available(ids.retailer)).toBe(0n);

    // Every cycle account is flat.
    for (const m of [ids.brand, ids.supplier, ids.retailer]) {
      const settlement = (await balances(tenantId, m)).find((b) => b.code.endsWith(':settlement'));
      expect(settlement?.balance ?? 0n).toBe(0n);
    }
  }, 60_000);

  it('rejects an order that breaks the purchasing agent mandate', async () => {
    const deal = await submitDeal({
      tenantId,
      idempotencyKey: 'po-1002',
      programKey: 'trade-assurance',
      buyerMemberId: ids.brand,
      sellerMemberId: ids.supplier,
      buyerAgentId: ids.brandBuyer,
      terms: mugs(10_000, '14'),
    });
    const done = await waitFor(deal.id, ['rejected']);
    expect(done.statusReason).toMatch(/monthly limit/);
  }, 30_000);

  it('freezes a 10x order for a person, and binds the decision to what they saw', async () => {
    await deposit({
      tenantId,
      memberId: ids.retailer,
      currency: 'EUR',
      amount: eur('90000'),
      externalRef: 'dep-retailer-2',
    });
    const deal = await submitDeal({
      tenantId,
      idempotencyKey: 'so-2002',
      programKey: 'trade-assurance',
      buyerMemberId: ids.retailer,
      sellerMemberId: ids.brand,
      buyerAgentId: ids.retailerAgent,
      terms: mugs(6_000, '15'),
    });
    await waitFor(deal.id, ['frozen']);

    const [pending] = (await pendingApprovals(tenantId)).filter((p) => p.deal.id === deal.id);
    expect(pending?.approval.reason).toMatch(/far larger/);
    await expect(
      decideApproval(pending!.approval.id, {
        bindingHash: 'stale',
        decision: { action: 'confirm' },
        decidedBy: 'owner',
      }),
    ).rejects.toThrow(/no longer matches/);

    await decideApproval(pending!.approval.id, {
      bindingHash: pending!.approval.bindingHash,
      decision: { action: 'cancel' },
      decidedBy: 'owner',
    });
    await waitFor(deal.id, ['cancelled']);
    expect(await available(ids.retailer)).toBe(eur('90000'));
  }, 30_000);

  it('holds a deal with a mismatch beyond tolerance until a person waives it', async () => {
    await deposit({
      tenantId,
      memberId: ids.retailer,
      currency: 'EUR',
      amount: eur('1500'),
      externalRef: 'dep-retailer-3',
    });
    const deal = await submitDeal({
      tenantId,
      idempotencyKey: 'so-2003',
      programKey: 'trade-assurance',
      buyerMemberId: ids.retailer,
      sellerMemberId: ids.brand,
      buyerAgentId: ids.retailerAgent,
      terms: mugs(100, '15'),
    });
    await waitFor(deal.id, ['awaiting_conditions']);
    await shippingDocs(deal.id, '1500', 100, '2026-11-09');
    await submitFact(deal.id, {
      kind: 'inspection',
      type: 'third_party',
      source: 'inspector',
      data: { passRate: 1 },
    });
    await waitFor(deal.id, ['held']);

    const [pending] = (await pendingApprovals(tenantId)).filter((p) => p.deal.id === deal.id);
    expect(pending?.approval.reason).toMatch(/7 day\(s\) after/);
    await decideApproval(pending!.approval.id, {
      bindingHash: pending!.approval.bindingHash,
      decision: { action: 'waive' },
      decidedBy: 'retailer-ops',
    });
    const done = await waitFor(deal.id, ['eligible']);
    expect(done.releaseAmount).toBe(eur('1500'));
  }, 30_000);

  it('waits for funding when the buyer is short, and resumes on deposit', async () => {
    const deal = await submitDeal({
      tenantId,
      idempotencyKey: 'so-2004',
      programKey: 'trade-assurance',
      buyerMemberId: ids.retailer,
      sellerMemberId: ids.brand,
      buyerAgentId: ids.retailerAgent,
      terms: mugs(1_000, '150'),
    });
    await waitFor(deal.id, ['awaiting_funding']);
    await deposit({
      tenantId,
      memberId: ids.retailer,
      currency: 'EUR',
      amount: eur('150000'),
      externalRef: 'dep-retailer-4',
    });
    await waitFor(deal.id, ['awaiting_conditions']);
    // €90,000 left from the cancelled order + €150,000 deposited − €150,000 now held.
    expect(await available(ids.retailer)).toBe(eur('90000'));
  }, 30_000);
});
