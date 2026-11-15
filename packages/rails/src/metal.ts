import { type Currency, minBig } from '@novate/core';
import type { PublicClient } from 'viem';
import type {
  FxConvertRequest,
  FxQuote,
  FxResult,
  RailBalance,
  RailCapabilities,
  RailEvent,
  RailPoll,
  RailRequest,
  RailResult,
  RailTransaction,
  SettlementRail,
} from './index.ts';

/** Metal's dollar token has 18 decimals, and the ledger holds USD in cents. */
const BASE_UNITS_PER_CENT = 10n ** 16n;
const USD = 'USD';
/** Where a transfer lands when the recipient's receive policy quarantines it. */
const QUARANTINE = '0x0000000000000000000000000000000000000f4d';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
/** Blocks read per poll. Metal does not state a limit, so this stays modest. */
const BLOCKS_PER_POLL = 2_000n;

export interface MetalTransfer {
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
}

export interface MetalSignedTransfer {
  txHash: string;
  raw: string;
  nonce: number;
}

export type MetalSettlement =
  /** No receipt: not mined, or the node never saw it. */
  | { state: 'unknown' }
  /** Mined, but not yet in a finalized block. */
  | { state: 'pending' }
  /** Finalized. A receipt alone is not settlement on Metal. */
  | { state: 'final'; success: boolean; transfers: MetalTransfer[]; feeBase: bigint };

/** What the rail needs from the chain. Signing and reads live behind this. */
export interface MetalClient {
  readonly houseAddress: string;
  readonly tokenAddress: string;
  /** Read access to the chain, for checking what a transaction proves. */
  readonly reader?: PublicClient;
  signTransfer(to: string, value: bigint): Promise<MetalSignedTransfer>;
  broadcast(raw: string): Promise<void>;
  settlement(txHash: string): Promise<MetalSettlement>;
  balance(): Promise<bigint>;
  finalizedBlock(): Promise<bigint>;
  /** The first block at or after this time. */
  firstBlockAt(time: Date): Promise<bigint>;
  transfers(fromBlock: bigint, toBlock: bigint): Promise<MetalTransfer[]>;
}

export interface MetalAttempt {
  idempotencyKey: string;
  txHash: string;
  nonce: number;
  raw: string;
  recipient: string;
  value: bigint;
}

/**
 * Durable record of what was signed. A Metal transfer has no idempotency key of its own, so this
 * is what stops a retry paying twice: the signed bytes are saved before they are broadcast.
 */
export interface MetalAttemptStore {
  find(idempotencyKey: string): Promise<MetalAttempt | undefined>;
  findByHash(txHash: string): Promise<MetalAttempt | undefined>;
  save(attempt: MetalAttempt): Promise<void>;
  /** Forget a transaction the node refused, so its nonce is free for the next payment. */
  discard?(txHash: string): Promise<void>;
  recordFee(txHash: string, feeBase: bigint): Promise<void>;
  totalFees(): Promise<bigint>;
}

/** Attempts kept in memory, where nothing has to survive a restart: tests and one-off transfers. */
export class MemoryMetalAttempts implements MetalAttemptStore {
  rows: MetalAttempt[] = [];
  fees = new Map<string, bigint>();
  async find(key: string) {
    return this.rows.find((r) => r.idempotencyKey === key);
  }
  async findByHash(hash: string) {
    return this.rows.find((r) => r.txHash === hash);
  }
  async save(a: MetalAttempt) {
    this.rows.push(a);
  }
  async discard(hash: string) {
    this.rows = this.rows.filter((r) => r.txHash !== hash);
  }
  async recordFee(hash: string, fee: bigint) {
    this.fees.set(hash, fee);
  }
  async totalFees() {
    return [...this.fees.values()].reduce((a, b) => a + b, 0n);
  }
}

/** Metal answered and will not take this transaction. Nothing was sent. */
export class MetalRefusal extends Error {}

const unsupported = (what: string) => new Error(`Metal has no ${what}`);
const toCents = (base: bigint) => base / BASE_UNITS_PER_CENT;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * USD settlement on Metal for agent-run firms, from one house account. It cannot debit a member,
 * so net debtors send money in, and it reports only what has reached a finalized block.
 */
