import { z } from 'zod';

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Durations are written as `30s`, `15m`, `48h`, `14d`. */
export const Duration = z.string().regex(/^\d+[smhd]$/, 'Use e.g. 30s, 15m, 48h, 14d');
export type Duration = z.infer<typeof Duration>;

export function durationMs(d: Duration): number {
  const unit = d.at(-1) as keyof typeof UNITS;
  return Number.parseInt(d.slice(0, -1), 10) * UNITS[unit];
}
