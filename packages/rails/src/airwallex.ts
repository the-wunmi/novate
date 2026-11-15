import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Currency, DomainError, minorUnits, toMajor } from '@novate/core';
import type {
  CardAcceptance,
  CardResult,
  FxConvertRequest,
  FxQuote,
  FxResult,
  PayeeInput,
  ProvisionInput,
  RailBalance,
  RailCapabilities,
  RailEvent,
  RailEventType,
  RailPoll,
  RailRequest,
  RailResult,
  RailStatus,
  RailTransaction,
  SettlementRail,
} from './index.ts';
import { depositDetailsOf, payeeRefs, provisionRefs } from './refs.ts';

export interface AirwallexConfig {
  clientId: string;
  apiKey: string;
  /** Without one every webhook is refused, and only polling reports what happened. */
  webhookSecret?: string;
  /** Defaults to the sandbox, so production has to be asked for by name. */
  baseUrl?: string;
  /** Pinned so a change to Airwallex's default version cannot change behaviour. */
  apiVersion?: string;
  /** `reason` on payouts to a bank. Defaults to `goods_purchased`. */
  transferReason?: string;
  /** `pooled`: one account, ledger says whose. `connected`: each member is a connected account. */
  custody?: 'pooled' | 'connected';
  /** Ask Airwallex to skip 3DS on card payments. It refuses unless it has enabled this for you. */
  skip3ds?: boolean;
  fetch?: typeof fetch;
}

export const AIRWALLEX_SANDBOX = 'https://api.sandbox.airwallex.com';
const API_VERSION = '2026-08-21';
/** Account-to-account movements take a closed list of reasons, unlike transfers to a bank. */
const ACCOUNT_TRANSFER_REASON = 'professional_business_services';
/** Airwallex retries for about three days. The inbox stops replays, so stale is only a limit. */
const WEBHOOK_MAX_AGE_MS = 4 * 86_400_000;
const E8 = 100_000_000n;

export class AirwallexError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(`Airwallex ${status} ${code ?? ''}: ${message}`);
    this.name = 'AirwallexError';
  }
}

/** Parse a decimal into minor units, rounding, because Airwallex balances are plain numbers. */
export function decimalToMinor(value: string | number, currency: Currency): bigint {
  return scale(String(value), minorUnits(currency));
}

function scale(value: string, digits: number): bigint {
  const text = /e/i.test(value) ? Number(value).toFixed(digits + 2) : value;
  const match = /^(-?)(\d*)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const [, sign, whole = '0', frac = ''] = match;
  let minor = BigInt((whole || '0') + frac.padEnd(digits, '0').slice(0, digits));
  if ((frac[digits] ?? '0') >= '5') minor += 1n;
  return sign ? -minor : minor;
}

/** Transfers end in PAID. Charges and connected account transfers end in SETTLED. */
const PAYMENT_STATUS: Record<string, RailStatus> = {
  PAID: 'confirmed',
  SETTLED: 'confirmed',
  FAILED: 'failed',
  CANCELLED: 'failed',
  APPROVAL_REJECTED: 'failed',
  APPROVAL_RECALLED: 'failed',
  APPROVAL_BLOCKED: 'failed',
};

const FX_STATUS: Record<string, FxResult['status']> = {
  SETTLED: 'confirmed',
  CANCELLED: 'failed',
};

interface PaymentBody {
  id: string;
  status: string;
  failure?: { message?: string };
  failure_reason?: string;
  failure_reasons?: string[];
}

interface ConversionBody {
  id?: string;
  conversion_id?: string;
  request_id?: string;
  status: string;
  sell_amount: string | number;
  buy_amount: string | number;
  sell_currency: Currency;
  buy_currency: Currency;
}

/**
 * Airwallex, in one of two custody models.
 *
 * Pooled: one platform account holds members' money and the ledger says whose it is. Each member
 * gets a Global Account for attributing deposits and a beneficiary for payouts. It cannot debit a
 * member, so net debtors are asked to send money in.
 *
 * Connected: each member is a connected account. Funds are pulled with Charges when they are
 * needed and paid to the member's own wallet with a connected account transfer.
 */
