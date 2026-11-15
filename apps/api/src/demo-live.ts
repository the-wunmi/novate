import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { createMetalPaymentClient } from '@metalntwx/metal-pay';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ClaudeDecisionAgent, ClaudeDocumentReader, ClaudeModelClient } from '@novate/agents';
import { fromMajor } from '@novate/core';
import { createPool } from '@novate/db';
import { runMigrations } from '@novate/db/migrate';
import {
  launchEngine,
  PostgresMetalAttempts,
  pollRailsNow,
  runCycle,
  runReconciliation,
} from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { AirwallexRail, createMetalClient, MetalRail, RailRegistry } from '@novate/rails';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createApp } from './app.ts';
import { demoClient } from './demo-client.ts';
import { ensureDemoUsers } from './demo-users.ts';
import { authFromEnv } from './env.ts';
import { fundStablecoinBuyer } from './metal-buyer.ts';
import { until } from './wait.ts';
import { metalGateway } from './x402.ts';

/**
 * The whole product on real systems, narrated, on its own fresh database: Airwallex's sandbox and its
 * webhooks through a tunnel, Claude deciding and reading documents, trading agents connected over
 * MCP, and a stablecoin payment on Metal testnet. `pnpm demo:live`, or `--step` to pause at each part.
 */
const PORT = Number(process.env.NOVATE_DEMO_PORT ?? 4100);
const APP_DB = 'novate_demo';
const SYSTEM_DB = 'novate_demo_dbos';
const paced = process.argv.includes('--step');
const WEBHOOK_PATIENCE_MS = 40_000;
const reader = paced ? createInterface({ input: process.stdin, output: process.stdout }) : null;

const paint = (code: number, text: string) => `\x1b[${code}m${text}\x1b[0m`;
let chapterNumber = 0;
async function chapter(title: string) {
  if (reader) await reader.question(paint(2, '\n  press Enter to continue '));
  chapterNumber += 1;
  console.log(`\n${paint(1, `${chapterNumber}. ${title}`)}`);
  if (!reader) await sleep(1500);
}
const say = (text: string) => console.log(`   ${text}`);
const done = (text: string) => console.log(`   ${paint(32, 'done')}  ${text}`);
const eur = (major: string) => fromMajor(major, 'EUR').toString();
const euros = (minor: string | bigint) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(
    Number(minor) / 100,
  );

function databaseUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freshDatabases() {
  const admin = createPool(process.env.DATABASE_URL as string);
  for (const name of [APP_DB, SYSTEM_DB]) {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
  }
  await admin.end();
}

/** A public address for webhooks. Quick tunnels take a few seconds to start answering. */
async function openTunnel(): Promise<{ url: string; process: ChildProcess }> {
  const child = spawn('cloudflared', [
    'tunnel',
    '--no-autoupdate',
    '--url',
    `http://localhost:${PORT}`,
  ]);
  const url = await new Promise<string>((found, failed) => {
    let seen = '';
    child.stderr.on('data', (chunk) => {
      seen += chunk;
      const match = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(seen);
      if (match) found(match[0]);
    });
    child.on('exit', () => failed(new Error('cloudflared stopped before giving an address')));
    child.on('error', () => failed(new Error('cloudflared is not installed')));
  });
  return { url, process: child };
}

const beneficiary = (name: string) => ({
  entity_type: 'COMPANY',
  company_name: name,
  address: {
    country_code: 'NL',
    city: 'Amsterdam',
    street_address: 'Damrak 1',
    postcode: '1012LG',
  },
  bank_details: {
    account_currency: 'EUR',
    account_name: name,
    bank_country_code: 'NL',
    iban: 'NL91ABNA0417164300',
    swift_code: 'ABNANL2A',
  },
});

const running = spawnSync('pgrep', ['-f', 'src/server.ts']).stdout.toString().trim();
if (running) {
  console.warn(
    paint(33, 'A novate server is running. It shares this Airwallex account, so stop it first.'),
  );
  console.warn('Otherwise its reconciliation will see the demo money as unexplained.\n');
}

console.log(paint(1, 'novate, on real systems'));
say('Fresh database, real Airwallex sandbox, real Claude, real Metal testnet.');
await freshDatabases();

const metal = process.env.METAL_RPC_URL
  ? createMetalClient({
      rpcUrl: process.env.METAL_RPC_URL,
      privateKey: process.env.METAL_PRIVATE_KEY as `0x${string}`,
    })
  : undefined;
