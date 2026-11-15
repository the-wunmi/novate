import { randomBytes, randomUUID } from 'node:crypto';
import { type Currency, type CurrencyLimits, fromMajor, type Principal } from '@novate/core';
import { controlEvents, dealEvents, deals } from '@novate/db';
import { runMigrations } from '@novate/db/migrate';
import { testPoolSize, workerDatabases } from '@novate/db/test-databases';
import { type DecisionAgent, type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail, RailRegistry, type SettlementRail } from '@novate/rails';
import { and, asc, eq } from 'drizzle-orm';
import { deps } from '../src/deps.ts';
import {
  approveRequest,
  balances,
  createAgent,
  createMember,
  createTenant,
  type DeliveredNotification,
  decideCase,
  deposit,
  type Engine,
  launchEngine,
  openCases,
  provisionMember,
  publishProgram,
  recordRailOpening,
  runReconciliation,
  setMemberRailRefs,
  submitDeal,
  submitFact,
} from '../src/index.ts';

export const eur = (v: string) => fromMajor(v, 'EUR');
export const gbp = (v: string) => fromMajor(v, 'GBP');

let engine: Engine;

/** Sign-in settings for this process: its own secret key, and links to a server nobody opens. */
export const testAuth = {
  secretKey: randomBytes(32).toString('base64'),
  publicUrl: 'http://localhost:4000',
};

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
  // Live tests that drive a dev server pass its databases. Everything else gets this worker's own.
  const databases =
    options.databaseUrl && options.systemDatabaseUrl
      ? { databaseUrl: options.databaseUrl, systemDatabaseUrl: options.systemDatabaseUrl }
      : workerDatabases();
  await runMigrations(databases.databaseUrl);
  const rails = new RailRegistry().register(rail);
  for (const r of extra) rails.register(r);
  engine = await launchEngine({
    ...databases,
    auth: testAuth,
    rails,
    appName: `novate-test-${Date.now()}`,
    decisionAgent: swappable,
    // Retries and polls take milliseconds instead of seconds, along the same paths.
    pace: 0.01,
    // Workers run side by side on one Postgres, so each engine keeps to its share of connections.
    poolSize: testPoolSize,
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

/**
 * Run `fn` with the rail owned by the tenant, as reconciliation and openings require, then give the
 * rail back. Tests share rails across tenants, so none owns one for longer than it needs.
 */
export async function owning<T>(tenantId: string, rail: string, fn: () => Promise<T>): Promise<T> {
  const owners = deps().railOwners;
  const before = owners[rail];
  owners[rail] = tenantId;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete owners[rail];
    else owners[rail] = before;
  }
}

/** Reconcile the rail now, as the tenant that owns it. */
export const reconcile = (tenantId: string, rail: string) =>
  owning(tenantId, rail, () => runReconciliation(tenantId, rail));

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

/** Wait for an open case about a deal, or about another subject such as a reconciliation run. */
export async function waitForCase(
  tenantId: string,
  of: { dealId: string } | { subjectId: string },
  timeoutMs = 15_000,
) {
  const matches = (c: Awaited<ReturnType<typeof openCases>>[number]) =>
    'dealId' in of ? c.dealId === of.dealId : c.subjectId === of.subjectId;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = (await openCases(tenantId)).find(matches);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no open case');
}

/** The tenant's control events, oldest first, of one type or all. */
export const controlEventsOf = (
  tenantId: string,
  type?: (typeof controlEvents.$inferSelect)['type'],
) =>
  engine.db
    .select()
    .from(controlEvents)
    .where(
      and(eq(controlEvents.tenantId, tenantId), ...(type ? [eq(controlEvents.type, type)] : [])),
    )
    .orderBy(asc(controlEvents.createdAt));

/** Every case goes to a person: the model only escalates. */
export const escalatingBrain = () => {
  brain.current = {
    name: 'stub',
    decide: async () => ({ action: { type: 'escalate', note: 'a person' }, rationale: 'r' }),
  };
};

/** Net settlement on the test rail, without the preset's overrides. */
export const netProgram = (extra: Partial<ProgramSpecInput> = {}): ProgramSpecInput => ({
  ...presetInputs.netSettlement,
  overrides: [],
  settlement: { rail: 'mock' },
  ...extra,
});

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
  /** A signed-in platform person, for what a key alone may not do. */
  person: Principal;
  /** Another signed-in person, at the house, to approve what `person` asked for. */
  checker: Principal;
  /** A signed-in house person who asks for what `checker` approves. */
  house: Principal;
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
  /** The brand buyer's limits by currency, over its default of no limit in EUR and USD. */
  buyerLimits: Record<string, CurrencyLimits> = {},
): Promise<World> {
  const tenantId = (await createTenant({ name: `t-${randomUUID()}` })).tenant.id;
  const setup: Principal = { kind: 'platform', id: 'platform-test', tenantId };
  const member = async (name: string, homeCurrency: string, attributes = {}) =>
    (await createMember(tenantId, setup, { name, homeCurrency, attributes })).id;
  const brand = await member('Homeware brand', 'GBP', { payout: 'wallet' });
  const supplier = await member('Portuguese supplier', 'EUR');
  const retailer = await member('Dutch retailer', 'EUR');

  const agent = async (memberId: string, name: string, roles: ('buy' | 'sell')[], more = {}) =>
    (
      await createAgent(tenantId, setup, {
        memberId,
        name,
        mandate: { roles, limits: { EUR: {}, USD: {} }, ...more },
      })
    ).id;
  const brandBuyer = await agent(brand, 'Brand buyer', ['buy'], {
    categories: ['homeware'],
    limits: { EUR: {}, USD: {}, ...buyerLimits },
  });
  const brandSeller = await agent(brand, 'Brand seller', ['sell']);
  const supplierAgent = await agent(supplier, 'Supplier agent', ['sell']);
  const retailerAgent = await agent(retailer, 'Retailer agent', ['buy']);

  const ids = { brand, supplier, retailer, brandBuyer, brandSeller, supplierAgent, retailerAgent };
  const principal = (kind: Principal['kind'], memberId?: string): Principal => ({
    kind,
    id: `${kind}-test`,
    tenantId,
    memberId,
  });

  for (const [key, spec] of Object.entries(programs)) {
    await publishProgram(tenantId, principal('platform'), { key, spec: onThisRail(spec, rail) });
  }

  return {
    tenantId,
    rail,
    ...ids,
    platform: principal('platform'),
    person: {
      ...principal('platform'),
      id: 'person-test',
      userId: randomUUID(),
      name: 'Pat Platform',
    },
    checker: { ...principal('house'), id: 'checker-test', userId: randomUUID(), name: 'Hal House' },
    house: { ...principal('house'), id: 'house-test', userId: randomUUID(), name: 'Hana House' },
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
      return all.find((b) => b.kind === 'available' && b.currency === currency)?.balance ?? 0n;
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

/**
 * A person decides a case. Past the program's ceiling that needs a second person, so `w.checker`
 * approves it, the way a house colleague would.
 */
export async function personDecides(
  w: World,
  caseId: string,
  input: Parameters<typeof decideCase>[2],
  as: Principal = w.person,
) {
  const out = await decideCase(caseId, as, input);
  if (out.status === 'pending_approval') {
    await approveRequest(w.tenantId, w.checker, out.approvalId);
  }
  return out;
}

/** Set where a member is paid, as the house does: one person asks and `w.checker` approves. */
export async function assignRailRefs(w: World, memberId: string, refs: Record<string, string>) {
  const out = await setMemberRailRefs(w.tenantId, w.house, memberId, { refs, reason: 'test' });
  if (out.status === 'pending_approval') {
    await approveRequest(w.tenantId, w.checker, out.approvalId);
  }
}

/** Agree a one-unit deal, have its buyer accept it, and wait until it can settle. */
export async function acceptedDeal(
  w: World,
  buyer: 'brand' | 'retailer',
  seller: 'brand' | 'supplier',
  price: string,
  program = 'net',
) {
  const d = await w.deal({ program, buyer, seller, quantity: 1, price });
  await waitFor(d.id, ['awaiting_conditions']);
  await submitFact(d.id, w.asMember(w[buyer]), { kind: 'acceptance', type: 'buyer', data: {} });
  await waitFor(d.id, ['eligible']);
  return d.id;
}

/**
 * The retailer's usual order, then one ten times its size, which freezes and opens a case. The
 * world's trade-assurance program must be published.
 */
export async function frozenBigOrder(w: World) {
  await w.fund(w.retailer, 'EUR', eur('100000'));
  await w.fund(w.brand, 'GBP', gbp('50000'));
  const usual = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 600, price: '15' });
  await waitFor(usual.id, ['awaiting_conditions']);
  const big = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 6_000, price: '15' });
  await waitFor(big.id, ['frozen']);
  return { big, case: await waitForCase(w.tenantId, { dealId: big.id }) };
}

