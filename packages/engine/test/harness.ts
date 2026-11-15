import { randomUUID } from 'node:crypto';
import { fromMajor, type Principal } from '@novate/core';
import { dealEvents, deals } from '@novate/db';
import { runMigrations } from '@novate/db/migrate';
import { type DecisionAgent, type ProgramSpecInput, presetInputs } from '@novate/policy';
import { type MockRail, RailRegistry, type SettlementRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import {
  balances,
  createAgent,
  createMember,
  createTenant,
  type DeliveredNotification,
  deposit,
  type Engine,
  launchEngine,
  openCases,
  publishProgram,
  submitDeal,
  submitFact,
} from '../src/index.ts';

export const eur = (v: string) => fromMajor(v, 'EUR');
export const gbp = (v: string) => fromMajor(v, 'GBP');

let engine: Engine;

/** One agent the test can swap, because DBOS allows a single launch per process. */
export const brain: { current?: DecisionAgent } = {};
const swappable: DecisionAgent = {
  name: 'test-brain',
  decide: (view, prior) => {
    if (!brain.current) throw new Error('no agent configured');
    return brain.current.decide(view, prior);
  },
};

export const notified: DeliveredNotification[] = [];
/** How many deliveries to refuse before accepting, to exercise retries. */
export const notifierOutage = { remaining: 0 };

export async function boot(
  rail: SettlementRail,
  extra: SettlementRail[] = [],
  options: Partial<Parameters<typeof launchEngine>[0]> = {},
) {
  process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname);
  await runMigrations();
  const rails = new RailRegistry().register(rail);
  for (const r of extra) rails.register(r);
  engine = await launchEngine({
    rails,
    appName: `novate-test-${Date.now()}`,
    decisionAgent: swappable,
    ...options,
    notifier: {
      async deliver(notification) {
        if (notifierOutage.remaining > 0) {
          notifierOutage.remaining--;
          throw new Error('receiver is down');
        }
        notified.push(notification);
      },
    },
  });
  return engine;
}

export const shutdown = () => engine?.shutdown();

const peek = async (dealId: string) => {
  const [deal] = await engine.db.select().from(deals).where(eq(deals.id, dealId));
  return deal as typeof deals.$inferSelect;
};

export async function waitFor(dealId: string, statuses: string[], timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const deal = await peek(dealId);
    if (statuses.includes(deal.status)) return deal;
    await new Promise((r) => setTimeout(r, 50));
  }
  const deal = await peek(dealId);
  const events = await engine.db.select().from(dealEvents).where(eq(dealEvents.dealId, dealId));
  throw new Error(`deal stuck in ${deal.status}: ${events.map((e) => e.type).join(' > ')}`);
}

export async function waitForCase(tenantId: string, dealId: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = (await openCases(tenantId)).find((c) => c.dealId === dealId);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no open case');
}

export interface World {
  tenantId: string;
  rail: MockRail;
  brand: string;
  supplier: string;
  retailer: string;
  brandBuyer: string;
  brandSeller: string;
  supplierAgent: string;
  retailerAgent: string;
  platform: Principal;
  inspector: Principal;
  carrier: Principal;
  asMember: (memberId: string) => Principal;
  fund: (memberId: string, currency: string, amount: bigint) => Promise<void>;
  available: (memberId: string, currency: string) => Promise<bigint>;
  deal: (o: DealOptions) => ReturnType<typeof submitDeal>;
  pass: (dealId: string, o: PassOptions) => Promise<void>;
}

interface DealOptions {
  program?: string;
  buyer: 'brand' | 'retailer';
  seller: 'brand' | 'supplier';
  quantity: number;
  price: string;
  key?: string;
  /** Submit as this credential instead of the platform. */
  as?: Principal;
  extra?: Record<string, unknown>;
}

interface PassOptions {
  amount: bigint;
  quantity: number;
  shipped?: string;
  pass?: { inspected: number; passed: number } | { passRate: number };
}

/** Templates name the real rail. A test runs them on whichever rail it booted. */
export const onThisRail = (spec: ProgramSpecInput, rail: Pick<SettlementRail, 'name'>) =>
  spec.settlement.rail === 'airwallex'
    ? { ...spec, settlement: { ...spec.settlement, rail: rail.name } }
    : spec;

