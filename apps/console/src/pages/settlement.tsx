import { useState } from 'react';
import { useLocation } from 'wouter';
import { useTenant } from '../api.ts';
import { ExportButton } from '../export-menu.tsx';
import { nettingTotals } from '../netting.tsx';
import { AllWithdrawals, ProblemPayouts } from '../ops.tsx';
import { PeriodSwitch, usePeriod } from '../periods.tsx';
import { NextCycles } from '../preview.tsx';
import { useSession } from '../session.tsx';
import type { CycleView, SettlementSummary } from '../types.ts';
import {
  ago,
  dateTime,
  EmptyRow,
  Kpi,
  LoadFailed,
  Money,
  PageHead,
  Panel,
  Pill,
  railName,
  sentence,
  shortId,
  type Tone,
  words,
} from '../ui.tsx';

const CYCLE_STATUS: Record<string, [string, Tone]> = {
  netting: ['Netting', 'moved'],
  settling: ['Paying out', 'moved'],
  committed: ['Booked', 'moved'],
  settled: ['Settled', 'ok'],
  failed: ['Failed', 'stop'],
  deferred: ['Held back', 'wait'],
};

export const cycleStatus = (status: string) => {
  const [label, tone] = CYCLE_STATUS[status] ?? [words(status), ''];
  return <Pill tone={tone}>{label}</Pill>;
};

/** When a settlement group settles, in words. */
export const timingText = (t: NonNullable<CycleView['settlement']>['timing']) =>
  t.mode === 'cycle' ? `every ${t.every}` : t.mode === 'immediate' ? 'real-time' : 'on demand';

/** Ops look for what went wrong first: failures, cycles held back, payouts the rail never answered. */
const STATUS_FILTERS: { key: string; label: string; test: (c: CycleView) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  {
    key: 'attention',
    label: 'Needs attention',
    test: (c) =>
      c.status === 'failed' ||
      c.status === 'deferred' ||
      c.failed.length > 0 ||
      c.paid.some((p) => p.status === 'in_doubt' || p.status === 'reversed'),
  },
  {
    key: 'running',
    label: 'In progress',
    test: (c) => !['settled', 'failed', 'deferred'].includes(c.status),
  },
  { key: 'settled', label: 'Settled', test: (c) => c.status === 'settled' },
];

export function Settlement() {
  const { tenantId } = useSession();
  const [, navigate] = useLocation();
  const list = useTenant<CycleView[]>(tenantId, '/cycles', { live: true });
  const cycles = list.data ?? [];
  const [filter, setFilter] = useState('all');
  const totals = cycles.map((c) => ({ c, t: nettingTotals(c) }));
  const test = STATUS_FILTERS.find((f) => f.key === filter)?.test ?? (() => true);
  const shown = totals.filter(({ c }) => test(c));
  const period = usePeriod(['month', 'lastMonth', '30d', 'all', 'custom']);
  const summary = useTenant<SettlementSummary>(tenantId, `/settlement-summary${period.query}`, {
    enabled: period.ready,
    live: true,
  }).data;
  const ran = Object.values(summary?.cycles ?? {}).reduce((acc, n) => acc + n, 0);

  return (
    <>
      <PageHead
        title="Settlement"
        actions={
          <span className="toolbar">
            <PeriodSwitch period={period} />
            <ExportButton
              path={`/tenants/${tenantId}/payouts.csv`}
              name="payouts"
              label="Export payouts"
            />
          </span>
        }
      />
      <div className="kpis three">
        <Kpi
          label="Cycles"
          figure={summary ? ran : '—'}
          note={
            summary && ran > 0
              ? Object.entries(summary.cycles)
                  .map(
                    ([status, n]) =>
                      `${n} ${(CYCLE_STATUS[status]?.[0] ?? words(status)).toLowerCase()}`,
                  )
                  .join(', ')
              : undefined
          }
        />
        {summary?.netting.map((v) => (
          <Kpi
            key={v.currency}
            label={`Netting efficiency, ${v.currency}`}
            figure={
              BigInt(v.owed) > 0n
                ? `${(Number((BigInt(v.netted) * 1000n) / BigInt(v.owed)) / 10).toFixed(0)}%`
                : '—'
            }
            note={
              <>
                <Money value={v.paid} currency={v.currency} whole /> paid against{' '}
                <Money value={v.owed} currency={v.currency} whole /> gross
              </>
            }
          />
        ))}
      </div>
      <div className="stack">
        <ProblemPayouts />
        <NextCycles />
        <Panel
          title="Cycles"
          aside={
            <div className="seg">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label} <span className="n">{cycles.filter(f.test).length}</span>
                </button>
              ))}
            </div>
          }
        >
          <table>
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Rail</th>
                <th>Netting</th>
                <th>Status</th>
                <th className="num">Gross obligations</th>
                <th className="num">Paid out</th>
                <th className="num">Offset by netting</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ c, t }) => (
                <CycleRow key={c.id} c={c} t={t} onOpen={() => navigate(`/settlement/${c.id}`)} />
              ))}
              {list.isError && !list.data && (
                <tr>
                  <td colSpan={7}>
                    <LoadFailed error={list.error} />
                  </td>
                </tr>
              )}
              {list.data && !shown.length && (
                <EmptyRow cols={7}>
                  {cycles.length ? 'No cycles match.' : 'No cycles yet.'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </Panel>
        <AllWithdrawals />
      </div>
    </>
  );
}

function CycleRow({
  c,
  t,
  onOpen,
}: {
  c: CycleView;
  t: ReturnType<typeof nettingTotals>;
  onOpen: () => void;
}) {
  return (
    <tr className="row" onClick={onOpen}>
      <td className="title-cell">
        <a href={`#/settlement/${c.id}`} onClick={(e) => e.stopPropagation()}>
          {dateTime(c.createdAt)}
        </a>
        <small>
          {shortId('CY', c.id)}, {ago(c.closedAt ?? c.createdAt)}
        </small>
      </td>
      <td>{c.settlement ? railName(c.settlement.rail) : '—'}</td>
      <td className="muted">
        {c.settlement && `${sentence(c.settlement.netting)}, ${timingText(c.settlement.timing)}`}
      </td>
      <td>{cycleStatus(c.status)}</td>
      <td className="num">
        <Money value={t.owed} currency={t.currency} />
      </td>
      <td className="num">
        <Money value={t.paid} currency={t.currency} />
      </td>
      <td className="num">
        {t.netted > 0n ? (
          <Money value={t.netted} currency={t.currency} />
        ) : (
          <span className="faint">—</span>
        )}
      </td>
    </tr>
  );
}
