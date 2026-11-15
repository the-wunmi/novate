// The periods statements, reports and exports are read over. Months and days are cut in the tenant's
// zone, as the server cuts business days, and are cut again whenever that zone changes. Every period
// is measured from the moment it was chosen, so the same choice keeps asking for the same rows.
import { useState } from 'react';
import { dayStart, monthStart, zoneName } from './time.ts';

interface Range {
  from: string | null;
  to: string | null;
}

const daysBefore = (at: number, days: number) => new Date(at - days * 86_400_000).toISOString();

const PERIODS = {
  month: {
    label: () => `This month (${zoneName()})`,
    range: (at: number): Range => ({ from: monthStart(0, new Date(at)).toISOString(), to: null }),
  },
  lastMonth: {
    label: () => `Last month (${zoneName()})`,
    range: (at: number): Range => ({
      from: monthStart(-1, new Date(at)).toISOString(),
      to: monthStart(0, new Date(at)).toISOString(),
    }),
  },
  '30d': {
    label: () => 'Last 30 days',
    range: (at: number): Range => ({ from: daysBefore(at, 30), to: null }),
  },
  '90d': {
    label: () => 'Last 90 days',
    range: (at: number): Range => ({ from: daysBefore(at, 90), to: null }),
  },
  all: { label: () => 'All', range: (): Range => ({ from: null, to: null }) },
  custom: { label: () => 'Custom', range: (): Range => ({ from: null, to: null }) },
} satisfies Record<string, { label: () => string; range: (at: number) => Range }>;

export type PeriodKey = keyof typeof PERIODS;

/** Every period an export can cover. */
export const EXPORT_PERIODS: readonly PeriodKey[] = [
  'month',
  'lastMonth',
  '30d',
  '90d',
  'all',
  'custom',
];

/** A `YYYY-MM-DD` day in the tenant's zone: the instant it began, or the next day began. */
const dayEdge = (day: string, after: boolean) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return dayStart(y, m, d + (after ? 1 : 0)).toISOString();
};

/** The period chosen among `keys`, the first by default, and the query that asks for it. */
export function usePeriod(keys: readonly PeriodKey[]) {
  const [chosen, setChosen] = useState(() => ({ key: keys[0] ?? 'all', at: Date.now() }));
  const [days, setDays] = useState({ from: '', to: '' });
  const custom = chosen.key === 'custom';
  const { from, to } = custom
    ? {
        from: days.from ? dayEdge(days.from, false) : null,
        to: days.to ? dayEdge(days.to, true) : null,
      }
    : PERIODS[chosen.key].range(chosen.at);
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return {
    key: chosen.key,
    from,
    to,
    query: params.toString() ? `?${params}` : '',
    /** Nothing is asked for until this holds: a custom period needs both days, the first not after the last. */
    ready: !custom || (!!days.from && !!days.to && days.from <= days.to),
    days,
    setDays,
    choose: (key: PeriodKey) => setChosen({ key, at: Date.now() }),
    keys,
  };
}

export type Period = ReturnType<typeof usePeriod>;

export function PeriodSwitch({ period }: { period: Period }) {
  return (
    <>
      <div className="seg">
        {period.keys.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={period.key === k}
            onClick={() => period.choose(k)}
          >
            {PERIODS[k].label()}
          </button>
        ))}
      </div>
      {period.key === 'custom' && (
        <span className="period-days">
          <input
            type="date"
            aria-label="From"
            value={period.days.from}
            max={period.days.to || undefined}
            onChange={(e) => period.setDays({ ...period.days, from: e.target.value })}
          />
          <input
            type="date"
            aria-label="To"
            value={period.days.to}
            min={period.days.from || undefined}
            onChange={(e) => period.setDays({ ...period.days, to: e.target.value })}
          />
        </span>
      )}
    </>
  );
}
