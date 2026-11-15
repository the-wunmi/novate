import type { Currency } from '@novate/core';

export * from './airwallex.ts';
export * from './metal.ts';
export * from './metal-client.ts';
export * from './mock.ts';

export interface RailMember {
  id: string;
  /** Rail-specific ids, e.g. `{ airwallex_beneficiary: '…' }`. */
  railRefs: Record<string, string>;
}

export interface RailRequest {
  /** Rails must treat a repeated key as the same instruction. */
  idempotencyKey: string;
  member: RailMember;
  currency: Currency;
  amount: bigint;
  reference: string;
}

/**
 * `submitted` is not a failure: real payments stay in flight for days. Callers keep waiting.
 * `requires_funding` means this rail cannot pull from the member, who has to send money in.
 */
export type RailStatus = 'submitted' | 'confirmed' | 'failed' | 'requires_funding';

export interface RailResult {
  status: RailStatus;
  externalRef: string;
  reason?: string;
}

export interface RailCapabilities {
  /** Can this rail debit a member, or must the member send money in? */
  pull: boolean;
  /** Does the rail's balance drop when a payment is submitted, rather than when it lands? */
  debitsOnSubmit: boolean;
  /** Should a shortfall on a lock be pulled from the member, rather than waiting for a deposit? */
  pullToLock: boolean;
  /** Are webhooks cryptographically signed? Unsigned rails never get a public endpoint. */
  signedEvents: boolean;
}

export interface FxQuote {
  quoteId?: string;
  sellCurrency: Currency;
  buyCurrency: Currency;
  /** Buy-currency major units per sell-currency major unit, times 10^8. */
  rateE8: bigint;
}

export interface FxConvertRequest {
  idempotencyKey: string;
  sellCurrency: Currency;
  buyCurrency: Currency;
  /** The amount being bought. Conversions are always dealt on the buy side. */
  buyAmount: bigint;
  quoteId?: string;
}

export interface FxResult {
  status: 'submitted' | 'confirmed' | 'failed';
  externalRef: string;
  sellAmount: bigint;
  buyAmount: bigint;
  rateE8: bigint;
  reason?: string;
}

export interface ProvisionInput {
  requestId: string;
  countryCode: string;
  currency: Currency;
  nickName: string;
  /** Rail-specific details of where the member is paid. Pooled custody. */
  beneficiary?: Record<string, unknown>;
  /** Rail-specific details of the account to open for the member. Connected custody. */
  connectedAccount?: Record<string, unknown>;
  transferMethods: ('LOCAL' | 'SWIFT')[];
}

export interface RailPoll {
  events: RailEvent[];
  cursor: bigint;
  /** False when there is more to read, so a backlog after downtime clears in one go. */
  caughtUp: boolean;
}

export interface RailBalance {
  currency: Currency;
  /** Settled money, including any amount in flight on the rail. */
  total: bigint;
}

export interface RailTransaction {
  externalRef: string;
  currency: Currency;
  /** Signed: positive money in, negative money out. */
  amount: bigint;
  /** What the rail kept from this amount, when it reports one. */
  fee?: bigint;
  status: 'pending' | 'settled';
  sourceType: string;
  occurredAt: string;
}

/** A charge the rail took for itself, listed under the id of the money movement it was for. */
export const isRailFee = (t: RailTransaction): boolean => t.sourceType === 'FEE';

export type RailEventType =
  | 'deposit.settled'
  | 'deposit.reversed'
  | 'payment.confirmed'
  | 'payment.failed'
  | 'payment.returned'
  | 'fx.confirmed'
  | 'fx.failed'
  | 'card.updated'
  | 'other';

export interface RailEvent {
  /** Stable across redelivery. */
  id: string;
  type: RailEventType;
  occurredAt: string;
  externalRef?: string;
  /** Rail-side account a deposit landed in, used to attribute it to a member. */
  depositAccountRef?: string;
  currency?: Currency;
  amount?: bigint;
  /** What the rail keeps when it hands a failed payout back. */
  fee?: { currency: Currency; amount: bigint };
  raw: Record<string, unknown>;
}

export interface CardDetails {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
  name: string;
}

/** `failed` is final for this payment. `pending` means ask again later. */
export interface CardResult {
  status: 'succeeded' | 'pending' | 'failed';
  intentId: string;
  /** What this payment is called in the rail's transaction list. */
  attemptRef?: string;
  reason?: string;
}

/** Taking a card payment as the merchant. Card details pass through and are never kept. */
export interface CardAcceptance {
  create(input: {
    requestId: string;
    orderId: string;
    amount: bigint;
    currency: Currency;
    descriptor: string;
  }): Promise<{ intentId: string }>;
  confirm(intentId: string, requestId: string, card: CardDetails): Promise<CardResult>;
  status(intentId: string): Promise<CardResult>;
}

/**
 * A way to move money in or out of the house. Airwallex, a bank file, a mock. Confirmation is not
 * final on real rails: `payment.returned` and `deposit.reversed` can arrive after `confirmed`.
 */
export interface SettlementRail {
  readonly name: string;
  readonly capabilities: RailCapabilities;
  collect(req: RailRequest): Promise<RailResult>;
  payout(req: RailRequest): Promise<RailResult>;
  status(externalRef: string, direction: 'collect' | 'payout'): Promise<RailResult>;
  quote(sell: Currency, buy: Currency): Promise<FxQuote>;
  convert(req: FxConvertRequest): Promise<FxResult>;
  fxStatus(externalRef: string): Promise<FxResult>;
  balances(): Promise<RailBalance[]>;
  transactions(since: Date): Promise<RailTransaction[]>;
  /** Present on rails where the house can act as a card merchant. */
  readonly cards?: CardAcceptance;
  /** Create whatever the member needs on this rail, returning refs to store on the member. */
  provision?(input: ProvisionInput): Promise<Record<string, string>>;
  /** For rails with no webhooks: what has happened since a cursor, in finalized form only. */
  pollEvents?(cursor: bigint | null): Promise<RailPoll>;
  /** Verify a webhook against its signature. Throws when the signature is wrong. */
  parseEvent(rawBody: string, headers: Record<string, string>): RailEvent;
}

export class RailRegistry {
  readonly #rails = new Map<string, SettlementRail>();

  register(rail: SettlementRail): this {
    this.#rails.set(rail.name, rail);
    return this;
  }

  has(name: string): boolean {
    return this.#rails.has(name);
  }

  get(name: string): SettlementRail {
    const rail = this.#rails.get(name);
    if (!rail) throw new Error(`No settlement rail registered: ${name}`);
    return rail;
  }

  all(): SettlementRail[] {
    return [...this.#rails.values()];
  }
}
