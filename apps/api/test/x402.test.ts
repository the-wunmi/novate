import { randomUUID } from 'node:crypto';
import { runMigrations } from '@novate/db/migrate';
import { ingestRailEvent, launchEngine } from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { MockRail, RailRegistry } from '@novate/rails';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types';
import { SettleError } from '@x402/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import type { X402Gateway } from '../src/x402.ts';

const ADMIN = 'x402-admin';
/** Fresh each run, so a payment left open by an earlier run cannot claim this run's deposit. */
const PAYER = `0xAbC${randomUUID().replaceAll('-', '').slice(0, 37)}`;
/** Fresh each run, as a real transaction hash is: a deposit can only be claimed once, ever. */
const TX = `0x${randomUUID().replaceAll('-', '')}`;
const verdict: { valid: boolean; reason?: string } = { valid: true };
let settles = 0;
/** The facilitator's next answer to settle, or an error it throws, in place of a clean success. */
let nextSettle: (() => SettleResponse) | undefined;

/** Stands in for Metal's facilitator. The route, deal and ledger around it are real. */
const gateway: X402Gateway = {
  async require(url, cents) {
    return {
      x402Version: 2,
      resource: { url },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:63825',
          asset: '0xusdz',
          amount: cents.toString(),
          payTo: '0xhouse',
          maxTimeoutSeconds: 300,
          extra: {},
        },
      ],
    } as PaymentRequired;
  },
  match: (required, payment) => required.accepts.find((a) => a.amount === payment.accepted.amount),
  async verify() {
    return { isValid: verdict.valid, invalidReason: verdict.reason, payer: PAYER };
  },
  async settle() {
    settles++;
    if (nextSettle) {
      const answer = nextSettle;
      nextSettle = undefined;
      return answer();
    }
    return { success: true, transaction: TX, network: 'eip155:63825', payer: PAYER };
  },
};

const app = createApp({ x402: gateway, isOperator: async (key) => key === ADMIN });
let engine: Awaited<ReturnType<typeof launchEngine>>;

