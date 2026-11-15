import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { serve } from '@hono/node-server';
import { type Currency, fromMajor, toMajor } from '@novate/core';
import { runMigrations } from '@novate/db/migrate';
import { freshDatabasePair } from '@novate/db/test-databases';
import { deposit, launchEngine, runCycle } from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { MockRail, RailRegistry } from '@novate/rails';
import { createApp } from './app.ts';
import { demoClient } from './demo-client.ts';
import { ensureDemoUsers } from './demo-users.ts';
import { until } from './wait.ts';

/**
 * `pnpm demo`: the mug scenario from start to finish on the in-memory rail, then the console over
 * what it left behind. No credentials, no model and no real money: the ledger, workflows, netting,
 * checks and API are the real ones. Each run starts from fresh `novate_demo_offline` databases on
 * the Postgres that `pnpm db:up` starts.
 */
const PORT = Number(process.env.NOVATE_DEMO_PORT ?? 4100);
const APP_DB = 'novate_demo_offline';
const origin = `http://localhost:${PORT}`;
const consoleUrl = `${origin}/console/`;

const say = (text: string) => console.log(`\n${text}`);
const detail = (text: string) => console.log(`  ${text}`);
const money = (minor: bigint | string, currency: string) =>
  `${currency} ${toMajor(BigInt(minor), currency as Currency)}`;
const eur = (major: string) => fromMajor(major, 'EUR').toString();

const free = await new Promise<boolean>((resolve) => {
  const probe = createServer()
    .once('error', () => resolve(false))
    .once('listening', () => probe.close(() => resolve(true)))
    .listen(PORT);
});
if (!free) {
  console.error(`Port ${PORT} is in use. Run with NOVATE_DEMO_PORT set to a free port.`);
  process.exit(1);
}

const databases = await freshDatabasePair(APP_DB).catch((err: Error) => {
  console.error(`Could not reach Postgres (${err.message}). Start it with: pnpm db:up`);
  process.exit(1);
});
await runMigrations(databases.databaseUrl);
const rail = new MockRail();
const engine = await launchEngine({
  ...databases,
  // The databases are new each run, so a key made here protects nothing that outlives it.
  auth: { secretKey: randomBytes(32).toString('base64'), publicUrl: origin },
  appName: 'novate-demo-offline',
  rails: new RailRegistry().register(rail),
  ownedRails: [rail.name],
  notifier: { deliver: async () => undefined },
  logLevel: 'error',
});
const server = serve({ fetch: createApp().fetch, port: PORT });

async function shutDown(code: number) {
  server.close();
  await engine.shutdown();
  process.exit(code);
}
process.on('SIGINT', () => void shutDown(0));

const { tenantId: tenant, platformKey: platform } = engine.firstRun as NonNullable<
  typeof engine.firstRun
>;
const base = `/tenants/${tenant}`;
const { api, signIn } = demoClient(origin);

const member = async (name: string, homeCurrency: string, attributes = {}) =>
  (
    await api<{ id: string }>(platform, 'POST', `${base}/members`, {
      name,
      homeCurrency,
      attributes,
    })
  ).id;

const key = async (name: string, principal: string, memberId?: string, agentId?: string) =>
  (
    await api<{ key: string }>(platform, 'POST', `${base}/keys`, {
      name,
      principal,
      memberId,
      agentId,
    })
  ).key;

interface Agent {
  id: string;
  memberId: string;
  key: string;
}

async function agent(memberId: string, name: string, roles: string[], more = {}): Promise<Agent> {
  const { id } = await api<{ id: string }>(platform, 'POST', `${base}/agents`, {
    memberId,
    name,
    mandate: { roles, limits: { EUR: {}, USD: {} }, ...more },
  });
  return { id, memberId, key: await key(name, 'agent', memberId, id) };
}

/** Money arriving in the house's account on the rail, credited as the rail's event would be. */
async function fund(memberId: string, currency: Currency, major: string) {
  const externalRef = `dep-${randomUUID()}`;
  const amount = fromMajor(major, currency);
  rail.simulateDeposit(currency, amount, externalRef);
  await deposit(tenant, { memberId, currency, amount, rail: rail.name, externalRef });
}

