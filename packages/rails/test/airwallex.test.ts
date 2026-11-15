import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AirwallexRail, decimalToMinor } from '../src/index.ts';
import { FakeAirwallex } from './fake-airwallex.ts';

const make = () => {
  const fake = new FakeAirwallex();
  const rail = new AirwallexRail({
    clientId: 'c',
    apiKey: 'k',
    webhookSecret: 'shh',
    fetch: fake.fetch,
  });
  return { fake, rail };
};
const member = { id: 'm', railRefs: { airwallex_beneficiary: 'b1' } };
const req = {
  idempotencyKey: 'key-1',
  member,
  currency: 'EUR',
  amount: 1_288_000n,
  reference: 'r',
};

describe('airwallex rail', () => {
  it('reuses a token until it expires', async () => {
    const { fake, rail } = make();
    await rail.payout(req);
    await rail.payout({ ...req, idempotencyKey: 'key-2' });
    expect(fake.logins).toBe(1);
  });

  it('sends amounts in major units and pins the API version', async () => {
    const { fake, rail } = make();
    await rail.payout(req);
    const call = fake.calls.find((c) => c.path === '/api/v1/transfers/create');
    expect(call?.body).toMatchObject({ transfer_amount: '12880.00' });
  });

  it('treats a repeated instruction as the original', async () => {
    const { rail } = make();
    const first = await rail.payout(req);
    const second = await rail.payout(req);
    expect(second.externalRef).toBe(first.externalRef);
  });

  it('keeps PROCESSING and SENT in flight, and PAID confirmed', async () => {
    const { fake, rail } = make();
    const { externalRef } = await rail.payout(req);
    expect((await rail.status(externalRef, 'payout')).status).toBe('submitted');
    fake.setTransfer(externalRef, 'SENT');
    expect((await rail.status(externalRef, 'payout')).status).toBe('submitted');
    fake.setTransfer(externalRef, 'PAID');
    expect((await rail.status(externalRef, 'payout')).status).toBe('confirmed');
  });

  it('fails a payout with no beneficiary without calling Airwallex', async () => {
    const { fake, rail } = make();
    const r = await rail.payout({ ...req, member: { id: 'x', railRefs: {} } });
    expect(r.status).toBe('failed');
    expect(fake.calls).toHaveLength(0);
  });

  it('retries a server error rather than calling it failed', async () => {
    const { fake, rail } = make();
    fake.failNext = { status: 503, body: { message: 'busy' } };
    await expect(rail.payout(req)).rejects.toThrow(/503/);
  });

  it('cannot pull from a member in pooled custody', async () => {
    const { fake, rail } = make();
    expect((await rail.collect(req)).status).toBe('requires_funding');
    expect(fake.calls).toHaveLength(0);
  });

  it('derives the rate from amounts, independent of pair direction', async () => {
    const { rail } = make();
    const q = await rail.quote('GBP', 'EUR');
    expect(Number(q.rateE8) / 1e8).toBeCloseTo(1.15, 3);
  });

  it('finds the original conversion when a repeat is rejected', async () => {
    const { rail } = make();
    const fx = {
      idempotencyKey: 'fx1',
      sellCurrency: 'GBP',
      buyCurrency: 'EUR',
      buyAmount: 388_000n,
    };
    const first = await rail.convert(fx);
    expect((await rail.convert(fx)).externalRef).toBe(first.externalRef);
  });

  it('falls back to market when a quote has expired', async () => {
    const { fake, rail } = make();
    fake.failNext = { status: 400, body: { code: 'expired_quote', message: 'old' } };
    const r = await rail.convert({
      idempotencyKey: 'fx2',
      sellCurrency: 'GBP',
      buyCurrency: 'EUR',
      buyAmount: 100n,
      quoteId: 'q',
    });
    expect(r.status).toBe('confirmed');
  });

  describe('connected custody', () => {
    const connected = () => {
      const fake = new FakeAirwallex();
      const rail = new AirwallexRail({
        clientId: 'c',
        apiKey: 'k',
        webhookSecret: 's',
        fetch: fake.fetch,
        custody: 'connected',
      });
      return { fake, rail };
    };
    const acct = { id: 'm', railRefs: { airwallex_account: 'acct_1' } };

    it('pulls with a Charge and tracks it to settled', async () => {
      const { fake, rail } = connected();
      expect(rail.capabilities.pull).toBe(true);
      const r = await rail.collect({ ...req, member: acct });
      const call = fake.calls.find((c) => c.path === '/api/v1/charges/create');
      expect(call?.body).toMatchObject({ source: 'acct_1', amount: '12880.00' });
      fake.setCharge(r.externalRef, 'SETTLED');
      expect((await rail.status(r.externalRef, 'collect')).status).toBe('confirmed');
    });

    it('pays out to the member’s connected account', async () => {
      const { fake, rail } = connected();
      await rail.payout({ ...req, member: acct });
      const call = fake.calls.find((c) => c.path === '/api/v1/connected_account_transfers/create');
      expect(call?.body).toMatchObject({ destination: 'acct_1' });
    });

    it('fails cleanly when a member has no connected account', async () => {
      const { rail } = connected();
      expect((await rail.collect(req)).reason).toMatch(/connected account/);
    });
  });

  it('reads balances into minor units', async () => {
    const { fake, rail } = make();
    fake.deposit('EUR', 1234.56);
    expect(await rail.balances()).toEqual([{ currency: 'EUR', total: 123_456n }]);
  });

  it('handles float noise in decimals', () => {
    expect(decimalToMinor(12880.000000001, 'EUR')).toBe(1_288_000n);
    expect(decimalToMinor('0.1', 'JPY')).toBe(0n);
  });
});

