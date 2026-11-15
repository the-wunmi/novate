import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { runMigrations } from '@novate/db/migrate';
import { testPoolSize } from '@novate/db/test-databases';
import { launchEngine } from '@novate/engine';
import { presetInputs } from '@novate/policy';
import { MockRail, RailRegistry } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { payWithAiri, readCredential } from '../src/airi-buyer.ts';
import { createApp } from '../src/app.ts';
import { testEngine } from './people.ts';

const ADMIN = 'card-admin';
const CARD = '4111111111111111';
const app = createApp({ isOperator: async (key) => key === ADMIN });
let engine: Awaited<ReturnType<typeof launchEngine>>;

beforeAll(async () => {
  await runMigrations();
  engine = await launchEngine({
    ...testEngine(),
    pace: 0.01,
    poolSize: testPoolSize,
    appName: `novate-card-${Date.now()}`,
    rails: new RailRegistry().register(new MockRail()),
  });
});
afterAll(() => engine?.shutdown());

const call = (path: string, key: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function fundingDeal() {
  const { tenant, apiKey } = (await (
    await call('/operator/tenants', ADMIN, { name: `c-${randomUUID()}` })
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
      settlement: { rail: 'mock', netting: 'gross', timing: { mode: 'immediate' } },
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
      lines: [{ sku: 'A', description: 'Thing', quantity: 1, unitPrice: '5000' }],
    },
  });
  const deal = (await res.json()) as { id: string };
  const status = async () =>
    ((await (await call(`/deals/${deal.id}`, apiKey)).json()) as { deal: { status: string } }).deal
      .status;
  await expect.poll(status, { timeout: 15_000 }).toBe('awaiting_funding');
  return { apiKey, dealId: deal.id, status };
}

describe('the card funding routes', () => {
  it('tells the buyer what to ask Airi for', async () => {
    const w = await fundingDeal();
    const offer = (await (await call(`/deals/${w.dealId}/card`, w.apiKey)).json()) as {
      amount: string;
      currency: string;
      merchant: { name: string };
    };
    expect(offer).toMatchObject({ amount: '5200', currency: 'USD' });
    expect(offer.merchant.name).toBeTruthy();
  });

  it('answers 402 for a decline and refuses a malformed card without echoing it', async () => {
    const w = await fundingDeal();
    const body = (number: string) => ({
      mandateId: `mdt_${randomUUID()}`,
      amount: '5200',
      card: { number, expiryMonth: '03', expiryYear: '2031', cvc: '737', name: 'A' },
    });
    const declined = await call(`/deals/${w.dealId}/card`, w.apiKey, body('4000000000000002'));
    expect(declined.status).toBe(402);
    const malformed = await call(`/deals/${w.dealId}/card`, w.apiKey, body('41111111x1111111'));
    expect(malformed.status).toBe(422);
    expect(await malformed.text()).not.toContain('41111111x1111111');
  });
});

describe('the buyer side of Airi', () => {
  it('reads a credential however it is nested, naming fields only on failure', () => {
    const read = readCredential(
      { credential: { tokenPan: CARD, cvv: '123', tokenExpiration: '2031-03' } },
      'A',
    );
    expect(read).toMatchObject({ number: CARD, cvc: '123', expiryMonth: '03', expiryYear: '2031' });
    let message = '';
    try {
      readCredential({ secret: CARD }, 'A');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('secret');
    expect(message).not.toContain(CARD);
  });

  it('pays exactly what is owed, deletes the credential and reports back', async () => {
    const w = await fundingDeal();
    const commands: string[][] = [];
    let credentialPath = '';
    const mandateId = `mdt_${randomUUID()}`;
    let approvalUrl = '';
    const paid = await payWithAiri({
      apiUrl: 'http://novate.test',
      apiKey: w.apiKey,
      dealId: w.dealId,
      cardName: 'A Buyer',
      chooseCard: async ([first]) => (first as { paymentMethodId: string }).paymentMethodId,
      fetch: ((url: string, init?: RequestInit) =>
        app.request(url.replace('http://novate.test', ''), init)) as typeof fetch,
      askApproval: (url) => {
        approvalUrl = url;
      },
      async cli(args) {
        commands.push(args);
        if (args[0] === 'auth') return { authenticated: true };
        if (args[0] === 'payment-methods') return [{ paymentMethodId: 'pm_1' }];
        if (args[1] === 'create') return { mandate_id: mandateId, passkey_url: 'https://airi/p' };
        if (args[1] === 'get-credential') {
          credentialPath = args[args.indexOf('--file') + 1] as string;
          await writeFile(
            credentialPath,
            JSON.stringify({ tokenPan: CARD, cvv: '123', tokenExpiration: '03/31' }),
          );
        }
        return {};
      },
    });
    expect(paid.status).toBe('succeeded');
    expect(approvalUrl).toBe('https://airi/p');
    const create = commands.find((c) => c[1] === 'create') as string[];
    expect(create[create.indexOf('--total-amount') + 1]).toBe('52.00');
    expect(commands.at(-1)).toEqual([
      'mandate',
      'result',
      '--mandate-id',
      mandateId,
      '--result',
      'SUCCEEDED',
    ]);
    await expect(access(credentialPath)).rejects.toThrow();
    await expect.poll(w.status, { timeout: 15_000 }).not.toBe('awaiting_funding');
  });
});