/** Give a member a EUR account on the rail, paying out to a Dutch IBAN. */
export const provisionEurMember = (w: World, memberId: string, rail = 'mock') =>
  provisionMember(w.tenantId, w.house, memberId, {
    rail,
    countryCode: 'NL',
    currency: 'EUR',
    transferMethods: ['LOCAL'],
    idempotencyKey: randomUUID(),
    beneficiary: {
      bank_details: {
        account_currency: 'EUR',
        account_name: 'Dutch retailer',
        bank_name: 'ABN AMRO',
        iban: 'NL91ABNA0417164300',
      },
    },
  });

/**
 * An open difference on a rail, found by real reconciliation after an opening: EUR money nobody
 * booked (`stray`, an item and the balance it moves) or a balance the ledger cannot explain
 * (`corrupt`). A name registers a new rail, whose account starts empty.
 */
export async function rigBreak(
  w: World,
  rail: MockRail | string,
  how: { stray: bigint } | { corrupt: bigint },
) {
  const account = typeof rail === 'string' ? new MockRail({ name: rail }) : rail;
  if (typeof rail === 'string') engine.rails.register(account);
  await recordRailOpening(w.tenantId, account.name);
  if ('stray' in how) account.simulateDeposit('EUR', how.stray, `stray-${account.name}`);
  else account.corrupt('EUR', how.corrupt);
  const run = await reconcile(w.tenantId, account.name);
  return { rail: account, run };
}