describe('airwallex webhooks', () => {
  const body = JSON.stringify({
    id: 'evt1',
    name: 'deposit.settled',
    created_at: new Date().toISOString(),
    data: { id: 'd1', global_account_id: 'ga1', amount: 150.25, currency: 'EUR' },
  });
  const sign = (ts: string, b: string, secret = 'shh') =>
    createHmac('sha256', secret)
      .update(ts + b)
      .digest('hex');

  it('accepts a correct signature and attributes the deposit', () => {
    const { rail } = make();
    const ts = String(Date.now());
    const e = rail.parseEvent(body, { 'x-timestamp': ts, 'x-signature': sign(ts, body) });
    expect(e.type).toBe('deposit.settled');
    expect(e.depositAccountRef).toBe('ga1');
    expect(e.amount).toBe(15_025n);
  });

  it('rejects a wrong signature and a tampered body', () => {
    const { rail } = make();
    const ts = String(Date.now());
    expect(() =>
      rail.parseEvent(body, { 'x-timestamp': ts, 'x-signature': sign(ts, body, 'other') }),
    ).toThrow(/bad signature/);
    expect(() =>
      rail.parseEvent(`${body} `, { 'x-timestamp': ts, 'x-signature': sign(ts, body) }),
    ).toThrow(/bad signature/);
  });

  it('rejects a missing signature', () => {
    const { rail } = make();
    expect(() => rail.parseEvent(body, {})).toThrow(/missing/);
  });
});

describe('taking a card payment', () => {
  const card = {
    number: '4111111111111111',
    expiryMonth: '03',
    expiryYear: '2031',
    cvc: '737',
    name: 'A Buyer',
  };
  const open = async () => {
    const made = make();
    const { intentId } = await made.rail.cards.create({
      requestId: 'r-create',
      orderId: 'order-1',
      amount: 5_000n,
      currency: 'USD',
      descriptor: 'novate',
    });
    return { ...made, intentId };
  };

  it('sends major units and the card as the docs describe', async () => {
    const { fake, rail, intentId } = await open();
    const result = await rail.cards.confirm(intentId, 'r-confirm', card);
    expect(result.status).toBe('succeeded');
    expect(result.attemptRef).toMatch(/^att_/);
    const created = fake.calls.find((c) => c.path.endsWith('/payment_intents/create'));
    expect(created?.body).toMatchObject({
      amount: 50,
      currency: 'USD',
      merchant_order_id: 'order-1',
    });
    const confirmed = fake.calls.find((c) => c.path.endsWith('/confirm'));
    expect(confirmed?.body).toMatchObject({
      request_id: 'r-confirm',
      payment_method: { type: 'card', card: { number: card.number, expiry_year: '2031' } },
    });
  });

  it('believes the intent, not the error, when a confirm is repeated', async () => {
    const { rail, intentId } = await open();
    await rail.cards.confirm(intentId, 'r-confirm', card);
    expect((await rail.cards.confirm(intentId, 'r-confirm', card)).status).toBe('succeeded');
  });

  it('does not call a refused confirm a decline while nothing says it was', async () => {
    const { fake, rail, intentId } = await open();
    fake.failNext = { status: 400, body: { code: 'busy', message: 'being confirmed' } };
    expect((await rail.cards.confirm(intentId, 'r', card)).status).toBe('pending');
  });

  it('reports a decline as final, with the reason', async () => {
    const { rail, intentId } = await open();
    const result = await rail.cards.confirm(intentId, 'r', { ...card, number: '4000000000000002' });
    expect(result).toMatchObject({ status: 'failed', reason: 'authorization_failed' });
  });

  it('does not call a network failure a decline', async () => {
    const { fake, rail, intentId } = await open();
    fake.failNext = { status: 503, body: { code: 'unavailable', message: 'down' } };
    await expect(rail.cards.confirm(intentId, 'r', card)).rejects.toThrow();
  });

  it('turns payment intent webhooks into a card update', () => {
    const { rail } = make();
    const body = JSON.stringify({
      id: 'e1',
      name: 'payment_intent.succeeded',
      created_at: new Date().toISOString(),
      data: { object: { id: 'int_1' } },
    });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', 'shh')
      .update(timestamp + body)
      .digest('hex');
    const event = rail.parseEvent(body, { 'x-timestamp': timestamp, 'x-signature': signature });
    expect(event).toMatchObject({ type: 'card.updated', externalRef: 'int_1' });
    expect(JSON.stringify(event.raw)).not.toContain('data');
  });
});