beforeAll(async () => {
  process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname);
  await runMigrations();
  engine = await launchEngine({
    appName: `novate-x402-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail({ name: 'metal' })),
  });
});
afterAll(() => engine?.shutdown());

const call = (path: string, key: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function fundingDeal(amountCents = 5_000) {
  const { tenant, apiKey } = (await (
    await call('/tenants', ADMIN, { name: `x-${randomUUID()}` })
  ).json()) as { tenant: { id: string }; apiKey: string };
  const member = async (name: string) =>
    (
      (await (
        await call(`/tenants/${tenant.id}/members`, apiKey, { name, homeCurrency: 'USD' })
      ).json()) as { id: string }
    ).id;
  await call(`/tenants/${tenant.id}/programs`, apiKey, {
    key: 'rt',
    spec: {
      ...presetInputs.realtimeAgentClearing,
      checks: [],
      authority: { enforceMandate: false },
      settlement: { rail: 'metal', netting: 'gross', timing: { mode: 'immediate' } },
    },
  });
  const [buyer, seller] = [await member('Buyer'), await member('Seller')];
  const res = await call(`/tenants/${tenant.id}/deals`, apiKey, {
    idempotencyKey: randomUUID(),
    programKey: 'rt',
    buyerMemberId: buyer,
    sellerMemberId: seller,
    terms: {
      category: 'software',
      currency: 'USD',
      lines: [{ sku: 'A', description: 'Thing', quantity: 1, unitPrice: String(amountCents) }],
    },
  });
  const deal = (await res.json()) as { id: string };
  await expect
    .poll(
      async () =>
        ((await (await call(`/deals/${deal.id}`, apiKey)).json()) as { deal: { status: string } })
          .deal.status,
      { timeout: 15_000 },
    )
    .toBe('awaiting_funding');
  return { tenantId: tenant.id, apiKey, buyer, dealId: deal.id };
}

const payment = (amount: string): PaymentPayload =>
  ({
    x402Version: 2,
    accepted: { amount, network: 'eip155:63825' },
    payload: { authorization: { from: PAYER, nonce: randomUUID() } },
  }) as unknown as PaymentPayload;
const refusal = (errorReason: string, transaction = ''): SettleResponse => ({
  success: false,
  errorReason,
  transaction,
  network: 'eip155:63825',
  payer: PAYER,
});
const pay = (dealId: string, key: string, p: PaymentPayload) =>
  call(`/deals/${dealId}/x402`, key, {}, { 'payment-signature': encodePaymentSignatureHeader(p) });

const finalizedDeposit = (txHash: string, amountCents: number) =>
  ingestRailEvent(
    'metal',
    JSON.stringify({
      id: randomUUID(),
      type: 'deposit.settled',
      occurredAt: new Date().toISOString(),
      externalRef: `${txHash}:0`,
      depositAccountRef: PAYER.toLowerCase(),
      currency: 'USD',
      amount: String(amountCents),
      raw: {},
    }),
    {},
  );
const dealStatus = async (key: string, id: string) =>
  ((await (await call(`/deals/${id}`, key)).json()) as { deal: { status: string } }).deal.status;
const available = async (key: string, tenantId: string, member: string) => {
  const rows = (await (
    await call(`/tenants/${tenantId}/members/${member}/balances`, key)
  ).json()) as {
    code: string;
    balance: string;
  }[];
  return rows.find((r) => r.code.endsWith(':USD:available'))?.balance ?? '0';
};

describe('funding a deal over x402', () => {
  it('quotes what is owed, and credits only once the deposit is final', async () => {
    verdict.valid = true;
    const { tenantId, apiKey, buyer, dealId } = await fundingDeal();

    const quoted = await call(`/deals/${dealId}/x402`, apiKey, {});
    expect(quoted.status).toBe(402);
    expect(quoted.headers.get('payment-required')).toBeTruthy();

    const paid = await pay(dealId, apiKey, payment('5000'));
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-response')).toBeTruthy();
    expect(await dealStatus(apiKey, dealId)).toBe('awaiting_funding');

    await finalizedDeposit(TX, 5_000);
    await expect
      .poll(() => dealStatus(apiKey, dealId), { timeout: 15_000 })
      .toBe('awaiting_conditions');
    expect(await available(apiKey, tenantId, buyer)).toBe('0');
  });

  it('does not settle a payment for the wrong amount', async () => {
    const { apiKey, dealId } = await fundingDeal();
    const before = settles;
    expect((await pay(dealId, apiKey, payment('1'))).status).toBe(402);
    expect(settles).toBe(before);
  });

  it('records a spending mandate refusal on the deal', async () => {
    verdict.valid = false;
    verdict.reason = 'mandate_cap_exceeded';
    const { apiKey, dealId } = await fundingDeal();
    const res = await pay(dealId, apiKey, payment('5000'));
    expect(res.status).toBe(402);
    const detail = (await (await call(`/deals/${dealId}`, apiKey)).json()) as {
      events: { type: string; payload: { reason: string } }[];
    };
    expect(detail.events.find((e) => e.type === 'x402_refused')?.payload.reason).toBe(
      'mandate_cap_exceeded',
    );
    verdict.valid = true;
    verdict.reason = undefined;
  });

  const refusedEvents = async (key: string, id: string) =>
    (
      (await (await call(`/deals/${id}`, key)).json()) as { events: { type: string }[] }
    ).events.filter((e) => e.type === 'x402_refused');

  it('keeps a settlement in doubt open, then credits it when the deposit is final', async () => {
    const tx = `0x${randomUUID().replaceAll('-', '')}`;
    const { apiKey, dealId } = await fundingDeal();
    const p = payment('5000');
    nextSettle = () => refusal('settlement_in_doubt', tx);

    const inDoubt = await pay(dealId, apiKey, p);
    expect(inDoubt.status).toBe(202);
    expect(inDoubt.headers.get('payment-response')).toBeTruthy();
    expect(await refusedEvents(apiKey, dealId)).toEqual([]);

    await finalizedDeposit(tx, 5_000);
    await expect
      .poll(() => dealStatus(apiKey, dealId), { timeout: 15_000 })
      .toBe('awaiting_conditions');
  });

  it('settles the same payment on retry and offers no second one while it is open', async () => {
    const { apiKey, dealId } = await fundingDeal();
    const p = payment('5000');
    nextSettle = () => refusal('payment_in_flight');
    expect((await pay(dealId, apiKey, p)).status).toBe(202);

    expect((await call(`/deals/${dealId}/x402`, apiKey, {})).status).toBe(409);
    const before = settles;
    expect((await pay(dealId, apiKey, payment('5000'))).status).toBe(409);
    expect(settles).toBe(before);

    nextSettle = () => refusal('already_settled', `0x${randomUUID().replaceAll('-', '')}`);
    expect((await pay(dealId, apiKey, p)).status).toBe(200);
    expect(await refusedEvents(apiKey, dealId)).toEqual([]);
  });

  it('treats a settle with no answer as in doubt, not a failure', async () => {
    const { apiKey, dealId } = await fundingDeal();
    nextSettle = () => {
      throw new Error('socket hang up');
    };
    expect((await pay(dealId, apiKey, payment('5000'))).status).toBe(202);
    expect((await call(`/deals/${dealId}/x402`, apiKey, {})).status).toBe(409);
  });

  it('closes a payment the facilitator rate limited, so it matches no deposit', async () => {
    const { tenantId, apiKey, buyer, dealId } = await fundingDeal();
    const p = payment('5000');
    nextSettle = () => {
      throw new SettleError(429, refusal('rate_limited'));
    };
    const limited = await pay(dealId, apiKey, p);
    expect(limited.status).toBe(402);
    expect(limited.headers.get('payment-response')).toBeTruthy();
    expect((await call(`/deals/${dealId}/x402`, apiKey, {})).status).toBe(402);

    await finalizedDeposit(`0x${randomUUID().replaceAll('-', '')}`, 5_000);
    // Long enough for the event's workflow to have matched it if it was going to.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await available(apiKey, tenantId, buyer)).toBe('0');

    // Nothing moved, so the same authorization can still be settled.
    expect((await pay(dealId, apiKey, p)).status).toBe(200);
  });

  it('credits the payment naming the transaction before one that names none', async () => {
    const tx = `0x${randomUUID().replaceAll('-', '')}`;
    const stale = await fundingDeal();
    nextSettle = () => {
      throw new Error('socket hang up');
    };
    expect((await pay(stale.dealId, stale.apiKey, payment('5000'))).status).toBe(202);

    const named = await fundingDeal();
    nextSettle = () => ({ success: true, transaction: tx, network: 'eip155:63825', payer: PAYER });
    expect((await pay(named.dealId, named.apiKey, payment('5000'))).status).toBe(200);

    await finalizedDeposit(tx, 5_000);
    await expect
      .poll(() => dealStatus(named.apiKey, named.dealId), { timeout: 15_000 })
      .toBe('awaiting_conditions');
    expect(await dealStatus(stale.apiKey, stale.dealId)).toBe('awaiting_funding');
  });

  it('refuses one authorization for two deals', async () => {
    const first = await fundingDeal();
    const p = payment('5000');
    nextSettle = () => refusal('payment_in_flight');
    expect((await pay(first.dealId, first.apiKey, p)).status).toBe(202);
    const second = await fundingDeal();
    expect((await pay(second.dealId, second.apiKey, p)).status).toBe(409);
  });

  it('keeps other tenants out', async () => {
    const { dealId } = await fundingDeal();
    const stranger = (await (
      await call('/tenants', ADMIN, { name: `y-${randomUUID()}` })
    ).json()) as { apiKey: string };
    expect((await call(`/deals/${dealId}/x402`, stranger.apiKey, {})).status).toBe(404);
  });
});
