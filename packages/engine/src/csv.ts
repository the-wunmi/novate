import { toMajor } from '@novate/core';

/** A CSV column: its header and how to read its value from a row. */
export type CsvColumn<T> = readonly [header: string, value: (row: T) => unknown];

/**
 * An amount as two columns, `<name>_minor` and `<name>_major` in the row's currency, so no reader has
 * to guess the unit.
 */
export function moneyColumns<T>(
  name: string,
  amount: (row: T) => bigint | string | number | null | undefined,
  currency: (row: T) => string | null | undefined,
): CsvColumn<T>[] {
  return [
    [`${name}_minor`, amount],
    [
      `${name}_major`,
      (row) => {
        const a = amount(row);
        const c = currency(row);
        return a === null || a === undefined || !c ? undefined : toMajor(BigInt(a), c);
      },
    ],
  ];
}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const text =
    v instanceof Date
      ? v.toISOString()
      : typeof v === 'object'
        ? JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
        : String(v);
  // A spreadsheet would run text that starts like a formula. Numbers, negative ones included, stay.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** RFC 4180 CSV with a fixed header, so a column never moves between exports. */
export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map(([name]) => name).join(',')];
  for (const row of rows) lines.push(columns.map(([, get]) => cell(get(row))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
