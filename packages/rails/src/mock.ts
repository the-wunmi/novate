import { createHash } from 'node:crypto';
import { type Currency, fxSellAmount } from '@novate/core';
import type {
  CardAcceptance,
  CardResult,
  FxConvertRequest,
  FxQuote,
  FxResult,
  RailBalance,
  RailCapabilities,
  RailEvent,
  RailRequest,
  RailResult,
  RailTransaction,
  SettlementRail,
} from './index.ts';

export interface MockRailOptions {
  /** Whether this rail can debit members. Airwallex pooled custody cannot. */
  pull?: boolean;
  pullToLock?: boolean;
  /** Confirm immediately (default) or report `submitted` until `settle` or a status poll. */
  async?: boolean;
  /** With `async`, stay `submitted` on status polls until `settle` is called. */
  holdUntilSettled?: boolean;
  failCollectionsFor?: Set<string>;
  failPayoutsFor?: Set<string>;
  /** Members whose next payout fails, once. */
  failNextPayoutFor?: Set<string>;
  /** Buy-currency units per sell-currency unit. */
  rates?: Record<string, number>;
  name?: string;
}

interface Payment {
  direction: 'collect' | 'payout';
  req: RailRequest;
  result: RailResult;
}

const DEFAULT_RATES: Record<string, number> = { 'GBP/EUR': 1.15, 'EUR/GBP': 0.87 };

/** In-memory rail that behaves like a real one: asynchronous, fallible, and able to reverse. */
export class MockRail implements SettlementRail {
  /** Charging this number is declined, as a real issuer might. */
  static readonly DECLINED_CARD = '4000000000000002';
  readonly name: string;
  readonly cardIntents = new Map<string, MockCardIntent>();
  /** Every number actually charged, to prove a retry did not charge again. */
  readonly cardsCharged: string[] = [];
  /** The next confirm charges the card, then loses the answer. */
  loseNextCardAnswer = false;
  readonly capabilities: RailCapabilities;
  readonly #payments = new Map<string, Payment>();
  readonly #fx = new Map<string, FxResult>();
  readonly #cash = new Map<string, bigint>();
  readonly #transactions: RailTransaction[] = [];
  readonly log: { direction: 'collect' | 'payout'; req: RailRequest; result: RailResult }[] = [];
  readonly conversions: FxConvertRequest[] = [];
  rates: Record<string, number>;

  constructor(private readonly opts: MockRailOptions = {}) {
    this.name = opts.name ?? 'mock';
    this.capabilities = {
      pull: opts.pull ?? true,
      pullToLock: opts.pullToLock ?? false,
      debitsOnSubmit: false,
      signedEvents: false,
    };
    this.rates = { ...DEFAULT_RATES, ...opts.rates };
  }

  collect(req: RailRequest) {
    return this.#submit('collect', req);
  }

  payout(req: RailRequest) {
    return this.#submit('payout', req);
  }

  async status(externalRef: string): Promise<RailResult> {
    const found = this.#byRef(externalRef);
    if (!found) return { status: 'failed', externalRef, reason: 'unknown reference' };
    if (found.result.status === 'submitted' && !this.opts.holdUntilSettled)
      this.settle(externalRef);
    return { ...found.result };
  }

  /** Move an in-flight payment to confirmed, as the bank eventually would. */
  settle(externalRef: string): void {
    const found = this.#byRef(externalRef);
    if (found?.result.status !== 'submitted') return;
    found.result.status = 'confirmed';
    this.#book(found, externalRef);
  }

  /** Take a card payment as the merchant. Cash only arrives when `settleCard` is called. */
  readonly cards: CardAcceptance = {
    create: async (input) => {
      const intentId = `mockint_${hash(input.requestId)}`;
      if (!this.cardIntents.has(intentId)) {
        this.cardIntents.set(intentId, {
          amount: input.amount,
          currency: input.currency,
          attemptRef: `mockatt_${hash(input.requestId)}`,
          status: 'pending',
        });
      }
      return { intentId };
    },
    confirm: async (intentId, _requestId, card) => {
      const intent = this.cardIntents.get(intentId);
      if (!intent) throw new Error(`Unknown intent ${intentId}`);
      if (intent.status === 'pending') {
        this.cardsCharged.push(card.number);
        intent.status = card.number === MockRail.DECLINED_CARD ? 'failed' : 'succeeded';
      }
      if (this.loseNextCardAnswer) {
        this.loseNextCardAnswer = false;
        throw new Error('connection lost');
      }
      return this.cards.status(intentId);
    },
    status: async (intentId) => {
      const intent = this.cardIntents.get(intentId);
      if (!intent) throw new Error(`Unknown intent ${intentId}`);
      return {
        status: intent.status,
        intentId,
        attemptRef: intent.attemptRef,
        ...(intent.status === 'failed' ? { reason: 'do_not_honor' } : {}),
      };
    },
  };