export class AirwallexRail implements SettlementRail {
  readonly name = 'airwallex';
  readonly environment: 'live' | 'sandbox';
  readonly capabilities: RailCapabilities;
  readonly provisionNeeds: 'beneficiary' | 'connectedAccount';
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #connected: boolean;
  #token?: { value: string; expiresAt: number };
  #pollingFrom?: number;

  constructor(private readonly config: AirwallexConfig) {
    this.#fetch = config.fetch ?? fetch;
    this.#base = config.baseUrl ?? AIRWALLEX_SANDBOX;
    this.environment = this.#base.includes('sandbox') ? 'sandbox' : 'live';
    this.#connected = config.custody === 'connected';
    this.provisionNeeds = this.#connected ? 'connectedAccount' : 'beneficiary';
    this.capabilities = {
      pull: this.#connected,
      pullToLock: this.#connected,
      debitsOnSubmit: true,
      signedEvents: true,
    };
  }

  async #login(): Promise<string> {
    if (this.#token && this.#token.expiresAt > Date.now() + 60_000) return this.#token.value;
    const res = await this.#fetch(`${this.#base}/api/v1/authentication/login`, {
      method: 'POST',
      headers: { 'x-client-id': this.config.clientId, 'x-api-key': this.config.apiKey },
    });
    if (!res.ok) throw new AirwallexError(res.status, undefined, 'login failed', undefined);
    const body = (await res.json()) as { token: string; expires_at?: string };
    const parsed = body.expires_at ? Date.parse(body.expires_at) : Number.NaN;
    this.#token = {
      value: body.token,
      expiresAt: Number.isNaN(parsed) ? Date.now() + 25 * 60_000 : parsed,
    };
    return body.token;
  }

  async #call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const token = await this.#login();
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        // The builder guide says FX calls must go without this header.
        ...(path.startsWith('/api/v1/fx/')
          ? {}
          : { 'x-api-version': this.config.apiVersion ?? API_VERSION }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried) {
      this.#token = undefined;
      return this.#call(method, path, body, true);
    }
    const text = await res.text();
    const parsed = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (!res.ok) {
      throw new AirwallexError(
        res.status,
        parsed.code as string | undefined,
        String(parsed.message ?? text),
        parsed.details as Record<string, unknown> | undefined,
      );
    }
    return parsed as T;
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  async collect(req: RailRequest): Promise<RailResult> {
    if (!this.#connected) {
      // Pooled custody has no way to debit a member. The cycle waits for them to send money in.
      return { status: 'requires_funding', externalRef: `funding:${req.idempotencyKey}` };
    }
    const source = req.member.railRefs.airwallex_account;
    if (!source) return missingRef(req, 'member has no connected account');
    return this.#submit(req, '/api/v1/charges', { ...this.#movement(req), source });
  }

  async payout(req: RailRequest): Promise<RailResult> {
    if (this.#connected) {
      const destination = req.member.railRefs.airwallex_account;
      if (!destination) return missingRef(req, 'member has no connected account');
      return this.#submit(req, '/api/v1/connected_account_transfers', {
        ...this.#movement(req),
        destination,
      });
    }
    const beneficiaryId = req.member.railRefs.airwallex_beneficiary;
    if (!beneficiaryId) return missingRef(req, 'member has no beneficiary');
    const method = req.member.railRefs.airwallex_transfer_method;
    return this.#submit(req, '/api/v1/transfers', {
      request_id: req.idempotencyKey,
      beneficiary_id: beneficiaryId,
      transfer_currency: req.currency,
      transfer_amount: toMajor(req.amount, req.currency),
      source_currency: req.currency,
      reason: this.#reason,
      reference: req.reference.slice(0, 140),
      // LOCAL unless the member needs otherwise: a SWIFT payout costs about EUR 13.
      transfer_method: method ?? 'LOCAL',
    });
  }

  get #reason() {
    return this.config.transferReason ?? 'goods_purchased';
  }

  /** Fields shared by a Charge and a connected account transfer. */
  #movement(req: RailRequest) {
    return {
      request_id: req.idempotencyKey,
      amount: toMajor(req.amount, req.currency),
      currency: req.currency,
      reason: ACCOUNT_TRANSFER_REASON,
      reference: req.reference.slice(0, 140),
    };
  }

  /** Create a payment. A repeat returns the original; only a definite refusal counts as failed. */
  async #submit(req: RailRequest, path: string, body: unknown): Promise<RailResult> {
    try {
      return paymentResult(await this.#call<PaymentBody>('POST', `${path}/create`, body));
    } catch (err) {
      if (!(err instanceof AirwallexError)) throw err;
      if (isDuplicate(err)) {
        // It may have been sent. Without a record to read, the answer is unknown, never "failed".
        const { items } = await this.#call<{ items: PaymentBody[] }>(
          'GET',
          `${path}?request_id=${encodeURIComponent(req.idempotencyKey)}`,
        );
        if (!items[0]) throw err;
        return paymentResult(items[0]);
      }
      if (isRefusal(err)) {
        return {
          status: 'failed',
          externalRef: `rejected:${req.idempotencyKey}`,
          reason: err.message,
        };
      }
      throw err;
    }
  }

  async status(externalRef: string, direction: 'collect' | 'payout'): Promise<RailResult> {
    const path = !this.#connected
      ? '/api/v1/transfers'
      : direction === 'collect'
        ? '/api/v1/charges'
        : '/api/v1/connected_account_transfers';
    return paymentResult(await this.#call<PaymentBody>('GET', `${path}/${externalRef}`));
  }

  // ── FX ───────────────────────────────────────────────────────────────────

  async quote(sell: Currency, buy: Currency): Promise<FxQuote> {
    const body = await this.#call<{
      quote_id: string;
      buy_amount: string | number;
      sell_amount: string | number;
    }>('POST', '/api/v1/fx/quotes/create', {
      buy_currency: buy,
      sell_currency: sell,
      buy_amount: '10000',
      validity: 'HR_1',
    });
    return {
      quoteId: body.quote_id,
      sellCurrency: sell,
      buyCurrency: buy,
      rateE8: impliedRate(body.buy_amount, body.sell_amount),
    };
  }

  async convert(req: FxConvertRequest): Promise<FxResult> {
    const submit = (requestId: string, quoteId: string | undefined) =>
      this.#call<ConversionBody>('POST', '/api/v1/fx/conversions/create', {
        request_id: requestId,
        buy_currency: req.buyCurrency,
        sell_currency: req.sellCurrency,
        buy_amount: toMajor(req.buyAmount, req.buyCurrency),
        ...(quoteId ? { quote_id: quoteId } : {}),
      });
    try {
      return fxResult(await submit(req.idempotencyKey, req.quoteId));
    } catch (err) {
      if (!(err instanceof AirwallexError)) throw err;
      // A repeated request id is rejected, so a retry after a lost reply finds the original.
      const marketKey = `${req.idempotencyKey}-m`;
      const existing = await this.#findConversion([req.idempotencyKey, marketKey]);
      if (existing) return fxResult(existing);
      if (err.code === 'expired_quote' || err.code === 'invalid_quote_id') {
        return fxResult(await submit(marketKey, undefined));
      }
      throw err;
    }
  }

  async #findConversion(requestIds: string[]): Promise<ConversionBody | undefined> {
    for (const id of requestIds) {
      const { items } = await this.#call<{ items: ConversionBody[] }>(
        'GET',
        `/api/v1/fx/conversions?request_id=${encodeURIComponent(id)}`,
      );
      if (items[0]) return items[0];
    }
    return undefined;
  }

  async fxStatus(externalRef: string): Promise<FxResult> {
    return fxResult(
      await this.#call<ConversionBody>('GET', `/api/v1/fx/conversions/${externalRef}`),
    );
  }

  // ── Reconciliation ───────────────────────────────────────────────────────

  async balances(): Promise<RailBalance[]> {
    type Row = { currency: Currency; total_amount: string | number; account_type?: string };
    const rows = await this.#call<Row[] | { items: Row[] }>('GET', '/api/v1/balances/current');
    const list = Array.isArray(rows) ? rows : rows.items;
    return list
      .filter((b) => (b.account_type ?? 'cash') === 'cash')
      .map((b) => ({
        currency: b.currency,
        total: decimalToMinor(b.total_amount, b.currency),
      }));
  }

  async transactions(since: Date): Promise<RailTransaction[]> {
    const out: RailTransaction[] = [];
    for (let page = 0; page <= 2000; page++) {
      const body = await this.#call<{
        has_more: boolean;
        items: {
          amount: string | number;
          currency: Currency;
          source_id: string;
          source_type: string;
          status: string;
          created_at: string;
          settled_at?: string;
          fee?: string | number;
        }[];
      }>(
        'GET',
        `/api/v1/financial_transactions?from_created_at=${encodeURIComponent(since.toISOString())}&page_num=${page}&page_size=1000`,
      );
      for (const t of body.items) {
        out.push({
          externalRef: t.source_id,
          currency: t.currency,
          amount: decimalToMinor(t.amount, t.currency),
          ...(t.fee === undefined ? {} : { fee: decimalToMinor(t.fee, t.currency) }),
          status: t.status === 'SETTLED' ? 'settled' : 'pending',
          sourceType: t.source_type,
          occurredAt: t.settled_at ?? t.created_at,
        });
      }
      if (!body.has_more) break;
    }
    return out;
  }

  // ── Webhooks ─────────────────────────────────────────────────────────────

  parseEvent(rawBody: string, headers: Record<string, string>): RailEvent {
    const timestamp = headers['x-timestamp'];
    const signature = headers['x-signature'];
    if (!timestamp || !signature) throw new Error('missing signature headers');
    if (!this.config.webhookSecret) throw new Error('no webhook secret is configured');
    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(timestamp + rawBody)
      .digest('hex');
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');
    if (Math.abs(Date.now() - Number(timestamp)) > WEBHOOK_MAX_AGE_MS)
      throw new Error('stale event');

    const event = JSON.parse(rawBody) as {
      id: string;
      name: string;
      created_at: string;
      data?: Record<string, unknown>;
    };
    const type = eventType(event.name);
    // Payment intents nest the resource under `object`. Deposits, transfers and conversions do not.
    const object = (event.data?.object ?? event.data ?? {}) as Record<string, unknown>;
    const currency = object.currency as Currency | undefined;
    const rawAmount = object.amount as string | number | undefined;
    return {
      id: event.id,
      type,
      occurredAt: event.created_at,
      externalRef: (object.id ?? object.conversion_id) as string | undefined,
      depositAccountRef: object.global_account_id as string | undefined,
      currency,
      amount: rawAmount !== undefined && currency ? decimalToMinor(rawAmount, currency) : undefined,
      ...feeOf(object),
      // A payment intent can carry card details, and this is stored.
      raw:
        type === 'card.updated'
          ? { name: event.name }
          : (event as unknown as Record<string, unknown>),
    };
  }

  // ── Card payments, as the merchant ───────────────────────────────────────

  readonly cards: CardAcceptance = {
    create: async (input) => {
      const body = await this.#call<IntentBody>('POST', '/api/v1/pa/payment_intents/create', {
        request_id: input.requestId,
        merchant_order_id: input.orderId,
        amount: Number(toMajor(input.amount, input.currency)),
        currency: input.currency,
        descriptor: input.descriptor,
        // The cardholder already approved this payment with a passkey when the mandate was made.
        ...(this.config.skip3ds
          ? { payment_method_options: { card: { three_ds_action: 'SKIP_3DS' } } }
          : {}),
      });
      return { intentId: body.id };
    },
    confirm: async (intentId, requestId, card) => {
      try {
        const body = await this.#call<IntentBody>(
          'POST',
          `/api/v1/pa/payment_intents/${intentId}/confirm`,
          {
            request_id: requestId,
            payment_method: {
              type: 'card',
              card: {
                number: card.number,
                expiry_month: card.expiryMonth,
                expiry_year: card.expiryYear,
                cvc: card.cvc,
                name: card.name,
              },
            },
          },
        );
        // An agent cannot answer a bank's challenge, so the intent is closed rather than left open.
        if (body.status === 'REQUIRES_CUSTOMER_ACTION') {
          await this.#call('POST', `/api/v1/pa/payment_intents/${intentId}/cancel`, {
            request_id: randomUUID(),
            cancellation_reason: '3DS challenge cannot be completed by an agent',
          }).catch(() => undefined);
          return { status: 'failed', intentId, reason: 'three_ds_challenge_required' };
        }
        return cardResult(body);
      } catch (err) {
        if (!(err instanceof AirwallexError)) throw err;
        // Only the status leaves here, in case the rail's error text repeats what it was sent.
        if (err.status >= 500 || [408, 429].includes(err.status))
          throw new Error(`Airwallex answered ${err.status} confirming a card payment`);
        // A repeat of a confirm that worked or is still running is refused too, so ask the intent.
        const body = await this.#call<IntentBody>('GET', `/api/v1/pa/payment_intents/${intentId}`);
        const current = cardResult(body);
        // Without a failed attempt nothing says this was declined, so it is not called declined.
        return current.status === 'failed' && !body.latest_payment_attempt?.failure_code
          ? { status: 'pending', intentId }
          : current;
      }
    },
    status: async (intentId) =>
      cardResult(await this.#call<IntentBody>('GET', `/api/v1/pa/payment_intents/${intentId}`)),
  };

  // ── Member set-up and sandbox ────────────────────────────────────────────

  /** Open what a member needs: a connected account, or in pooled custody an account and payee. */
  async provision(input: ProvisionInput): Promise<Record<string, string>> {
    if (this.#connected) return this.#openConnectedAccount(input);
    if (!input.beneficiary) throw new Error('Pooled custody needs a beneficiary');
    const account = await this.#globalAccount(input);
    const beneficiary = await this.#createBeneficiary(input.beneficiary, input.transferMethods);
    return provisionRefs(this.name, {
      depositAccount: account.id,
      details: depositDetailsOf(account, input.currency),
      beneficiary,
      payee: input.beneficiary,
    });
  }

  /** A new payee for a member whose accounts are open: where its payouts go from now on. */
  async addPayee(input: PayeeInput): Promise<Record<string, string>> {
    if (this.#connected) throw new DomainError('invalid', 'Connected accounts are paid directly');
    const id = await this.#createBeneficiary(input.beneficiary, input.transferMethods);
    return payeeRefs(this.name, id, input.beneficiary);
  }

  async #createBeneficiary(
    beneficiary: Record<string, unknown>,
    transferMethods: ProvisionInput['transferMethods'],
  ): Promise<string> {
    const made = await this.#call<{ id: string }>('POST', '/api/v1/beneficiaries/create', {
      beneficiary,
      transfer_methods: transferMethods,
    });
    return made.id;
  }

  /** Airwallex refuses a repeated request id, so a retry finds the account the first try made. */
  async #globalAccount(input: ProvisionInput): Promise<{ id: string } & Record<string, unknown>> {
    try {
      return await this.#call('POST', '/api/v1/global_accounts/create', {
        request_id: input.requestId,
        country_code: input.countryCode,
        nick_name: input.nickName,
        required_features: [
          { currency: input.currency, transfer_method: input.transferMethods[0] },
        ],
      });
    } catch (err) {
      // Airwallex caps Global Accounts per currency and country, and closed ones still count.
      if (err instanceof AirwallexError && err.code === 'NO_MORE_VBA_ALLOWED') {
        throw new DomainError(
          'rail_refused',
          `Airwallex will not open more ${input.currency} accounts in ${input.countryCode} on this account`,
        );
      }
      if (!(err instanceof AirwallexError && err.code === 'DUPLICATED_REQUEST')) throw err;
      const query = new URLSearchParams({ nick_name: input.nickName, page_size: '100' });
      const { items } = await this.#call<{
        items: ({ id: string; request_id: string } & Record<string, unknown>)[];
      }>('GET', `/api/v1/global_accounts?${query}`);
      const made = items.find((a) => a.request_id === input.requestId);
      if (!made) throw err;
      return made;
    }
  }

  /**
   * Create and submit the account, and in the sandbox approve it. The create call has no idempotency
   * key, so a step retried after a later call failed picks up the account it already made.
   */
  async #openConnectedAccount(input: ProvisionInput): Promise<Record<string, string>> {
    if (!input.connectedAccount) throw new Error('Connected custody needs account details');
    const query = new URLSearchParams({ identifier: input.requestId });
    const { items } = await this.#call<{ items: { id: string }[] }>(
      'GET',
      `/api/v1/accounts?${query}`,
    );
    const id =
      items[0]?.id ??
      (
        await this.#call<{ id: string }>('POST', '/api/v1/accounts/create', {
          ...input.connectedAccount,
          identifier: input.requestId,
        })
      ).id;
    let status = await this.#accountStatus(id);
    if (status === 'CREATED') {
      await this.#call('POST', `/api/v1/accounts/${id}/submit`, {});
      for (let i = 0; i < SUBMIT_POLLS && status === 'CREATED'; i++) {
        status = await this.#accountStatus(id);
        if (status === 'CREATED') await sleep(SUBMIT_POLL_MS);
      }
    }
    if (this.#base === AIRWALLEX_SANDBOX && status === 'SUBMITTED') {
      await this.#call('POST', `/api/v1/simulation/accounts/${id}/update_status`, {
        next_status: 'ACTIVE',
      });
    }
    return { airwallex_account: id };
  }

  async #accountStatus(id: string): Promise<string> {
    return (await this.#call<{ status: string }>('GET', `/api/v1/accounts/${id}`)).status;
  }

  /** Deposits a missed webhook would otherwise lose. Repeats are safe: deposits post once per id. */
  async pollEvents(cursor: bigint | null): Promise<RailPoll> {
    const now = BigInt(Date.now());
    if (cursor === null) {
      this.#pollingFrom = Number(now);
      return { events: [], cursor: now, caughtUp: true };
    }
    // Starts a little early, because a deposit can be listed after one created later. Never before
    // polling began, or money already on the account would be credited as if it had just arrived.
    const from = new Date(
      Math.max(Number(cursor) - DEPOSIT_POLL_OVERLAP_MS, this.#pollingFrom ?? 0),
    ).toISOString();
    const events: RailEvent[] = [];
    for (let page = 0; page < MAX_DEPOSIT_PAGES; page++) {
      const query = new URLSearchParams({
        from_created_at: from,
        page_num: String(page),
        page_size: String(DEPOSIT_PAGE_SIZE),
      });
      const { items } = await this.#call<{ items: DepositBody[] }>(
        'GET',
        `/api/v1/deposits?${query}`,
      );
      events.push(...items.flatMap(depositEvent));
      if (items.length < DEPOSIT_PAGE_SIZE) break;
    }
    return { events, cursor: now, caughtUp: true };
  }

  /** Subscribe a URL to every event novate acts on, replacing any earlier one for this path. */
  async registerWebhook(url: string): Promise<string> {
    const path = new URL(url).pathname;
    const { items } = await this.#call<{ items: { id: string; url: string }[] }>(
      'GET',
      '/api/v1/webhooks',
    );
    for (const old of items.filter((w) => new URL(w.url).pathname === path)) {
      await this.#call('POST', `/api/v1/webhooks/${old.id}/delete`, {});
    }
    const { secret } = await this.#call<{ secret: string }>('POST', '/api/v1/webhooks/create', {
      request_id: randomUUID(),
      url,
      version: this.config.apiVersion ?? API_VERSION,
      events: WEBHOOK_EVENTS,
    });
    return secret;
  }

  /** Sandbox only: money arriving at a Global Account. */
  simulateDeposit(input: { globalAccountId: string; amount: bigint; currency: Currency }) {
    return this.#call<{ id: string }>('POST', '/api/v1/simulation/deposit/create', {
      global_account_id: input.globalAccountId,
      amount: toMajor(input.amount, input.currency),
    });
  }

  /** Sandbox only: move a transfer along its lifecycle. */
  simulateTransfer(
    id: string,
    nextStatus: 'PROCESSING' | 'SENT' | 'PAID' | 'FAILED' | 'CANCELLED',
  ) {
    return this.#call('POST', `/api/v1/simulation/transfers/${id}/transition`, {
      next_status: nextStatus,
    });
  }
}

