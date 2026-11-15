import { describe, expect, it } from 'vitest';
import { AirwallexRail } from '../src/index.ts';

const { AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY, AIRWALLEX_WEBHOOK_SECRET } = process.env;
const live = Boolean(AIRWALLEX_CLIENT_ID && AIRWALLEX_API_KEY);

/** Read-only checks against the real sandbox. Run by `pnpm test:live`; skipped until keys are in `.env`. */
describe.skipIf(!live)('airwallex sandbox (live)', () => {
  const rail = () =>
    new AirwallexRail({
      clientId: AIRWALLEX_CLIENT_ID as string,
      apiKey: AIRWALLEX_API_KEY as string,
      webhookSecret: AIRWALLEX_WEBHOOK_SECRET ?? 'unused',
    });

  it('returns a usable quote', async () => {
    const q = await rail().quote('GBP', 'EUR');
    expect(q.rateE8).toBeGreaterThan(0n);
  }, 30_000);

  it('reads balances', async () => {
    expect(Array.isArray(await rail().balances())).toBe(true);
  }, 30_000);

  it('reads transactions', async () => {
    const since = new Date(Date.now() - 86_400_000);
    expect(Array.isArray(await rail().transactions(since))).toBe(true);
  }, 30_000);
});