describe('opening a connected account', () => {
  it('creates, submits and approves it in the sandbox', async () => {
    const fake = new FakeAirwallex();
    const rail = new AirwallexRail({
      clientId: 'c',
      apiKey: 'k',
      webhookSecret: 'shh',
      fetch: fake.fetch,
      custody: 'connected',
    });
    const refs = await rail.provision({
      requestId: 'r',
      countryCode: 'US',
      currency: 'USD',
      nickName: 'Seller',
      transferMethods: ['LOCAL'],
      connectedAccount: { account_details: { legal_entity_type: 'BUSINESS' } },
    });
    expect(refs.airwallex_account).toMatch(/^acct_/);
    expect(fake.accounts.get(refs.airwallex_account as string)?.status).toBe('ACTIVE');
    expect(fake.calls.map((c) => c.path)).toContain(
      `/api/v1/simulation/accounts/${refs.airwallex_account}/update_status`,
    );
  });
});

describe('answers that say nothing about the payment', () => {
  it('does not call a duplicate with no record failed', async () => {
    const { fake, rail } = make();
    fake.failNext = { status: 400, body: { code: 'duplicate_request_id', message: 'dup' } };
    await expect(rail.payout(req)).rejects.toThrow('dup');
  });
  it.each([
    [403, 'forbidden'],
    [400, 'service_unavailable'],
  ])('does not treat %i %s as a refusal', async (status, code) => {
    const { fake, rail } = make();
    fake.failNext = { status, body: { code, message: 'no answer' } };
    await expect(rail.payout(req)).rejects.toThrow('no answer');
  });
  it('still treats a rejected payment as failed', async () => {
    const { fake, rail } = make();
    fake.failNext = { status: 400, body: { code: 'validation_failed', message: 'bad details' } };
    expect(await rail.payout(req)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('bad details'),
    });
  });
});

describe('deposits a webhook missed', () => {
  const settled = (id: string) => ({
    id,
    status: 'SETTLED',
    amount: '10.50',
    currency: 'EUR',
    global_account_id: 'ga1',
    created_at: '2026-11-09T10:00:00+0000',
  });
  it('starts from now, so history is not replayed', async () => {
    const { fake, rail } = make();
    fake.deposits = [settled('old')];
    expect((await rail.pollEvents(null)).events).toEqual([]);
  });
  it('never looks back before polling began', async () => {
    const { fake, rail } = make();
    const { cursor } = await rail.pollEvents(null);
    await rail.pollEvents(cursor);
    const asked = fake.calls.findLast((c) => c.path === '/api/v1/deposits');
    expect(asked).toBeDefined();
    expect(fake.lastDepositsFrom).toBe(new Date(Number(cursor)).toISOString());
  });

  it('reports settled deposits and ignores pending ones', async () => {
    const { fake, rail } = make();
    fake.deposits = [settled('d1'), { ...settled('d2'), status: 'PENDING' }];
    const { events } = await rail.pollEvents(1n);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'deposit.settled',
      externalRef: 'd1',
      depositAccountRef: 'ga1',
      amount: 1050n,
    });
  });
});

describe('card payments and 3DS', () => {
  const card = {
    number: '4012000300000062',
    expiryMonth: '12',
    expiryYear: '2030',
    cvc: '123',
    name: 'A Buyer',
  };
  const order = {
    requestId: 'r-00000001',
    orderId: 'o',
    amount: 1000n,
    currency: 'USD' as const,
    descriptor: 'd',
  };
  it('does not ask to skip 3DS unless told it may', async () => {
    const { fake, rail } = make();
    await rail.cards.create(order as never);
    const sent = fake.calls.find((c) => c.path.endsWith('payment_intents/create'));
    expect(sent?.body).not.toHaveProperty('payment_method_options');
  });
  it('closes a payment that needs a challenge instead of leaving it open', async () => {
    const { fake, rail } = make();
    const { intentId } = await rail.cards.create(order as never);
    fake.challengeNext = true;
    expect(await rail.cards.confirm(intentId, 'c-00000001', card)).toMatchObject({
      status: 'failed',
      reason: 'three_ds_challenge_required',
    });
    expect(fake.intents.get(intentId)?.status).toBe('CANCELLED');
  });
});

