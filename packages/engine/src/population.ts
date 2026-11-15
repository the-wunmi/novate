import { DomainError, parseInput } from '@novate/core';
import { type AnyColumn, gte, lt, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { type CsvColumn, toCsv } from './csv.ts';
import { Cursor, keyset } from './page.ts';

/**
 * A slice of a population, for an auditor who needs all of it rather than the latest page: a time
 * window, newest first, paged with `before` (the previous page's `next`).
 */
export const Population = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  before: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type PopulationInput = z.input<typeof Population>;
export type Window = z.output<typeof Population> & { limit: number };

export function populationOf(input: PopulationInput | undefined, defaultLimit: number): Window {
  const p = parseInput(Population, input ?? {});
  return { ...p, limit: p.limit ?? defaultLimit };
}

/** The conditions that keep `at` inside the window's range: from is inclusive, to is not. */
export const inRange = (at: AnyColumn, w: Pick<Window, 'from' | 'to'>): SQL[] => [
  ...(w.from ? [gte(at, w.from)] : []),
  ...(w.to ? [lt(at, w.to)] : []),
];

/** The window's range, and past the row its cursor names. */
export const within = (at: PgColumn, id: PgColumn, tenantId: string, w: Window): SQL[] => [
  ...inRange(at, w),
  ...(w.before ? [keyset(at, id, tenantId, w.before) as SQL] : []),
];

/** The most rows one export returns. Past it the caller is asked for a shorter range. */
export const EXPORT_MAX_ROWS = 100_000;
/** Without `from`, an export covers this many days up to `to` (or now). */
export const EXPORT_DEFAULT_DAYS = 31;

/** What an export covers, and whether the range was chosen for the caller. */
export interface ExportRange {
  from: Date;
  to: Date;
  /** True when no `from` was given and the last `EXPORT_DEFAULT_DAYS` days were used. */
  defaulted: boolean;
}

/** A finished export: every row in the range, never a page of it. */
export interface CsvExport extends ExportRange {
  body: string;
  rows: number;
}

/**
 * The range an export covers: `from` (inclusive) to `to` (exclusive, default now), and without
 * `from` the last 31 days. `before` and `limit` are page controls for the JSON feeds and are
 * ignored: an export is the whole population of its range. The window reads one row past the cap,
 * so a range that holds more than the cap is refused rather than cut short.
 */
export function exportRange(input: { from?: unknown; to?: unknown } | undefined): {
  range: ExportRange;
  window: Window;
} {
  const p = parseInput(Population.pick({ from: true, to: true }), {
    from: input?.from || undefined,
    to: input?.to || undefined,
  });
  const to = p.to ?? new Date();
  const from = p.from ?? new Date(to.getTime() - EXPORT_DEFAULT_DAYS * 86_400_000);
  if (from >= to) throw new DomainError('invalid', '`from` must be before `to`');
  return {
    range: { from, to, defaulted: !p.from },
    window: { from, to, limit: EXPORT_MAX_ROWS + 1 },
  };
}

/** Refuse an export that would be cut short. */
export function assertWholeExport(rows: number, range: ExportRange): void {
  if (rows > EXPORT_MAX_ROWS) {
    throw new DomainError(
      'too_large',
      `More than ${EXPORT_MAX_ROWS} rows between ${range.from.toISOString()} and ${range.to.toISOString()}: ask for a shorter range`,
      { maxRows: EXPORT_MAX_ROWS, from: range.from, to: range.to },
    );
  }
}

/** Every row of a range as CSV, refused rather than truncated when there are too many. */
export function exportCsv<T>(
  columns: readonly CsvColumn<T>[],
  rows: readonly T[],
  range: ExportRange,
): CsvExport {
  assertWholeExport(rows.length, range);
  return { ...range, body: toCsv(columns, rows), rows: rows.length };
}

/**
 * Keeps `at` within the times of rows already read from a window, so their children can be read by
 * joining on the window rather than by listing every id. The newest bound is exclusive and a
 * millisecond on, because a JavaScript date drops Postgres's microseconds.
 */
export function spanning(at: AnyColumn, times: Date[]): SQL[] {
  let oldest = Number.POSITIVE_INFINITY;
  let newest = Number.NEGATIVE_INFINITY;
  for (const t of times) {
    oldest = Math.min(oldest, t.getTime());
    newest = Math.max(newest, t.getTime());
  }
  return [gte(at, new Date(oldest)), lt(at, new Date(newest + 1))];
}