/** Both trading agents submit the same terms, as a deal from a party waits for the other side. */
async function trade(buyer: Agent, seller: Agent, quantity: number, price: string) {
  const deal = {
    idempotencyKey: randomUUID(),
    programKey: 'trade-assurance',
    buyerMemberId: buyer.memberId,
    sellerMemberId: seller.memberId,
    buyerAgentId: buyer.id,
    sellerAgentId: seller.id,
    terms: {
      category: 'homeware',
      currency: 'EUR',
      shipmentDate: '2026-11-02',
      lines: [{ sku: 'MUG-01', description: 'Ceramic mug', quantity, unitPrice: eur(price) }],
      attributes: { sellerListUnitPrice: Number(eur(price)) },
    },
  };
  const { id } = await api<{ id: string }>(buyer.key, 'POST', `${base}/deals`, deal);
  await api(seller.key, 'POST', `${base}/deals`, deal);
  return id;
}

const dealOf = (id: string) =>
  api<{ deal: { status: string; releaseAmount: string | null } }>(platform, 'GET', `/deals/${id}`);
const waitFor = (id: string, ...wanted: string[]) =>
  until(
    `a deal to reach ${wanted.join(' or ')}`,
    async () => {
      const { deal } = await dealOf(id);
      return wanted.includes(deal.status) ? deal : undefined;
    },
    { timeoutMs: 60_000, everyMs: 100 },
  );

async function timeline(dealId: string) {
  const { events } = await api<{ events: { seq: number; type: string }[] }>(
    platform,
    'GET',
    `/deals/${dealId}`,
  );
  detail(
    events
      .sort((a, b) => a.seq - b.seq)
      .map((e) => e.type)
      .join(' > '),
  );
}