interface DepositBody {
  id: string;
  status: string;
  amount: string | number;
  currency: Currency;
  global_account_id?: string;
  created_at: string;
}

const SUBMIT_POLLS = 10;
const SUBMIT_POLL_MS = 500;
const DEPOSIT_POLL_OVERLAP_MS = 10 * 60_000;
const DEPOSIT_PAGE_SIZE = 100;
const MAX_DEPOSIT_PAGES = 50;

const WEBHOOK_EVENTS = [
  'deposit.settled',
  'deposit.reversed',
  'conversion.settled',
  'conversion.cancelled',
  'payout.transfer.paid',
  'payout.transfer.failed',
  'payout.transfer.cancelled',
  'charge.settled',
  'charge.failed',
  'connected_account_transfer.settled',
  'connected_account_transfer.failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.cancelled',
];

/** Worked out from the two amounts, so it cannot be misread for the pair's quoting direction. */
const impliedRate = (buy: string | number, sell: string | number) =>
  (scale(String(buy), 8) * E8) / scale(String(sell), 8);

function paymentResult(body: PaymentBody): RailResult {
  const status = PAYMENT_STATUS[body.status] ?? 'submitted';
  return {
    status,
    externalRef: body.id,
    ...(status === 'failed'
      ? {
          reason:
            body.failure?.message ??
            body.failure_reason ??
            body.failure_reasons?.join('; ') ??
            body.status,
        }
      : {}),
  };
}