describe('without a webhook secret', () => {
  it('refuses every webhook', () => {
    const rail = new AirwallexRail({
      clientId: 'c',
      apiKey: 'k',
      fetch: new FakeAirwallex().fetch,
    });
    const headers = { 'x-timestamp': String(Date.now()), 'x-signature': 'anything' };
    expect(() => rail.parseEvent('{}', headers)).toThrow(/no webhook secret/);
  });
});

describe('opening a connected account after a failure part way', () => {
  it('continues the account it made, even after a restart', async () => {
    const fake = new FakeAirwallex();
    const rail = new AirwallexRail({
      clientId: 'c',
      apiKey: 'k',
      webhookSecret: 'shh',
      fetch: fake.fetch,
      custody: 'connected',
    });
    const input = {
      requestId: 'r',
      countryCode: 'US',
      currency: 'USD',
      nickName: 'Seller',
      transferMethods: ['LOCAL' as const],
      connectedAccount: {},
    };
    fake.failOn = '/submit';
    await expect(rail.provision(input)).rejects.toThrow();
    await new AirwallexRail({
      clientId: 'c',
      apiKey: 'k',
      fetch: fake.fetch,
      custody: 'connected',
    }).provision(input);
    expect(fake.accounts.size).toBe(1);
  });
});

describe('opening a Global Account past the sandbox cap', () => {
  it('says which currency and country Airwallex refused', async () => {
    const fake = new FakeAirwallex();
    const rail = new AirwallexRail({ clientId: 'c', apiKey: 'k', fetch: fake.fetch });
    await rail.balances();
    fake.failNext = {
      status: 400,
      body: { code: 'NO_MORE_VBA_ALLOWED', message: 'no more GA is allowed for currencies: [EUR]' },
    };
    await expect(
      rail.provision({
        requestId: 'member-1',
        countryCode: 'DE',
        currency: 'EUR',
        nickName: 'Seller',
        transferMethods: ['LOCAL'],
        beneficiary: { entity_type: 'COMPANY' },
      }),
    ).rejects.toMatchObject({
      code: 'rail_refused',
      message: 'Airwallex will not open more EUR accounts in DE on this account',
    });
  });
});

describe('setting up a pooled member after the payee was refused', () => {
  const input = {
    requestId: 'member-1',
    countryCode: 'NL',
    currency: 'EUR',
    nickName: 'Seller',
    transferMethods: ['LOCAL' as const],
    beneficiary: { entity_type: 'COMPANY' },
  };

  it('keeps the Global Account it made and finishes on the retry', async () => {
    const fake = new FakeAirwallex();
    const rail = new AirwallexRail({ clientId: 'c', apiKey: 'k', fetch: fake.fetch });
    fake.failOn = '/beneficiaries/create';
    await expect(rail.provision(input)).rejects.toThrow('down');
    const refs = await rail.provision(input);
    expect(fake.globalAccounts).toHaveLength(1);
    expect(refs.airwallex_deposit_account).toBe(fake.globalAccounts[0]?.id);
    expect(refs.airwallex_beneficiary).toBeDefined();
  });

  it('still reports the payee problem on the retry, not the repeated account', async () => {
    const fake = new FakeAirwallex();
    const rail = new AirwallexRail({ clientId: 'c', apiKey: 'k', fetch: fake.fetch });
    fake.failOn = '/beneficiaries/create';
    await expect(rail.provision(input)).rejects.toThrow('down');
    fake.failOn = '/beneficiaries/create';
    await expect(rail.provision(input)).rejects.toThrow('down');
  });

  it('passes on a repeated request it cannot match to an account', async () => {
    const fake = new FakeAirwallex();
    const rail = new AirwallexRail({ clientId: 'c', apiKey: 'k', fetch: fake.fetch });
    fake.failNext = { status: 400, body: { code: 'DUPLICATED_REQUEST', message: 'duplicated' } };
    await expect(rail.provision(input)).rejects.toThrow('duplicated');
  });
});

describe('what the sandbox guide requires', () => {
  it('sends no API version on FX calls, and does on everything else', async () => {
    const stand = new FakeAirwallex();
    const seen: { url: string; version: string | null }[] = [];
    const capturing: typeof fetch = (url, init) => {
      seen.push({ url: String(url), version: new Headers(init?.headers).get('x-api-version') });
      return stand.fetch(url, init);
    };
    const rail = new AirwallexRail({
      clientId: 'c',
      apiKey: 'k',
      webhookSecret: 's',
      fetch: capturing,
    });
    await rail.quote('GBP', 'EUR');
    await rail.balances();
    expect(seen.find((c) => c.url.includes('/fx/'))?.version).toBeNull();
    expect(seen.find((c) => c.url.includes('/balances'))?.version).toBeTruthy();
  });
});