/** A withdrawal that went out at once rather than waiting for a second person. */
export async function sent<T extends object>(asked: Promise<T>) {
  const out = await asked;
  if (!('id' in out)) throw new Error('The withdrawal is waiting for approval');
  return out as Extract<T, { id: string }>;
}

/**
 * A member's accounts on the Airwallex sandbox, reused by every live run: the sandbox allows 20
 * Global Accounts per currency and country, and closed ones still count. The request id and name
 * are the live demo's (`openAccounts` in apps/api/src/demo-live.ts), so tests and demo share one
 * set of accounts; they never run at once and keep separate databases.
 */
export async function liveAccounts(
  w: World,
  rail: SettlementRail,
  memberId: string,
  slug: string,
  currency: Currency,
  countryCode: string,
): Promise<Record<string, string>> {
  const provision = rail.provision?.bind(rail);
  if (!provision) throw new Error(`${rail.name} cannot open accounts`);
  const refs = await provision({
    requestId: `novate-demo-${slug}-0001`,
    countryCode,
    currency,
    nickName: `novate demo ${slug}`,
    transferMethods: ['LOCAL'],
    beneficiary: {
      entity_type: 'COMPANY',
      company_name: `novate demo ${slug}`,
      address: {
        country_code: 'NL',
        city: 'Amsterdam',
        street_address: 'Damrak 1',
        postcode: '1012LG',
      },
      bank_details: {
        account_currency: 'EUR',
        account_name: `novate demo ${slug}`,
        bank_country_code: 'NL',
        iban: 'NL91ABNA0417164300',
        swift_code: 'ABNANL2A',
      },
    },
  });
  await assignRailRefs(w, memberId, refs);
  return refs;
}
