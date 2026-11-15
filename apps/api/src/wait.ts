import { setTimeout as sleep } from 'node:timers/promises';

export async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  { timeoutMs = 180_000, everyMs = 700 } = {},
): Promise<T> {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > stop) throw new Error(`Gave up waiting for ${what}`);
    await sleep(everyMs);
  }
}
