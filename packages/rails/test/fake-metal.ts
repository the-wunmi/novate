import {
  type MetalAttempt,
  type MetalAttemptStore,
  type MetalClient,
  MetalRefusal,
  type MetalSettlement,
  type MetalTransfer,
} from '../src/index.ts';

/** A stand-in for the chain, following Metal's documented finality and failure behaviour. */
export class FakeMetal implements MetalClient {
  readonly houseAddress = '0xHouse';
  readonly tokenAddress = '0xToken';
  signed = 0;
  broadcasts: string[] = [];
  /** Lose the next broadcast, as a network failure would. */
  dropNext = false;
  /** Have the node refuse the next broadcast. */
  refuseNext = false;
  #balance = 0n;
  // Starts from the clock, so a fresh chain never sits behind a saved cursor or nonce.
  #run = Date.now();
  #block = BigInt(this.#run);
  #mined = new Map<string, { to: string; value: bigint; final: boolean; revert: boolean }>();
  #logs: (MetalTransfer & { block: bigint })[] = [];
  outcome: 'ok' | 'revert' | 'quarantine' = 'ok';

  credit(from: string, value: bigint, txHash = `0xdep${this.#run}${this.#logs.length}`) {
    this.#block++;
    this.#balance += value;
    this.#logs.push({
      txHash,
      logIndex: 0,
      from,
      to: this.houseAddress,
      value,
      block: this.#block,
    });
  }

  async signTransfer(to: string, value: bigint) {
    const n = this.signed++;
    return { txHash: `0xtx${this.#run}${n}`, raw: `raw:${n}:${to}:${value}`, nonce: this.#run + n };
  }

  async broadcast(raw: string) {
    this.broadcasts.push(raw);
    if (this.refuseNext) {
      this.refuseNext = false;
      throw new MetalRefusal('insufficient gas-token balance');
    }
    if (this.dropNext) {
      this.dropNext = false;
      throw new Error('socket hang up');
    }
    const [, n, to, value] = raw.split(':') as [string, string, string, string];
    const hash = `0xtx${this.#run}${n}`;
    if (!this.#mined.has(hash)) {
      this.#mined.set(hash, {
        to,
        value: BigInt(value),
        final: false,
        revert: this.outcome === 'revert',
      });
    }
  }

  finalize() {
    for (const [hash, t] of this.#mined) {
      if (t.final) continue;
      t.final = true;
      this.#block++;
      if (t.revert) continue;
      this.#balance -= t.value;
      const to =
        this.outcome === 'quarantine' ? '0x0000000000000000000000000000000000000f4d' : t.to;
      this.#logs.push({
        txHash: hash,
        logIndex: 0,
        from: this.houseAddress,
        to,
        value: t.value,
        block: this.#block,
      });
    }
  }

  async settlement(txHash: string): Promise<MetalSettlement> {
    const t = this.#mined.get(txHash);
    if (!t) return { state: 'unknown' };
    if (!t.final) return { state: 'pending' };
    return {
      state: 'final',
      success: !t.revert,
      transfers: this.#logs.filter((l) => l.txHash === txHash),
      feeBase: 0n,
    };
  }

  async balance() {
    return this.#balance;
  }

  async finalizedBlock() {
    return this.#block;
  }

  async firstBlockAt() {
    return 0n;
  }

  async transfers(from: bigint, to: bigint) {
    return this.#logs.filter((l) => l.block >= from && l.block <= to);
  }
}

export class MemoryAttempts implements MetalAttemptStore {
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
