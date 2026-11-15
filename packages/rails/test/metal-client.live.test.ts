import { describe, expect, it } from 'vitest';
import { createMetalClient } from '../src/index.ts';

const { METAL_RPC_URL, METAL_PRIVATE_KEY } = process.env;

/** Read-only checks against the real network. Run by `pnpm test:live`; skipped until the endpoint and key are in `.env`. */
describe.skipIf(!METAL_RPC_URL || !METAL_PRIVATE_KEY)('metal network (live)', () => {
  const live = () =>
    createMetalClient({
      rpcUrl: METAL_RPC_URL as string,
      privateKey: METAL_PRIVATE_KEY as `0x${string}`,
    });

  it('reads the finalized height and the house balance', async () => {
    const metal = live();
    expect(await metal.finalizedBlock()).toBeGreaterThan(0n);
    expect(await metal.balance()).toBeGreaterThanOrEqual(0n);
  }, 30_000);
});