try {
  console.log('novate, offline: the mug scenario on an in-memory rail');

  const tradeAssurance = presetInputs.tradeAssurance;
  await api(platform, 'POST', `${base}/programs`, {
    key: 'trade-assurance',
    note: 'Demo: trade assurance for mugs on the in-memory rail',
    spec: { ...tradeAssurance, settlement: { ...tradeAssurance.settlement, rail: rail.name } },
  });
  const brand = await member('Homeware brand', 'GBP', { payout: 'wallet' });
  const supplier = await member('Portuguese supplier', 'EUR');
  const retailer = await member('Dutch retailer', 'EUR');
  const brandBuyer = await agent(brand, 'Brand buyer', ['buy'], {
    categories: ['homeware'],
    limits: { EUR: { monthlyLimit: eur('20000') }, USD: {} },
  });
  const brandSeller = await agent(brand, 'Brand seller', ['sell']);
  const supplierAgent = await agent(supplier, 'Supplier agent', ['sell']);
  const retailerAgent = await agent(retailer, 'Retailer agent', ['buy']);
  const carrier = await key('Atlantic Box Lines', 'carrier');
  const inspector = await key('Porto Quality Control', 'inspector');

  const users = await ensureDemoUsers(databases.databaseUrl, [APP_DB]);
  const password = (email: string) => users.find((u) => u.email === email)?.password as string;
  const house = await signIn('house@demo.local', password('house@demo.local'));
  const checker = await signIn('checker@demo.local', password('checker@demo.local'));

  await fund(brand, 'GBP', '15000');
  await fund(retailer, 'EUR', '9000');
  await fund(supplier, 'EUR', '1000');

  /** The documents and inspection that release a deal, each filed by whoever vouches for it. */
  async function evidence(
    dealId: string,
    o: { amount: string; quantity: number; shipped?: string; pass?: object },
  ) {
    const fact = (as: string, body: object) =>
      api(as, 'POST', `/deals/${dealId}/facts`, { kind: 'document', ...body });
    await fact(platform, {
      type: 'commercial_invoice',
      data: { fields: { amount: Number(eur(o.amount)), currency: 'EUR', quantity: o.quantity } },
    });
    await fact(platform, { type: 'packing_list', data: { fields: { quantity: o.quantity } } });
    await fact(carrier, {
      type: 'bill_of_lading',
      data: { fields: { shipmentDate: o.shipped ?? '2026-11-02' } },
    });
    await api(inspector, 'POST', `/deals/${dealId}/facts`, {
      kind: 'inspection',
      type: 'third_party',
      data: o.pass ?? { passRate: 1 },
    });
  }

  say(
    'A homeware brand buys 1,000 mugs from a Portuguese supplier and sells 600 to a Dutch retailer.',
  );
  const buy = await trade(brandBuyer, supplierAgent, 1_000, '14');
  const sell = await trade(retailerAgent, brandSeller, 600, '15');
  await waitFor(buy, 'awaiting_conditions');
  await waitFor(sell, 'awaiting_conditions');
  detail('Both agents were within their mandates. Funds and seller margin are locked.');

  say('Goods ship a day late, inside tolerance. Inspection finds 8% chipped.');
  await evidence(buy, {
    amount: '14000',
    quantity: 1_000,
    shipped: '2026-11-03',
    pass: { inspected: 1_000, passed: 920 },
  });
  const released = await waitFor(buy, 'eligible');
  detail(`The evidence supports paying ${money(released.releaseAmount ?? 0n, 'EUR')}.`);
  await evidence(sell, { amount: '9000', quantity: 600 });
  await waitFor(sell, 'eligible');

  say('The clearing cycle nets everyone against the house.');
  const cycle = await runCycle(tenant);
  await waitFor(buy, 'settled');
  await waitFor(sell, 'settled');
  const bought = rail.conversions.map((c) => money(c.buyAmount, 'EUR')).join(', ');
  detail(`Status: ${cycle.status}.`);
  detail(
    `Without netting the house would buy ${money(cycle.fx?.boughtGross.EUR ?? 0n, 'EUR')}. It bought ${bought}.`,
  );
  await timeline(buy);

  say('An agent then orders ten times its usual size, and the deal freezes before money moves.');
  await fund(retailer, 'EUR', '100000');
  await fund(brand, 'GBP', '50000');
  const usual = await trade(retailerAgent, brandSeller, 600, '15');
  await waitFor(usual, 'awaiting_conditions');
  const big = await trade(retailerAgent, brandSeller, 6_000, '15');
  await waitFor(big, 'frozen');
  const frozen = await until(
    'the frozen deal to open a case',
    async () =>
      (
        await api<{ id: string; dealId: string; reason: string; bindingHash: string }[]>(
          platform,
          'GET',
          `${base}/cases`,
        )
      ).find((c) => c.dealId === big),
    { timeoutMs: 60_000, everyMs: 100 },
  );
  detail(`Frozen: ${frozen.reason}`);
  // With a model configured the risk agent takes this case. Here a house person does.
  const decided = await house<{ status?: string; approvalId?: string }>(
    'POST',
    `/cases/${frozen.id}/decision`,
    {
      bindingHash: frozen.bindingHash,
      rationale: 'Ten times the retailer’s usual order with no change in its business. Cancelled.',
      action: { type: 'cancel' },
    },
  );
  if (decided.status === 'pending_approval') {
    detail('The deal is past what one person may decide alone, so a second person approves it.');
    await checker('POST', `${base}/approvals/${decided.approvalId}/approve`, {});
  }
  await waitFor(big, 'cancelled');
  await timeline(big);
  detail('Nothing moved for the bad order. The decision is bound to exactly what the decider saw.');

  say('The house checks its books against the rail and signs off the day.');
  const recon = await house<{ status: string; breaks: unknown[] }>(
    'POST',
    `${base}/reconciliation`,
    { rail: rail.name },
  );
  if (recon.status !== 'clean')
    throw new Error(`Reconciliation found ${recon.breaks.length} differences`);
  detail('Every balance matches what the rail holds.');
  await house('POST', `${base}/books/sign-off`, {});
  detail('Signed off.');

  say(`Look around the console: ${consoleUrl}`);
  for (const u of users) detail(`${u.role.padEnd(9)}${u.email.padEnd(26)}password ${u.password}`);
  detail('The member account opens the Homeware brand’s portal.');
  say('Still running so the console stays up. Press Ctrl-C to stop.');
} catch (err) {
  console.error(`\nThe demo stopped: ${(err as Error).message}`);
  await shutDown(1);
}
