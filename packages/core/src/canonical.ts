import { createHash } from 'node:crypto';

/** Deterministic JSON: sorted keys, bigints as strings. Used for hashing and snapshots. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalise((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