export async function makeWorld(
  rail: MockRail,
  programs: Record<string, ProgramSpecInput> = { 'trade-assurance': presetInputs.tradeAssurance },
  limits: { monthlyLimit?: bigint } = {},
): Promise<World> {
  const tenantId = (await createTenant({ name: `t-${randomUUID()}` })).tenant.id;
  const member = async (name: string, homeCurrency: string, attributes = {}) =>
    (await createMember(tenantId, { name, homeCurrency, attributes })).id;
  const brand = await member('Homeware brand', 'GBP', { payout: 'wallet' });
  const supplier = await member('Portuguese supplier', 'EUR');
  const retailer = await member('Dutch retailer', 'EUR');

  const agent = async (memberId: string, name: string, roles: ('buy' | 'sell')[], more = {}) =>
    (
      await createAgent(tenantId, {
        memberId,
        name,
        mandate: { roles, currencies: ['EUR', 'USD'], ...more },
      })
    ).id;
  const brandBuyer = await agent(brand, 'Brand buyer', ['buy'], {
    categories: ['homeware'],
    ...(limits.monthlyLimit === undefined ? {} : { monthlyLimit: limits.monthlyLimit }),
  });
  const brandSeller = await agent(brand, 'Brand seller', ['sell']);
  const supplierAgent = await agent(supplier, 'Supplier agent', ['sell']);
  const retailerAgent = await agent(retailer, 'Retailer agent', ['buy']);

  for (const [key, spec] of Object.entries(programs)) {
    await publishProgram(tenantId, { key, spec: onThisRail(spec, rail) });
  }

  const ids = { brand, supplier, retailer, brandBuyer, brandSeller, supplierAgent, retailerAgent };
  const principal = (kind: Principal['kind'], memberId?: string): Principal => ({
    kind,
    id: `${kind}-test`,
    tenantId,
    memberId,
  });

  return {
    tenantId,
    rail,
    ...ids,
    platform: principal('platform'),
    inspector: principal('inspector'),
    carrier: principal('carrier'),
    asMember: (m) => principal('member', m),
    async fund(memberId, currency, amount) {
      const externalRef = `dep-${randomUUID()}`;
      rail.simulateDeposit(currency, amount, externalRef);
      await deposit(tenantId, { memberId, currency, amount, rail: rail.name, externalRef });
    },
    async available(memberId, currency) {
      const all = await balances(tenantId, memberId);
      return all.find((b) => b.code.endsWith(`:${currency}:available`))?.balance ?? 0n;
    },
    deal(o) {
      const buyerAgentId = o.buyer === 'brand' ? brandBuyer : retailerAgent;
      const sellerAgentId = o.seller === 'brand' ? brandSeller : supplierAgent;
      return submitDeal(o.as ?? principal('platform'), {
        idempotencyKey: o.key ?? randomUUID(),
        programKey: o.program ?? 'trade-assurance',
        buyerMemberId: ids[o.buyer],
        sellerMemberId: ids[o.seller],
        buyerAgentId,
        sellerAgentId,
        terms: {
          category: 'homeware',
          currency: 'EUR',
          shipmentDate: '2026-11-02',
          lines: [
            {
              sku: 'MUG-01',
              description: 'Ceramic mug',
              quantity: o.quantity,
              unitPrice: eur(o.price),
            },
          ],
          attributes: { sellerListUnitPrice: Number(eur(o.price)) },
          ...o.extra,
        } as never,
      });
    },
    async pass(dealId, o) {
      // A party may not type in what a document says, so the test files them as the platform.
      const platform = principal('platform');
      await submitFact(dealId, platform, {
        kind: 'document',
        type: 'commercial_invoice',
        data: { fields: { amount: Number(o.amount), currency: 'EUR', quantity: o.quantity } },
      });
      await submitFact(dealId, platform, {
        kind: 'document',
        type: 'packing_list',
        data: { fields: { quantity: o.quantity } },
      });
      await submitFact(dealId, principal('carrier'), {
        kind: 'document',
        type: 'bill_of_lading',
        data: { fields: { shipmentDate: o.shipped ?? '2026-11-02' } },
      });
      await submitFact(dealId, principal('inspector'), {
        kind: 'inspection',
        type: 'third_party',
        data: o.pass ?? { passRate: 1 },
      });
    },
  };
}
