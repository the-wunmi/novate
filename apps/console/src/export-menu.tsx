import { useRef } from 'react';
import { download } from './api.ts';
import { EXPORT_PERIODS, type Period, PeriodSwitch, usePeriod } from './periods.tsx';
import { dayKey } from './time.ts';
import { longDate, toast } from './ui.tsx';

/** "All" still names where it starts, so the server never picks a shorter range for it. */
const BEGINNING = new Date(0).toISOString();

/** The last day an exclusive `to` covers. */
const lastDay = (to: string) => new Date(new Date(to).getTime() - 1);

/**
 * A whole population as CSV, built by the server rather than from what is on screen, so an auditor
 * gets every row in the period and not just the page that was loaded. With `period` it exports what
 * the page shows; without, it asks for one.
 */
export function ExportButton({
  path,
  name,
  label = 'Export CSV',
  period,
}: {
  /** The whole path, `/tenants/:t/ledger.csv`. */
  path: string;
  name: string;
  label?: string;
  period?: Period;
}) {
  if (period) return <ExportNow path={path} name={name} label={label} period={period} />;
  return <ExportMenu path={path} name={name} label={label} />;
}

function exportCsv(path: string, name: string, period: Period) {
  const params = new URLSearchParams({ from: period.from ?? BEGINNING });
  if (period.to) params.set('to', period.to);
  return download(`${path}?${params}`, (c) =>
    c.from && c.to
      ? `novate-${name}-${dayKey(c.from)}-to-${dayKey(lastDay(c.to))}.csv`
      : `novate-${name}.csv`,
  )
    .then(({ rows, from, to }) =>
      toast(
        `${rows.toLocaleString('en')} ${rows === 1 ? 'row' : 'rows'}, ${
          from === BEGINNING ? 'from the start' : longDate(from)
        } to ${longDate(lastDay(to))}`,
      ),
    )
    .catch((err: Error) => toast(err.message));
}

function ExportNow({
  path,
  name,
  label,
  period,
}: {
  path: string;
  name: string;
  label: string;
  period: Period;
}) {
  return (
    <button
      type="button"
      className="btn"
      disabled={!period.ready}
      onClick={() => exportCsv(path, name, period)}
    >
      {label}
    </button>
  );
}

function ExportMenu({ path, name, label }: { path: string; name: string; label: string }) {
  const period = usePeriod(EXPORT_PERIODS);
  const menu = useRef<HTMLDetailsElement>(null);
  return (
    <details className="export-menu" ref={menu}>
      <summary className="btn">{label}</summary>
      <div className="export-panel">
        <PeriodSwitch period={period} />
        <button
          type="button"
          className="btn primary small"
          disabled={!period.ready}
          onClick={() => {
            if (menu.current) menu.current.open = false;
            exportCsv(path, name, period);
          }}
        >
          Download
        </button>
      </div>
    </details>
  );
}

/** Everyone or everything as it stands now, for an access review: no period to choose. */
export function SnapshotExport({ path, name }: { path: string; name: string }) {
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        download(path, (c) => `novate-${name}-${dayKey(c.to)}.csv`)
          .then(({ rows }) => toast(`${rows.toLocaleString('en')} ${rows === 1 ? 'row' : 'rows'}`))
          .catch((err: Error) => toast(err.message))
      }
    >
      Export CSV
    </button>
  );
}
