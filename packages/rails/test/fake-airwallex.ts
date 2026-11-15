import { randomUUID } from 'node:crypto';

/**
 * An in-memory stand-in for Airwallex, written only from its public docs. It proves the rail is
 * consistent with what the docs describe. It cannot prove the docs match the real API.
 */
export class FakeAirwallex {
  calls: { method: string; path: string; body: unknown }[] = [];
  logins = 0;
  rates: Record<string, number> = { 'GBP/EUR': 1.15, 'EUR/GBP': 0.87 };
  cash = new Map<string, number>();
  transfers = new Map<string, Record<string, unknown>>();
  transactions: Record<string, unknown>[] = [];
  charges = new Map<string, Record<string, unknown>>();
  intents = new Map<string, Record<string, unknown>>();
  accounts = new Map<string, Record<string, unknown>>();
  deposits: Record<string, unknown>[] = [];
  lastDepositsFrom?: string;
  /** The next card confirmed asks the cardholder for a 3DS challenge. */
  challengeNext = false;
  globalAccounts: { id: string; request_id: string; nick_name: string }[] = [];
  private byRequest = new Map<string, string>();
  private conversions = new Map<string, Record<string, unknown>>();
  failNext?: { status: number; body: unknown };
  /** The next call to a path ending in this fails. */
  failOn?: string;

  private add(currency: string, amount: number, id: string, type: string) {
    this.cash.set(currency, Number(((this.cash.get(currency) ?? 0) + amount).toFixed(2)));
    this.transactions.push({
      amount,
      currency,
      source_id: id,
      source_type: type,
      status: 'SETTLED',
      created_at: new Date().toISOString(),
    });
  }

  deposit(currency: string, amount: number, id = randomUUID()) {
    this.add(currency, amount, id, 'DEPOSIT');
    return id;
  }

  setCharge(id: string, status: string) {
    const c = this.charges.get(id);
    if (c) c.status = status;
  }

