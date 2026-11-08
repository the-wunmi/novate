import { createHash } from 'node:crypto';
import type { Currency } from '@novate/core';

export interface RailMember {
  id: string;
  /** Rail-specific ids, e.g. `{ airwallex: 'acct_…' }`. */
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

export type RailStatus = 'submitted' | 'confirmed' | 'failed';

export interface RailResult {
  status: RailStatus;
  externalRef: string;
  reason?: string;
}

/**
 * A way to move money in or out of the house: Airwallex, Metal/x402, a bank file, a mock.
 * `collect` pulls a member's net debit; `payout` sends a net credit.
 */
export interface SettlementRail {
  readonly name: string;
  collect(req: RailRequest): Promise<RailResult>;
  payout(req: RailRequest): Promise<RailResult>;
  /** Poll the outcome of a submitted instruction (for rails that confirm asynchronously). */
  status(externalRef: string): Promise<RailResult>;
}

export class RailRegistry {
  readonly #rails = new Map<string, SettlementRail>();

  register(rail: SettlementRail): this {
    this.#rails.set(rail.name, rail);
    return this;
  }

  get(name: string): SettlementRail {
    const rail = this.#rails.get(name);
    if (!rail) throw new Error(`No settlement rail registered: ${name}`);
    return rail;
  }
}

export interface MockRailOptions {
  /** Members whose collections fail, to exercise default handling. */
  failCollectionsFor?: Set<string>;
  /** Confirm immediately (default) or report `submitted` and confirm on the first status poll. */
  async?: boolean;
}

/** Deterministic in-memory rail for tests, demos and local development. */
export class MockRail implements SettlementRail {
  readonly name = 'mock';
  readonly #seen = new Map<string, RailResult>();
  readonly log: { direction: 'collect' | 'payout'; req: RailRequest; result: RailResult }[] = [];

  constructor(private readonly opts: MockRailOptions = {}) {}

  collect(req: RailRequest) {
    return this.#submit('collect', req);
  }

  payout(req: RailRequest) {
    return this.#submit('payout', req);
  }

  async status(externalRef: string): Promise<RailResult> {
    const found = [...this.#seen.values()].find((r) => r.externalRef === externalRef);
    if (!found) return { status: 'failed', externalRef, reason: 'unknown reference' };
    if (found.status === 'submitted') found.status = 'confirmed';
    return { ...found };
  }

  async #submit(direction: 'collect' | 'payout', req: RailRequest): Promise<RailResult> {
    const prior = this.#seen.get(req.idempotencyKey);
    if (prior) return { ...prior };
    const externalRef = `mock_${createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 16)}`;
    const failed = direction === 'collect' && this.opts.failCollectionsFor?.has(req.member.id);
    const result: RailResult = failed
      ? { status: 'failed', externalRef, reason: 'insufficient funds at source' }
      : { status: this.opts.async ? 'submitted' : 'confirmed', externalRef };
    this.#seen.set(req.idempotencyKey, result);
    this.log.push({ direction, req, result: { ...result } });
    return { ...result };
  }
}
