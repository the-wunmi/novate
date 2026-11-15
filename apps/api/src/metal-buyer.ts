import { randomUUID } from 'node:crypto';
import { type createMetalClient, MemoryMetalAttempts, MetalRail } from '@novate/rails';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { until } from './wait.ts';

/**
 * A throwaway buyer wallet with US$1.50, paid from the house's own Metal wallet. Call it before
 * novate records what the rail already holds, or the transfer shows up as an unknown difference.
 * Used by the live demo and the live Metal test, so neither needs a separately funded key.
 */
export async function fundStablecoinBuyer(
  metal: ReturnType<typeof createMetalClient>,
): Promise<`0x${string}`> {
  // Nothing durable is needed for one transfer, so attempts are kept in memory.
  const rail = new MetalRail(metal, new MemoryMetalAttempts());
  const key = generatePrivateKey();
  const sent = await rail.payout({
    idempotencyKey: randomUUID(),
    member: { id: 'buyer', railRefs: { metal_account: privateKeyToAccount(key).address } },
    currency: 'USD',
    amount: 150n,
    reference: 'test buyer',
  });
  await until(
    'the buyer wallet to be funded',
    async () => {
      const now = await rail.status(sent.externalRef);
      if (now.status === 'failed') throw new Error(`Funding the buyer failed: ${now.reason}`);
      return now.status === 'confirmed' ? true : undefined;
    },
    { everyMs: 2_000 },
  );
  return key;
}