export class MetalRail implements SettlementRail {
  readonly name = 'metal';
  /** novate is wired to Metal's testnet; the client refuses a chain it was not set up for. */
  readonly environment = 'testnet' as const;
  readonly capabilities: RailCapabilities = {
    pull: false,
    pullToLock: false,
    debitsOnSubmit: true,
    signedEvents: false,
  };
  /** Nonces come from the pending count, so signing has to happen one at a time. */
  #signing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: MetalClient,
    private readonly store: MetalAttemptStore,
  ) {}

  async collect(req: RailRequest): Promise<RailResult> {
    return { status: 'requires_funding', externalRef: `funding:${req.idempotencyKey}` };
  }

  async payout(req: RailRequest): Promise<RailResult> {
    const refused = this.#refusal(req);
    if (refused) return refused;
    const run = this.#signing.then(() => this.#sendOnce(req));
    this.#signing = run.catch(() => undefined);
    return run;
  }

  #refusal(req: RailRequest): RailResult | null {
    const externalRef = `rejected:${req.idempotencyKey}`;
    if (req.currency !== USD)
      return { status: 'failed', externalRef, reason: 'Metal settles USD only' };
    if (!req.member.railRefs.metal_account) {
      return { status: 'failed', externalRef, reason: 'member has no Metal account' };
    }
    return null;
  }

  async #sendOnce(req: RailRequest): Promise<RailResult> {
    const existing = await this.store.find(req.idempotencyKey);
    if (existing) return this.status(existing.txHash);
    const recipient = req.member.railRefs.metal_account as string;
    const value = req.amount * BASE_UNITS_PER_CENT;
    try {
      const signed = await this.client.signTransfer(recipient, value);
      await this.store.save({ ...signed, idempotencyKey: req.idempotencyKey, recipient, value });
      try {
        await this.client.broadcast(signed.raw);
      } catch (err) {
        if (!(err instanceof MetalRefusal))
          return { status: 'submitted', externalRef: signed.txHash };
        await this.store.discard?.(signed.txHash);
        throw err;
      }
      return { status: 'submitted', externalRef: signed.txHash };
    } catch (err) {
      if (!(err instanceof MetalRefusal)) throw err;
      const externalRef = `rejected:${req.idempotencyKey}`;
      return { status: 'failed', externalRef, reason: err.message };
    }
  }

  /** A lost or repeated broadcast is unknown, never failed. `status` will send the same bytes. */
  async #rebroadcast(raw: string): Promise<void> {
    await this.client.broadcast(raw).catch(() => undefined);
  }

  async status(externalRef: string): Promise<RailResult> {
    const attempt = await this.store.findByHash(externalRef);
    if (!attempt) return { status: 'failed', externalRef, reason: 'unknown transaction' };
    const settlement = await this.client.settlement(externalRef);
    if (settlement.state === 'unknown') await this.#rebroadcast(attempt.raw);
    if (settlement.state !== 'final') return { status: 'submitted', externalRef };

    await this.store.recordFee(externalRef, settlement.feeBase);
    if (!settlement.success)
      return { status: 'failed', externalRef, reason: 'transaction reverted' };
    const paid = settlement.transfers.some(
      (t) => same(t.to, attempt.recipient) && t.value === attempt.value,
    );
    // Quarantined money has left the house but not reached the member. It must not be sent again,
    // so it stays open and is flagged in doubt for someone to resolve.
    return paid ? { status: 'confirmed', externalRef } : { status: 'submitted', externalRef };
  }

  async quote(sell: Currency, buy: Currency): Promise<FxQuote> {
    if (sell !== buy) throw unsupported('FX');
    return { sellCurrency: sell, buyCurrency: buy, rateE8: 100_000_000n };
  }

  async convert(_req: FxConvertRequest): Promise<FxResult> {
    throw unsupported('FX');
  }

  async fxStatus(_externalRef: string): Promise<FxResult> {
    throw unsupported('FX');
  }

  /** Gas is paid from the house account, so it is added back to compare with the ledger. */
  async balances(): Promise<RailBalance[]> {
    const [balance, fees] = await Promise.all([this.client.balance(), this.store.totalFees()]);
    return [{ currency: USD, total: toCents(balance + fees) }];
  }

  async transactions(since: Date): Promise<RailTransaction[]> {
    const latest = await this.client.finalizedBlock();
    const start = await this.client.firstBlockAt(since);
    const house = this.client.houseAddress;
    const occurredAt = new Date().toISOString();
    return (await this.client.transfers(start, latest)).flatMap((t) => {
      if (same(t.to, house) && this.#isDeposit(t)) {
        return [movement(depositRef(t), toCents(t.value), occurredAt, 'DEPOSIT')];
      }
      return same(t.from, house)
        ? [movement(t.txHash, -toCents(t.value), occurredAt, 'PAYOUT')]
        : [];
    });
  }

  /** Mints and releases of held balances credit the house but are nobody's deposit. */
  #isDeposit(t: MetalTransfer): boolean {
    return (
      !same(t.from, ZERO_ADDRESS) &&
      !same(t.from, this.client.tokenAddress) &&
      !same(t.from, QUARANTINE) &&
      toCents(t.value) > 0n
    );
  }

  /** Metal has no webhooks, so finalized deposits are read from the chain. */
  async pollEvents(cursor: bigint | null): Promise<RailPoll> {
    const latest = await this.client.finalizedBlock();
    // A position past the chain's head can never be reached, and would silently stop all deposits.
    const from = cursor === null || cursor > latest ? latest : cursor + 1n;
    if (from > latest) return { events: [], cursor: cursor ?? latest, caughtUp: true };
    const to = minBig(from + BLOCKS_PER_POLL, latest);
    const transfers = await this.client.transfers(from, to);
    const events = transfers
      .filter((t) => same(t.to, this.client.houseAddress) && this.#isDeposit(t))
      .map(
        (t): RailEvent => ({
          id: `metal:${depositRef(t)}`,
          type: 'deposit.settled',
          occurredAt: new Date().toISOString(),
          externalRef: depositRef(t),
          depositAccountRef: t.from.toLowerCase(),
          currency: USD,
          amount: toCents(t.value),
          raw: { txHash: t.txHash, logIndex: t.logIndex, from: t.from },
        }),
      );
    return { events, cursor: to, caughtUp: to === latest };
  }

  parseEvent(): RailEvent {
    throw unsupported('webhooks');
  }
}

const depositRef = (t: MetalTransfer) => `${t.txHash}:${t.logIndex}`;

const movement = (
  externalRef: string,
  amount: bigint,
  occurredAt: string,
  sourceType: string,
): RailTransaction => ({
  externalRef,
  currency: USD,
  amount,
  status: 'settled',
  sourceType,
  occurredAt,
});