const buyerKey = metal ? await fundStablecoinBuyer(metal) : undefined;

const credentials = {
  clientId: process.env.AIRWALLEX_CLIENT_ID as string,
  apiKey: process.env.AIRWALLEX_API_KEY as string,
};
const tunnel = await openTunnel();
process.on('exit', () => tunnel.process.kill());
const tunnelHost = new URL(tunnel.url).host;
// Asking Airwallex before the name is public gets a refusal it may remember, so wait first.
await until(
  'the tunnel name to be public',
  async () => {
    const resolved = await Promise.all(
      ['https://dns.google/resolve', 'https://cloudflare-dns.com/dns-query'].map(async (server) => {
        const res = await fetch(`${server}?name=${tunnelHost}&type=A`, {
          headers: { accept: 'application/dns-json' },
        }).catch(() => undefined);
        const body = (await res?.json().catch(() => undefined)) as
          | { Answer?: unknown[] }
          | undefined;
        return Boolean(body?.Answer?.length);
      }),
    );
    return resolved.every(Boolean) ? true : undefined;
  },
  { timeoutMs: 120_000 },
);
await sleep(5_000);
// Airwallex can still call the address internal for a while after it resolves.
const webhookSecret = await until(
  'Airwallex to accept the tunnel',
  () =>
    new AirwallexRail(credentials)
      .registerWebhook(`${tunnel.url}/rails/airwallex/webhooks`)
      .catch((err: Error) => {
        if (!/internal address/.test(err.message)) throw err;
        return undefined;
      }),
  { timeoutMs: 90_000 },
);
const airwallex = new AirwallexRail({ ...credentials, webhookSecret });
const rails = new RailRegistry().register(airwallex);
if (metal) rails.register(new MetalRail(metal, new PostgresMetalAttempts()));

await runMigrations(databaseUrl(APP_DB));
const model = new ClaudeModelClient();
const engine = await launchEngine({
  databaseUrl: databaseUrl(APP_DB),
  systemDatabaseUrl: databaseUrl(SYSTEM_DB),
  auth: authFromEnv(PORT),
  appName: 'novate-demo',
  rails,
  ownedRails: rails.all().map((r) => r.name),
  decisionAgent: new ClaudeDecisionAgent(model),
  documentReader: new ClaudeDocumentReader(model),
  notifier: { deliver: async () => undefined },
});
const app = createApp({
  x402: metal ? metalGateway(metal.houseAddress, metal.reader) : undefined,
});
const server = serve({
  // The node server's bindings carry the socket, which sign-in rate limits key on.
  fetch: async (req: Request, env: unknown) => {
    // The tunnel exists for Airwallex's webhooks; the demo's known passwords stay on localhost.
    const { host, pathname } = new URL(req.url);
    if (host === tunnelHost && !pathname.startsWith('/rails/')) {
      return new Response('Not found', { status: 404 });
    }
    const res = await app.fetch(req, env);
    if (new URL(req.url).pathname.startsWith('/rails/') && !res.ok) {
      console.warn(`Refused a webhook: ${res.status} ${await res.clone().text()}`);
    }
    return res;
  },
  port: PORT,
});
await until(
  'the tunnel to answer',
  async () => {
    const res = await fetch(`${tunnel.url}/health`).catch(() => undefined);
    return res?.ok ? true : undefined;
  },
  { timeoutMs: 60_000 },
);

const first = engine.firstRun as NonNullable<typeof engine.firstRun>;
const tenant = first.tenantId;
const platform = first.platformKey;
// Sign-in accounts with known passwords, made only because this is the local demo database.
let demoUsers = await ensureDemoUsers(databaseUrl(APP_DB));
const consoleUrl = `http://localhost:${PORT}/console/`;
const signIns = () => {
  for (const u of demoUsers) say(`  ${u.role.padEnd(8)} ${u.email}  password ${u.password}`);
};

const { api, signIn } = demoClient(`http://localhost:${PORT}`);
const base = `/tenants/${tenant}`;

/** One of the demo's house people, signed in through the console's own login, acting with that session. */
async function signedIn(email: string) {
  const user = demoUsers.find((u) => u.email === email);
  if (!user) throw new Error(`No demo user ${email}`);
  return signIn(email, user.password);
}