interface IntentBody {
  id: string;
  status: string;
  latest_payment_attempt?: { id?: string; failure_code?: string };
}

/** Anything else is still moving, so it is asked about again rather than assumed to have failed. */
const CARD_STATUS: Record<string, CardResult['status']> = {
  SUCCEEDED: 'succeeded',
  REQUIRES_PAYMENT_METHOD: 'failed',
  REQUIRES_CUSTOMER_ACTION: 'failed',
  CANCELLED: 'failed',
};

function cardResult(body: IntentBody): CardResult {
  const status = CARD_STATUS[body.status] ?? 'pending';
  const attempt = body.latest_payment_attempt;
  return {
    status,
    intentId: body.id,
    ...(attempt?.id ? { attemptRef: attempt.id } : {}),
    ...(status === 'failed' ? { reason: attempt?.failure_code ?? body.status } : {}),
  };
}

const missingRef = (req: RailRequest, reason: string): RailResult => ({
  status: 'failed',
  externalRef: `noref:${req.idempotencyKey}`,
  reason,
});

const isDuplicate = (err: AirwallexError) =>
  ['duplicate_request_id', 'request_id_duplicate', 'duplicate_request'].includes(err.code ?? '');

/** Our access, a timeout or a busy rail say nothing about this payment. The rest are final. */
const isRefusal = (err: AirwallexError) =>
  err.status >= 400 &&
  err.status < 500 &&
  ![401, 403, 408, 409, 429].includes(err.status) &&
  err.code !== 'service_unavailable';