  /** The rail paying captured card money over, less its fee. */
  settleCard(intentId: string, fee = 0n): void {
    const intent = this.cardIntents.get(intentId);
    if (intent?.status !== 'succeeded') throw new Error(`Nothing to settle for ${intentId}`);
    this.#cash.set(intent.currency, (this.#cash.get(intent.currency) ?? 0n) + intent.amount - fee);
    this.#transactions.push({
      externalRef: intent.attemptRef,
      currency: intent.currency,
      amount: intent.amount,
      fee,
      status: 'settled',
      sourceType: 'PAYMENT_ATTEMPT',
      occurredAt: new Date().toISOString(),
    });
  }

  async quote(sell: Currency, buy: Currency): Promise<FxQuote> {
    const rate = this.rates[`${sell}/${buy}`];
    if (rate === undefined) throw new Error(`No mock rate for ${sell}/${buy}`);
    return { sellCurrency: sell, buyCurrency: buy, rateE8: BigInt(Math.round(rate * 1e8)) };
  }

  async convert(req: FxConvertRequest): Promise<FxResult> {
    const prior = this.#fx.get(req.idempotencyKey);
    if (prior) return { ...prior };
    const { rateE8 } = await this.quote(req.sellCurrency, req.buyCurrency);
    const sellAmount = fxSellAmount(req.buyAmount, rateE8, req.sellCurrency, req.buyCurrency);
    const externalRef = `mockfx_${hash(req.idempotencyKey)}`;
    const result: FxResult = {
      status: 'confirmed',
      externalRef,
      sellAmount,
      buyAmount: req.buyAmount,
      rateE8,
    };
    this.#fx.set(req.idempotencyKey, result);
    this.conversions.push(req);
    this.#add(req.sellCurrency, -sellAmount, externalRef, 'CONVERSION');
    this.#add(req.buyCurrency, req.buyAmount, externalRef, 'CONVERSION');
    return { ...result };
  }

  async fxStatus(externalRef: string): Promise<FxResult> {
    const found = [...this.#fx.values()].find((r) => r.externalRef === externalRef);
    if (!found) throw new Error(`Unknown conversion ${externalRef}`);
    return { ...found };
  }

  async balances(): Promise<RailBalance[]> {
    return [...this.#cash].map(([currency, total]) => ({ currency, total }));
  }

  async transactions(since: Date): Promise<RailTransaction[]> {
    return this.#transactions.filter((t) => Date.parse(t.occurredAt) >= since.getTime());
  }

  parseEvent(rawBody: string): RailEvent {
    return JSON.parse(rawBody, (k, v) => (k === 'amount' ? BigInt(v) : v)) as RailEvent;
  }

  /** Money arriving on the rail, as a bank transfer would. */
  simulateDeposit(currency: Currency, amount: bigint, externalRef: string): void {
    this.#add(currency, amount, externalRef, 'DEPOSIT');
  }

  /** The rail taking a fee for an earlier movement, listed under that movement's id. */
  simulateFee(currency: Currency, amount: bigint, externalRef: string): void {
    this.#add(currency, -amount, externalRef, 'FEE');
  }

  /** Alter rail cash without telling the ledger, to exercise reconciliation. */
  corrupt(currency: Currency, delta: bigint): void {
    this.#cash.set(currency, (this.#cash.get(currency) ?? 0n) + delta);
  }

  #byRef(externalRef: string) {
    return [...this.#payments.values()].find((p) => p.result.externalRef === externalRef);
  }

  #book(payment: Payment, externalRef: string) {
    const sign = payment.direction === 'collect' ? 1n : -1n;
    this.#add(
      payment.req.currency,
      sign * payment.req.amount,
      externalRef,
      payment.direction === 'collect' ? 'CHARGE' : 'PAYOUT',
    );
  }

  #add(currency: Currency, amount: bigint, externalRef: string, sourceType: string) {
    this.#cash.set(currency, (this.#cash.get(currency) ?? 0n) + amount);
    this.#transactions.push({
      externalRef,
      currency,
      amount,
      status: 'settled',
      sourceType,
      occurredAt: new Date().toISOString(),
    });
  }

  async #submit(direction: 'collect' | 'payout', req: RailRequest): Promise<RailResult> {
    const prior = this.#payments.get(req.idempotencyKey);
    if (prior) return { ...prior.result };
    const externalRef = `mock_${hash(req.idempotencyKey)}`;
    if (direction === 'collect' && !this.capabilities.pull) {
      return { status: 'requires_funding', externalRef };
    }
    const failed =
      (direction === 'collect' && this.opts.failCollectionsFor?.has(req.member.id)) ||
      (direction === 'payout' && this.opts.failPayoutsFor?.has(req.member.id)) ||
      (direction === 'payout' && this.opts.failNextPayoutFor?.delete(req.member.id));
    const result: RailResult = failed
      ? { status: 'failed', externalRef, reason: 'rejected by the bank' }
      : { status: this.opts.async ? 'submitted' : 'confirmed', externalRef };
    const payment = { direction, req, result };
    this.#payments.set(req.idempotencyKey, payment);
    if (result.status === 'confirmed') this.#book(payment, externalRef);
    this.log.push({ direction, req, result: { ...result } });
    return { ...result };
  }
}

interface MockCardIntent {
  amount: bigint;
  currency: Currency;
  attemptRef: string;
  status: CardResult['status'];
}

const hash = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);