/** Where a member is paid: one house person asks and the other approves, as on any installation. */
async function setPayee(memberId: string, refs: Record<string, string>, reason: string) {
  const asker = await signedIn('house@demo.local');
  const asked = await asker<{ status?: string; approvalId?: string }>(
    'PUT',
    `${base}/members/${memberId}/rail-refs`,
    { refs, reason },
  );
  if (asked.status === 'pending_approval') {
    const checker = await signedIn('checker@demo.local');
    await checker('POST', `${base}/approvals/${asked.approvalId}/approve`, {});
  }
}

/** Sandbox transfers wait to be told the bank paid them. */
const bank = setInterval(async () => {
  const flying = await engine.db.query.settlementInstructions.findMany({
    where: (i, { and, eq }) => and(eq(i.status, 'submitted'), eq(i.rail, 'airwallex')),
  });
  for (const i of flying) {
    if (!i.externalRef) continue;
    await airwallex.simulateTransfer(i.externalRef, 'SENT').catch(() => undefined);
    await airwallex.simulateTransfer(i.externalRef, 'PAID').catch(() => undefined);
  }
}, 2_500);

async function shutDown(code: number) {
  clearInterval(bank);
  tunnel.process.kill();
  reader?.close();
  server.close();
  await engine.shutdown();
  process.exit(code);
}
process.on('SIGINT', () => void shutDown(0));

