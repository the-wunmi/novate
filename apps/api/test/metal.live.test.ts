import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createMetalPaymentClient } from '@metalntwx/metal-pay';
import { runMigrations } from '@novate/db/migrate';
import {
  launchEngine,
  PostgresMetalAttempts,
  revokeApiKey,
  runReconciliation,
  setMemberRailRefs,
  submitFact,
} from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { createMetalClient, MetalRail, RailRegistry } from '@novate/rails';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { metalGateway } from '../src/x402.ts';

const envFile = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const ADMIN = 'metal-live-admin';
const PORT = 4199;

/**
 * A real buyer wallet paying a real deal over x402 on Metal testnet, through Metal's facilitator, and
 * the seller paid on-chain. It runs as the default tenant of a dev server sharing this database,
 * because that server owns the rail and reads the finalized deposit. Needs NOVATE_LIVE=1 and
 * NOVATE_LIVE_BUYER_KEY, a testnet key holding at least US$1, funded before the rail's opening.
 */
const live = process.env.NOVATE_LIVE === '1' && process.env.NOVATE_LIVE_BUYER_KEY;
describe.skipIf(!live)('x402 on the Metal testnet (live)', () => {
  const client = createMetalClient({
    rpcUrl: process.env.METAL_RPC_URL as string,
    privateKey: process.env.METAL_PRIVATE_KEY as `0x${string}`,
  });
  const rail = new MetalRail(client, new PostgresMetalAttempts());
  const app = createApp({
    x402: metalGateway(client.houseAddress, client.reader),
    isOperator: async (key) => key === ADMIN,
  });
  let engine: Awaited<ReturnType<typeof launchEngine>>;
  let server: ReturnType<typeof serve>;
  let revoke: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    await runMigrations();
    engine = await launchEngine({
      appName: `novate-metal-live-${Date.now()}`,
      rails: new RailRegistry().register(rail),
    });
    server = serve({ fetch: app.fetch, port: PORT });
  }, 120_000);

  afterAll(async () => {
    await revoke?.();
    server?.close();
    await engine?.shutdown();
  });

  const call = (path: string, key: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('takes a real payment, credits it after finality, and pays the seller', async () => {
    const buyerAccount = privateKeyToAccount(process.env.NOVATE_LIVE_BUYER_KEY as `0x${string}`);
    const sellerAddress = privateKeyToAccount(generatePrivateKey()).address;

    const setup = await engine.db.query.instanceSetup.findFirst();
    const tenantId = setup?.defaultTenantId as string;
    const issued = await call(`/tenants/${tenantId}/platform-key`, ADMIN, {});
    const { id: keyId, key: apiKey } = (await issued.json()) as { id: string; key: string };
    revoke = () => revokeApiKey(tenantId, keyId);
    const member = async (name: string) =>
      (
        (await (
          await call(`/tenants/${tenantId}/members`, apiKey, { name, homeCurrency: 'USD' })
        ).json()) as { id: string }
      ).id;
    await call(`/tenants/${tenantId}/programs`, apiKey, {
      key: 'x402-live',
      spec: {
        ...presetInputs.realtimeAgentClearing,
        checks: [],
        authority: { enforceMandate: false },
        settlement: { rail: 'metal', netting: 'gross', timing: { mode: 'immediate' } },
      },
    });
    const [buyer, seller] = [await member('x402 live buyer'), await member('x402 live seller')];
    await setMemberRailRefs(tenantId, seller, { metal_account: sellerAddress });

    const created = await call(`/tenants/${tenantId}/deals`, apiKey, {
      idempotencyKey: randomUUID(),
      programKey: 'x402-live',
      buyerMemberId: buyer,
      sellerMemberId: seller,
      terms: {
        category: 'software',
        currency: 'USD',
        lines: [{ sku: 'A', description: 'Thing', quantity: 1, unitPrice: '100' }],
      },
    });
    const { id: dealId } = (await created.json()) as { id: string };
    const status = async () =>
      ((await (await call(`/deals/${dealId}`, apiKey)).json()) as { deal: { status: string } }).deal
        .status;
    await expect.poll(status, { timeout: 30_000 }).toBe('awaiting_funding');

    const quoted = await call(`/deals/${dealId}/x402`, apiKey, {});
    expect(quoted.status).toBe(402);

    const { fetchWithPayment } = createMetalPaymentClient({
      account: buyerAccount,
      network: 'testnet',
      maxAmount: 2n * 10n ** 18n,
    });
    const paid = await fetchWithPayment(`http://127.0.0.1:${PORT}/deals/${dealId}/x402`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: '{}',
    });
    console.log('x402 answered', paid.status, await paid.clone().text());
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-response')).toBeTruthy();

    // The money counts only once the deposit is final, and the buyer then accepts the goods.
    await expect.poll(status, { timeout: 180_000, interval: 1_000 }).toBe('awaiting_conditions');
    await submitFact(
      dealId,
      { kind: 'member', id: buyer, tenantId, memberId: buyer },
      {
        kind: 'acceptance',
        type: 'buyer',
        data: {},
      },
    );
    await expect.poll(status, { timeout: 180_000, interval: 1_000 }).toBe('settled');

    const payout = await engine.db.query.settlementInstructions.findFirst({
      where: (i, { and, eq }) => and(eq(i.memberId, seller), eq(i.direction, 'payout')),
    });
    console.log('seller paid', payout?.status, payout?.externalRef);
    expect(payout?.status).toBe('confirmed');
    expect(await runReconciliation(tenantId, 'metal')).toMatchObject({ status: 'clean' });
  }, 420_000);
});
