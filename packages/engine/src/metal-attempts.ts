import { railOutgoingAttempts } from '@novate/db';
import type { MetalAttempt, MetalAttemptStore } from '@novate/rails';
import { and, eq, isNotNull } from 'drizzle-orm';
import { deps } from './deps.ts';

const RAIL = 'metal';

type Row = typeof railOutgoingAttempts.$inferSelect;

const toAttempt = (r: Row | undefined): MetalAttempt | undefined =>
  r && {
    idempotencyKey: r.idempotencyKey,
    txHash: r.txHash,
    nonce: r.nonce,
    raw: r.raw,
    recipient: r.recipient,
    value: BigInt(r.value),
  };

/** Metal's signed payments, kept in Postgres. A unique nonce stops two processes colliding. */
export class PostgresMetalAttempts implements MetalAttemptStore {
  async find(idempotencyKey: string) {
    const [row] = await deps()
      .db.select()
      .from(railOutgoingAttempts)
      .where(
        and(
          eq(railOutgoingAttempts.rail, RAIL),
          eq(railOutgoingAttempts.idempotencyKey, idempotencyKey),
        ),
      );
    return toAttempt(row);
  }

  async findByHash(txHash: string) {
    const [row] = await deps()
      .db.select()
      .from(railOutgoingAttempts)
      .where(and(eq(railOutgoingAttempts.rail, RAIL), eq(railOutgoingAttempts.txHash, txHash)));
    return toAttempt(row);
  }

  async save(attempt: MetalAttempt) {
    await deps()
      .db.insert(railOutgoingAttempts)
      .values({ ...attempt, rail: RAIL, value: attempt.value.toString() });
  }

  /** Frees the nonce of a payment the network refused, so it cannot block the ones after it. */
  async discard(txHash: string) {
    await deps()
      .db.delete(railOutgoingAttempts)
      .where(and(eq(railOutgoingAttempts.rail, RAIL), eq(railOutgoingAttempts.txHash, txHash)));
  }

  async recordFee(txHash: string, feeBase: bigint) {
    await deps()
      .db.update(railOutgoingAttempts)
      .set({ fee: feeBase.toString() })
      .where(and(eq(railOutgoingAttempts.rail, RAIL), eq(railOutgoingAttempts.txHash, txHash)));
  }

  async totalFees() {
    const rows = await deps()
      .db.select({ fee: railOutgoingAttempts.fee })
      .from(railOutgoingAttempts)
      .where(and(eq(railOutgoingAttempts.rail, RAIL), isNotNull(railOutgoingAttempts.fee)));
    return rows.reduce((acc, r) => acc + BigInt(r.fee as string), 0n);
  }
}