  setTransfer(id: string, status: string) {
    const t = this.transfers.get(id);
    if (t) t.status = status;
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path, body });
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (path === '/api/v1/authentication/login') {
      this.logins++;
      return reply(200, {
        token: `t${this.logins}`,
        expires_at: new Date(Date.now() + 1_800_000).toISOString(),
      });
    }
    if (this.failOn && path.endsWith(this.failOn)) {
      this.failOn = undefined;
      return reply(500, { code: 'unavailable', message: 'down' });
    }
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = undefined;
      return reply(f.status, f.body);
    }
    if (path === '/api/v1/global_accounts/create') {
      const made = this.globalAccounts.find((a) => a.request_id === body.request_id);
      if (made) return reply(400, { code: 'DUPLICATED_REQUEST', message: 'duplicated' });
      const account = { id: randomUUID(), request_id: body.request_id, nick_name: body.nick_name };
      this.globalAccounts.push(account);
      return reply(201, account);
    }
    if (path === '/api/v1/global_accounts') {
      const name = url.searchParams.get('nick_name');
      return reply(200, { items: this.globalAccounts.filter((a) => a.nick_name === name) });
    }
    if (path === '/api/v1/beneficiaries/create') return reply(201, { id: randomUUID() });
    if (path === '/api/v1/fx/quotes/create') {
      const rate = this.rates[`${body.sell_currency}/${body.buy_currency}`] as number;
      return reply(201, {
        quote_id: randomUUID(),
        buy_amount: Number(body.buy_amount),
        sell_amount: Number((Number(body.buy_amount) / rate).toFixed(2)),
      });
    }
    if (path === '/api/v1/fx/conversions/create') {
      if (this.conversions.has(body.request_id))
        return reply(400, { code: 'operation_failed', message: 'duplicate' });
      const rate = this.rates[`${body.sell_currency}/${body.buy_currency}`] as number;
      const buy = Number(body.buy_amount);
      const sell = Number((buy / rate).toFixed(2));
      const c = {
        id: randomUUID(),
        request_id: body.request_id,
        status: 'SETTLED',
        buy_amount: buy,
        sell_amount: sell,
        buy_currency: body.buy_currency,
        sell_currency: body.sell_currency,
      };
      this.conversions.set(body.request_id, c);
      this.add(body.buy_currency, buy, c.id, 'CONVERSION');
      this.add(body.sell_currency, -sell, c.id, 'CONVERSION');
      return reply(201, c);
    }
    if (path === '/api/v1/fx/conversions') {
      const wanted = url.searchParams.get('request_id');
      return reply(200, {
        items: [...this.conversions.values()].filter((c) => c.request_id === wanted),
      });
    }
    if (path === '/api/v1/transfers/create') {
      const existing = this.byRequest.get(body.request_id);
      if (existing) return reply(400, { code: 'duplicate_request_id', message: 'dup' });
      const t = { id: randomUUID(), status: 'PROCESSING', request_id: body.request_id };
      this.transfers.set(t.id, t);
      this.byRequest.set(body.request_id, t.id);
      this.add(body.transfer_currency, -Number(body.transfer_amount), t.id, 'PAYOUT');
      return reply(201, t);
    }
    if (path === '/api/v1/deposits') {
      this.lastDepositsFrom = url.searchParams.get('from_created_at') ?? undefined;
      return reply(200, { items: this.deposits });
    }
    if (
      path === '/api/v1/transfers' ||
      path === '/api/v1/charges' ||
      path === '/api/v1/connected_account_transfers'
    ) {
      const wanted = url.searchParams.get('request_id');
      const found =
        path.endsWith('transfers') && !path.includes('connected')
          ? [...this.transfers.values()].filter((t) => t.request_id === wanted)
          : [...this.charges.values()].filter((c) => c.request_id === wanted);
      return reply(200, { items: found });
    }
    if (path.startsWith('/api/v1/transfers/')) {
      const t = this.transfers.get(path.split('/').at(-1) as string);
      return t ? reply(200, t) : reply(404, { code: 'not_found', message: 'none' });
    }
    if (
      path === '/api/v1/charges/create' ||
      path === '/api/v1/connected_account_transfers/create'
    ) {
      const repeat = [...this.charges.values()].find((c) => c.request_id === body.request_id);
      if (repeat) return reply(400, { code: 'request_id_duplicate', message: 'dup' });
      const c = { id: randomUUID(), status: 'PENDING', request_id: body.request_id };
      this.charges.set(c.id, c);
      return reply(201, c);
    }
    if (
      path.startsWith('/api/v1/charges/') ||
      path.startsWith('/api/v1/connected_account_transfers/')
    ) {
      const c = this.charges.get(path.split('/').at(-1) as string);
      return c ? reply(200, c) : reply(404, { code: 'not_found', message: 'none' });
    }
    if (path === '/api/v1/pa/payment_intents/create') {
      const i = { id: `int_${randomUUID()}`, status: 'REQUIRES_PAYMENT_METHOD', ...body };
      this.intents.set(i.id, i);
      return reply(201, i);
    }
    const intent = path.match(/^\/api\/v1\/pa\/payment_intents\/([^/]+)(\/confirm|\/cancel)?$/);
    if (intent) {
      const i = this.intents.get(intent[1] as string);
      if (!i) return reply(404, { code: 'not_found', message: 'none' });
      if (!intent[2]) return reply(200, i);
      if (intent[2] === '/cancel') {
        i.status = 'CANCELLED';
        return reply(200, i);
      }
      if (this.challengeNext) {
        this.challengeNext = false;
        i.status = 'REQUIRES_CUSTOMER_ACTION';
        return reply(200, i);
      }
      if (i.status === 'SUCCEEDED')
        return reply(400, { code: 'invalid_status', message: 'already confirmed' });
      const declined = body.payment_method.card.number === '4000000000000002';
      i.status = declined ? 'REQUIRES_PAYMENT_METHOD' : 'SUCCEEDED';
      i.latest_payment_attempt = {
        id: `att_${randomUUID()}`,
        ...(declined ? { failure_code: 'authorization_failed' } : {}),
      };
      return reply(200, i);
    }
    if (path === '/api/v1/accounts') {
      const identifier = url.searchParams.get('identifier');
      return reply(200, {
        items: [...this.accounts.values()].filter((a) => a.identifier === identifier),
      });
    }
    if (path === '/api/v1/accounts/create') {
      const a = { id: `acct_${randomUUID()}`, status: 'CREATED', ...body };
      this.accounts.set(a.id, a);
      return reply(201, a);
    }
    const account = path.match(/\/accounts\/(acct_[^/]+)\/(submit|update_status)$/);
    if (account) {
      const a = this.accounts.get(account[1] as string);
      if (!a) return reply(404, { code: 'not_found', message: 'none' });
      a.status = account[2] === 'submit' ? 'SUBMITTED' : body.next_status;
      return reply(200, a);
    }
    if (path.startsWith('/api/v1/accounts/acct_')) {
      const a = this.accounts.get(path.split('/').at(-1) as string);
      return a ? reply(200, a) : reply(404, { code: 'not_found', message: 'none' });
    }
    if (path === '/api/v1/balances/current') {
      return reply(
        200,
        [...this.cash].map(([currency, total_amount]) => ({ currency, total_amount })),
      );
    }
    if (path === '/api/v1/financial_transactions')
      return reply(200, { has_more: false, items: this.transactions });
    return reply(404, { code: 'not_found', message: path });
  };
}