const DEPOSIT_EVENTS: Record<string, RailEventType> = {
  SETTLED: 'deposit.settled',
  REVERSED: 'deposit.reversed',
};

function depositEvent(d: DepositBody): RailEvent[] {
  const type = DEPOSIT_EVENTS[d.status];
  if (!type) return [];
  return [
    {
      id: `deposit-poll:${d.id}:${d.status}`,
      type,
      occurredAt: d.created_at,
      externalRef: d.id,
      depositAccountRef: d.global_account_id,
      currency: d.currency,
      amount: decimalToMinor(d.amount, d.currency),
      raw: { id: d.id, status: d.status },
    },
  ];
}

function feeOf(object: Record<string, unknown>): Pick<RailEvent, 'fee'> {
  const { fee_amount: amount, fee_currency: currency } = object;
  if (amount === undefined || typeof currency !== 'string') return {};
  return {
    fee: {
      currency: currency as Currency,
      amount: decimalToMinor(amount as string | number, currency as Currency),
    },
  };
}

function fxResult(body: ConversionBody): FxResult {
  const sellAmount = decimalToMinor(body.sell_amount, body.sell_currency);
  const buyAmount = decimalToMinor(body.buy_amount, body.buy_currency);
  return {
    status: FX_STATUS[body.status] ?? 'submitted',
    externalRef: (body.id ?? body.conversion_id) as string,
    sellAmount,
    buyAmount,
    rateE8: impliedRate(body.buy_amount, body.sell_amount),
  };
}

function eventType(name: string): RailEventType {
  if (/^payment_intent\.(succeeded|payment_failed|cancelled)$/.test(name)) return 'card.updated';
  if (name === 'deposit.settled') return 'deposit.settled';
  if (name === 'deposit.reversed') return 'deposit.reversed';
  if (name === 'conversion.settled') return 'fx.confirmed';
  if (name === 'conversion.cancelled') return 'fx.failed';
  if (
    /^(payout\.transfer\.paid|connected_account_transfer\.settled|charge\.settled)$/i.test(name)
  ) {
    return 'payment.confirmed';
  }
  if (
    /^(payout\.transfer\.(failed|cancelled)|connected_account_transfer\.failed|charge\.failed)$/i.test(
      name,
    )
  ) {
    return 'payment.failed';
  }
  return 'other';
}