async function connectAgent(key: string) {
  const client = new Client({ name: 'novate-demo-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  );
  return async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    const [content] = reply.content as { text: string }[];
    if (reply.isError) throw new Error(`${name}: ${content?.text}`);
    return JSON.parse(content?.text as string) as { id: string };
  };
}

async function member(name: string, homeCurrency: string, attributes = {}) {
  return (
    await api<{ id: string }>(platform, 'POST', `${base}/members`, {
      name,
      homeCurrency,
      attributes,
    })
  ).id;
}

/** Limits in each deal's currency, in major units. */
interface Limits {
  maxPerDeal: string;
  monthlyLimit: string;
}

async function tradingAgent(memberId: string, name: string, currencies: string[], limits: Limits) {
  const { id } = await api<{ id: string }>(platform, 'POST', `${base}/agents`, {
    memberId,
    name,
    mandate: {
      roles: ['buy', 'sell'],
      limits: Object.fromEntries(
        currencies.map((c) => [
          c,
          {
            maxPerDeal: fromMajor(limits.maxPerDeal, c).toString(),
            monthlyLimit: fromMajor(limits.monthlyLimit, c).toString(),
          },
        ]),
      ),
    },
  });
  const { key } = await api<{ key: string }>(platform, 'POST', `${base}/keys`, {
    name,
    principal: 'agent',
    memberId,
    agentId: id,
  });
  return { id, memberId, call: await connectAgent(key) };
}
type Agent = Awaited<ReturnType<typeof tradingAgent>>;

/** A stable request id finds the same Global Account, because the sandbox allows only 20 of them. */
async function openAccounts(memberId: string, slug: string, currency: string, country: string) {
  const refs = await airwallex.provision({
    requestId: `novate-demo-${slug}-0001`,
    countryCode: country,
    currency: currency as never,
    nickName: `novate demo ${slug}`,
    transferMethods: ['LOCAL'],
    beneficiary: beneficiary(`novate demo ${slug}`),
  });
  await setPayee(memberId, refs as Record<string, string>, 'Global Account opened for the demo');
  return refs.airwallex_deposit_account as string;
}

const available = async (memberId: string, currency: string) => {
  const rows = await api<{ kind: string; currency: string; balance: string }[]>(
    platform,
    'GET',
    `${base}/members/${memberId}/balances`,
  );
  const wallet = rows.find((r) => r.kind === 'available' && r.currency === currency);
  return BigInt(wallet?.balance ?? '0');
};

/** Waits for the webhook. A fresh tunnel can be slow to become reachable, so polling backs it up. */
async function sendMoney(memberId: string, account: string, currency: string, major: string) {
  const amount = fromMajor(major, currency as never);
  const before = await available(memberId, currency);
  const { id } = await airwallex.simulateDeposit({
    globalAccountId: account,
    amount,
    currency: currency as never,
  });
  const sent = Date.now();
  await until('the deposit to be credited', async () => {
    if ((await available(memberId, currency)) === before + amount) return true;
    if (Date.now() - sent > WEBHOOK_PATIENCE_MS) await pollRailsNow();
    return undefined;
  });
  const heard = await engine.db.query.railEvents.findFirst({
    where: (e, { like }) => like(e.externalId, `%${id}%`),
  });
  return heard?.externalId.startsWith('deposit-poll:') ? 'polling Airwallex' : 'signed webhook';
}

/** Immediate gross settlement, with the checks out of the way so a chapter is only about the payment. */
const instantProgram = (key: string, rail: string) =>
  api(platform, 'POST', `${base}/programs`, {
    key,
    note: `Demo: settle each ${key} payment on its own as soon as it is released`,
    spec: {
      ...presetInputs.realtimeAgentClearing,
      checks: [],
      authority: { enforceMandate: false },
      settlement: { rail, netting: 'gross', timing: { mode: 'immediate' } },
    },
  });

const dealStatus = async (id: string) =>
  (await api<{ deal: { status: string } }>(platform, 'GET', `/deals/${id}`)).deal.status;
const waitFor = (id: string, ...wanted: string[]) =>
  until(`a deal to reach ${wanted.join(' or ')}`, async () => {
    const status = await dealStatus(id);
    return wanted.includes(status) ? status : undefined;
  });

interface Trade {
  program: string;
  buyer: Agent;
  seller: Agent;
  quantity: number;
  price: string;
}
async function agree({ program, buyer, seller, quantity, price }: Trade) {
  const deal = {
    idempotencyKey: randomUUID(),
    programKey: program,
    buyerMemberId: buyer.memberId,
    sellerMemberId: seller.memberId,
    buyerAgentId: buyer.id,
    sellerAgentId: seller.id,
    terms: {
      category: 'homeware',
      currency: 'EUR',
      shipmentDate: '2026-11-02',
      lines: [{ sku: 'MUG-01', description: 'ceramic mugs', quantity, unitPrice: eur(price) }],
      attributes: { sellerListUnitPrice: Number(eur(price)) },
    },
  };
  const { id } = await buyer.call('submit_deal', deal);
  await seller.call('submit_deal', deal);
  return id;
}

const fileDocument = (deal: string, seller: Agent, type: string, text: string) =>
  seller.call('file_document', {
    dealId: deal,
    document: { type, content: { kind: 'text', text } },
  });

const billOfLading = (quantity: number) =>
  [
    'BILL OF LADING',
    'Carrier: Atlantic Box Lines',
    'Vessel: MV Tagus. Port of loading: Leixoes. Port of discharge: Felixstowe',
    `Description of goods: ceramic mugs, quantity ${quantity}`,
    'Shipped on board: 2026-11-03',
    'Signed for the carrier: J. Alves, master',
  ].join('\n');

async function fileInvoiceAndPacking(deal: string, seller: Agent, total: string, quantity: number) {
  await fileDocument(
    deal,
    seller,
    'commercial_invoice',
    `COMMERCIAL INVOICE\nDescription: ceramic mugs\nQuantity: ${quantity}\nCurrency: EUR\nTotal amount due: ${total}`,
  );
  await fileDocument(
    deal,
    seller,
    'packing_list',
    `PACKING LIST\nCeramic mugs, quantity packed: ${quantity}`,
  );
}

interface FeedEntry {
  id: string;
  dealId: string;
  kind: string;
  resolution: { action: { type: string } } | null;
}

/** What Claude decided on a case for this deal, and why. */
async function claudesDecision(deal: string, kind: string) {
  const entry = await until(`Claude to decide the ${kind} case`, async () => {
    const feed = await api<{ rows: FeedEntry[] }>(platform, 'GET', `${base}/decisions`);
    return feed.rows.find((d) => d.dealId === deal && d.kind === kind && d.resolution);
  });
  const trail = await api<{ steps: { rationale: string; action: { type: string } }[] }>(
    platform,
    'GET',
    `${base}/decisions/${entry.id}`,
  );
  return trail.steps.at(-1) as { rationale: string; action: { type: string } };
}

/** The buyer accepts, and the cycle pays the seller. */
async function acceptAndSettle(deal: string, buyer: string, name: string) {
  const { key } = await api<{ key: string }>(platform, 'POST', `${base}/keys`, {
    name,
    principal: 'member',
    memberId: buyer,
  });
  await api(key, 'POST', `/deals/${deal}/facts`, { kind: 'acceptance', type: 'buyer', data: {} });
  await until('the seller to be paid', async () => {
    await runCycle(tenant);
    return (await dealStatus(deal)) === 'settled' ? true : undefined;
  });
}

try {
  await chapter('A platform sets the rules');
  const settlement = { netting: 'multilateral', rail: 'airwallex', confirmWithin: '1h' } as const;
  await api(platform, 'POST', `${base}/programs`, {
    key: 'trade',
    note: 'Demo: trade assurance for mugs, agents decide cases up to €200,000',
    spec: {
      ...presetInputs.tradeAssurance,
      overrides: [],
      decisions: { ceiling: { EUR: 20_000_000 } },
      settlement,
    },
  });
  done('Trade assurance published: buyers prefund, money releases on proof of delivery.');
  done('Agents may decide cases up to €200,000. Anything larger goes to a person.');
  say(`Open the clearing desk: ${paint(36, consoleUrl)} and sign in as`);
  signIns();
  if (!process.argv.includes('--no-open')) {
    // `open` is macOS's; elsewhere the link above is enough.
    spawn('open', [consoleUrl]).on('error', () => undefined);
  }

  await chapter('Businesses join, each with a real Airwallex account');
  const brandId = await member('Homeware brand', 'GBP', { payout: 'wallet' });
  const supplierId = await member('Portuguese supplier', 'EUR');
  const retailerId = await member('Dutch retailer', 'EUR');
  demoUsers = await ensureDemoUsers(databaseUrl(APP_DB));
  const brandAccount = await openAccounts(brandId, 'brand', 'GBP', 'GB');
  const supplierAccount = await openAccounts(supplierId, 'supplier', 'EUR', 'DE');
  const retailerAccount = await openAccounts(retailerId, 'retailer', 'EUR', 'DE');
  done('Three members, each with their own Global Account and payout details.');
  // Each limit leaves room for the €90,000 mistake, so it is the quantity rule that catches it.
  const brand = await tradingAgent(brandId, 'Brand trading agent', ['EUR', 'USD'], {
    maxPerDeal: '100000',
    monthlyLimit: '250000',
  });
  const supplier = await tradingAgent(supplierId, 'Supplier trading agent', ['EUR', 'USD'], {
    maxPerDeal: '50000',
    monthlyLimit: '150000',
  });
  const retailer = await tradingAgent(retailerId, 'Retailer trading agent', ['EUR', 'USD'], {
    maxPerDeal: '100000',
    monthlyLimit: '200000',
  });
  done('Three trading agents connected over MCP, each with its own limits.');

  await chapter('Money arrives, and novate credits only what Airwallex confirms');
  await pollRailsNow();
  const how = await sendMoney(brandId, brandAccount, 'GBP', '15000');
  done(`£15,000 reached the brand, credited by ${how}.`);
  done(
    `€9,000 reached the retailer, credited by ${await sendMoney(retailerId, retailerAccount, 'EUR', '9000')}.`,
  );
  const margin = await sendMoney(supplierId, supplierAccount, 'EUR', '1000');
  done(`€1,000 reached the supplier to post as margin, credited by ${margin}.`);

  await chapter('Agents strike deals');
  const buy = await agree({
    program: 'trade',
    buyer: brand,
    seller: supplier,
    quantity: 1_000,
    price: '14',
  });
  done('Brand buys 1,000 mugs from the supplier for €14,000. Both agents agreed the same terms.');
  const sell = await agree({
    program: 'trade',
    buyer: retailer,
    seller: brand,
    quantity: 600,
    price: '15',
  });
  done('Retailer buys 600 mugs from the brand for €9,000.');
  await waitFor(buy, 'awaiting_conditions');
  await waitFor(sell, 'awaiting_conditions');
  done('Authority checked, funds and margin locked in the ledger.');

  await chapter('An agent makes a mistake');
  const mistake = await agree({
    program: 'trade',
    buyer: retailer,
    seller: brand,
    quantity: 6_000,
    price: '15',
  });
  say('The retailer agent orders 6,000 mugs for €90,000, ten times its usual size.');
  say('Rules freeze it. Claude decides, from a fixed list of actions, and code checks the result.');
  const step = await claudesDecision(mistake, 'frozen');
  done(`Claude chose: ${paint(1, step.action.type)}`);
  say(paint(3, `"${step.rationale}"`));

  await chapter('Proof of delivery comes in');
  const inspector = await api<{ key: string }>(platform, 'POST', `${base}/keys`, {
    name: 'Inspector',
    principal: 'inspector',
  });
  const inspection = (deal: string, data: Record<string, number>) =>
    api(inspector.key, 'POST', `/deals/${deal}/facts`, {
      kind: 'inspection',
      type: 'third_party',
      data,
    });
  await fileInvoiceAndPacking(buy, supplier, '14000.00', 1_000);
  await fileDocument(
    buy,
    supplier,
    'bill_of_lading',
    'BILL OF LADING\nCarrier: Harbour Line\nGoods: ceramic mugs',
  );
  say('The supplier agent filed an invoice, packing list and a bare bill of lading.');
  await inspection(buy, { inspected: 1_000, passed: 920 });
  say('The inspector passed 920 of 1,000 mugs.');
  const review = await claudesDecision(buy, 'held');
  done(`Claude read the documents and chose: ${paint(1, review.action.type.replaceAll('_', ' '))}`);
  say(paint(3, `"${review.rationale}"`));
  await fileDocument(buy, supplier, 'bill_of_lading', billOfLading(1_000));
  done('The supplier agent filed a proper bill of lading.');
  await fileInvoiceAndPacking(sell, brand, '9000.00', 600);
  await fileDocument(sell, brand, 'bill_of_lading', billOfLading(600));
  await inspection(sell, { passRate: 1 });
  await waitFor(buy, 'eligible');
  await waitFor(sell, 'eligible');
  const released = await api<{ deal: { releaseAmount: string } }>(platform, 'GET', `/deals/${buy}`);
  done(`Cleared for payment: ${euros(released.deal.releaseAmount)} to the supplier.`);

  await chapter('Settlement nets it, converts once, pays once');
  const cycle = await runCycle(tenant);
  if (cycle.status !== 'settled') throw new Error(`The cycle ended ${cycle.status}`);
  await waitFor(buy, 'settled');
  await waitFor(sell, 'settled');
  done('€21,880 was owed. The supplier was paid €12,880 in one payout.');
  done('The brand converted only the €3,880 it was short, not the whole €12,880.');

  await chapter('The books are checked against the bank');
  const clean = await runReconciliation(tenant, 'airwallex');
  if (clean.status !== 'clean')
    throw new Error(`Reconciliation found ${clean.breaks.length} differences`);
  done('Every balance and transaction matches Airwallex.');

  await chapter('A buyer funds a deal by card');
  await instantProgram('card', 'airwallex');
  const shopper = await member('Online shop', 'EUR');
  const { id: cardDeal } = await api<{ id: string }>(platform, 'POST', `${base}/deals`, {
    idempotencyKey: randomUUID(),
    programKey: 'card',
    buyerMemberId: shopper,
    sellerMemberId: supplierId,
    terms: {
      category: 'homeware',
      currency: 'EUR',
      lines: [{ sku: 'MUG-01', description: 'ceramic mugs', quantity: 10, unitPrice: eur('10') }],
    },
  });
  await waitFor(cardDeal, 'awaiting_funding');
  const offer = await api<{ amount: string }>(platform, 'GET', `/deals/${cardDeal}/card`);
  say(
    `The deal needs funding, and novate asks for ${euros(offer.amount)}: the price plus a card fee buffer.`,
  );
  const charged = await api<{ status: string }>(platform, 'POST', `/deals/${cardDeal}/card`, {
    mandateId: `demo-${randomUUID()}`,
    amount: offer.amount,
    card: {
      number: '4111111111111111',
      expiryMonth: '12',
      expiryYear: '2030',
      cvc: '123',
      name: 'Online shop',
    },
  });
  if (charged.status !== 'succeeded') throw new Error(`The card payment was ${charged.status}`);
  done(
    'Airwallex captured the payment. This is a sandbox test card, standing in for an Airi credential.',
  );
  await waitFor(cardDeal, 'awaiting_conditions');
  await acceptAndSettle(cardDeal, shopper, 'Card buyer');
  done('The buyer accepted and the supplier was paid.');
  const afterCard = await runReconciliation(tenant, 'airwallex');
  if (afterCard.status !== 'clean')
    throw new Error(`Reconciliation found ${afterCard.breaks.length} differences`);
  done('The books still match. Card money counts as on its way until Airwallex pays it over.');

  if (metal && buyerKey) {
    await chapter('A buyer pays in stablecoin instead, on Metal');
    const usd = await member('Research agents co', 'USD');
    const seller = await member('Data vendor', 'USD');
    await setPayee(
      seller,
      { metal_account: privateKeyToAccount(generatePrivateKey()).address },
      'Seller wallet for the demo',
    );
    await instantProgram('instant', 'metal');
    const { id: deal } = await api<{ id: string }>(platform, 'POST', `${base}/deals`, {
      idempotencyKey: randomUUID(),
      programKey: 'instant',
      buyerMemberId: usd,
      sellerMemberId: seller,
      terms: {
        category: 'software',
        currency: 'USD',
        lines: [{ sku: 'DATA-1', description: 'data licence', quantity: 1, unitPrice: '100' }],
      },
    });
    await waitFor(deal, 'awaiting_funding');
    const { fetchWithPayment } = createMetalPaymentClient({
      account: privateKeyToAccount(buyerKey as `0x${string}`),
      network: 'testnet',
      maxAmount: 2n * 10n ** 18n,
    });
    const paid = await fetchWithPayment(`http://127.0.0.1:${PORT}/deals/${deal}/x402`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platform}` },
      body: '{}',
    });
    if (paid.status !== 200) throw new Error(`x402 answered ${paid.status}: ${await paid.text()}`);
    const { transaction } = (await paid.json()) as { transaction: string };
    done(`A buyer wallet paid $1.00 over x402: https://testnet.metalntwx.com/tx/${transaction}`);
    say('novate records it, and credits nothing until the deposit is final on-chain.');
    await until('the deposit to finalize', async () => {
      await pollRailsNow();
      return (await dealStatus(deal)) === 'awaiting_conditions' ? true : undefined;
    });
    done('Final on-chain, credited, and locked.');
    await acceptAndSettle(deal, usd, 'Stablecoin buyer');
    done('The buyer accepted and the seller was paid on-chain.');
    const chain = await runReconciliation(tenant, 'metal');
    if (chain.status !== 'clean')
      throw new Error(`Metal reconciliation found ${chain.breaks.length} differences`);
    done('The books match the chain.');
  }

  await chapter('Switch programs, same agents, no prefunding');
  await api(platform, 'POST', `${base}/programs`, {
    key: 'net',
    note: 'Demo: the same agents switch to net settlement with no prefunding',
    spec: {
      ...presetInputs.netSettlement,
      overrides: [],
      settlement: { ...settlement, fundingWindow: '2m' },
    },
  });
  done('Net settlement published. Behaviour lives in the program, not the code.');
  await sendMoney(retailerId, retailerAccount, 'EUR', '1500');
  const one = await agree({
    program: 'net',
    buyer: retailer,
    seller: supplier,
    quantity: 400,
    price: '5',
  });
  const two = await agree({
    program: 'net',
    buyer: supplier,
    seller: retailer,
    quantity: 150,
    price: '5',
  });
  say('The retailer owes the supplier €2,000. The supplier owes the retailer €750.');
  const acceptAs = async (deal: string, agent: Agent) => {
    await waitFor(deal, 'awaiting_conditions');
    await agent.call('submit_evidence', {
      dealId: deal,
      fact: { kind: 'acceptance', type: 'buyer', data: {} },
    });
    await waitFor(deal, 'eligible');
  };
  await acceptAs(one, retailer);
  await acceptAs(two, supplier);
  const net = await runCycle(tenant);
  if (net.status !== 'settled') throw new Error(`The net cycle ended ${net.status}`);
  await waitFor(one, 'settled');
  await waitFor(two, 'settled');
  done('€2,750 was owed. One payment of €1,250 settled all of it.');
  const end = await runReconciliation(tenant, 'airwallex');
  if (end.status !== 'clean')
    throw new Error(`Reconciliation found ${end.breaks.length} differences`);
  done('The books still match Airwallex.');

  console.log(`\n${paint(1, 'No person touched a transaction.')}`);
  say(`Clearing desk: ${paint(36, consoleUrl)}, signed in as`);
  signIns();
  say('Still running so the desk stays live. Press Ctrl-C to finish.');
} catch (err) {
  console.error(paint(31, `\nThe demo stopped: ${(err as Error).message}`));
  await shutDown(1);
}
