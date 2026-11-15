import { useState } from 'react';
import { Link } from 'wouter';
import { type Page, useTenant } from '../api.ts';
import { differenceItems, differenceNet } from '../differences.ts';
import { ExportButton } from '../export-menu.tsx';
import { useSession } from '../session.tsx';
import type { RailBook, ReconBreak, ReconRun, UnattributedDeposit } from '../types.ts';
import {
  actionLabel,
  ago,
  DECIDER_NAME,
  dateTime,
  EmptyRow,
  Kpi,
  LoadFailed,
  Money,
  moneyText,
  PageHead,
  Panel,
  railName,
  sentence,
} from '../ui.tsx';
import { OpenBreaks } from './book-breaks.tsx';
import { Breaks, OpeningRequests, RailBooks, Unmatched } from './rail-books.tsx';
import { SignOff, SignOffs, TodaySignOff } from './sign-off.tsx';

export function Books() {
  const { tenantId, isHouse, readsAsHouse } = useSession();
  const rails = useTenant<RailBook[]>(tenantId, '/reconciliation/rails', { live: true });
  const runs = useTenant<Page<ReconRun>>(tenantId, '/reconciliation', { live: true });
  // A difference stays open, whatever later checks find, until someone resolves it.
  const breaks = useTenant<ReconBreak[]>(tenantId, '/reconciliation/breaks', { live: true });
  const deposits = useTenant<UnattributedDeposit[]>(tenantId, '/deposits/unattributed', {
    enabled: readsAsHouse,
    live: true,
  });
  const owned = rails.data ?? [];
  const history = (runs.data?.rows ?? []).filter((r) => r.status !== 'opening');
  const latest = owned.flatMap((r) => (r.latest ? [r.latest] : []));
  const openBreaks = breaks.data ?? [];
  const open = differenceItems(openBreaks).length;
  const net = differenceNet(openBreaks);
  const since = openBreaks[0]?.openedAt;
  const lastAt = latest
    .map((r) => r.at)
    .sort()
    .at(-1);

  return (
    <>
      <PageHead
        title="Books"
        actions={
          <>
            <ExportButton path={`/tenants/${tenantId}/reconciliation.csv`} name="reconciliation" />
            <ExportButton
              path={`/tenants/${tenantId}/reconciliation-positions.csv`}
              name="reconciliation-positions"
              label="Export balances checked"
            />
            <ExportButton
              path={`/tenants/${tenantId}/ledger.csv`}
              name="ledger"
              label="Export ledger"
            />
            {isHouse && <SignOff open={open} />}
          </>
        }
      />
      <div className="kpis three">
        <Kpi
          label="Open differences"
          tone={open ? 'alert' : ''}
          figure={breaks.data ? open : '—'}
          note={
            open && since
              ? `Net ${net.map((n) => moneyText(n.amount, n.currency)).join(', ') || 'nil'}, oldest ${dateTime(since)}`
              : undefined
          }
        />
        <Kpi
          label="Last check"
          figure={
            lastAt
              ? latest.some((r) => r.status !== 'clean')
                ? 'Differences'
                : 'Nothing new'
              : '—'
          }
          note={
            lastAt
              ? `${owned.map((r) => railName(r.rail)).join(' and ')}, ${ago(lastAt)}`
              : undefined
          }
        />
        <TodaySignOff />
      </div>
      <div className="stack">
        {(rails.isError || runs.isError) && !(rails.data && runs.data) && (
          <Panel>
            <LoadFailed error={rails.error ?? runs.error} />
          </Panel>
        )}
        {readsAsHouse && owned.map((r) => <OpeningRequests key={`req-${r.rail}`} rail={r.rail} />)}
        {openBreaks.length > 0 && <OpenBreaks breaks={openBreaks} />}
        {owned.map((r) => (
          <RailBooks key={r.rail} book={r} />
        ))}
        {rails.data && !owned.length && (
          <Panel>
            <p className="panel-body muted">This tenant owns no rail account.</p>
          </Panel>
        )}
        {readsAsHouse && (deposits.data?.length ?? 0) > 0 && (
          <Unmatched deposits={deposits.data ?? []} />
        )}
        <SignOffs />
        <Panel title="Check history">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Rail</th>
                <th>Result</th>
                <th className="num">Transactions read</th>
                <th className="num">Differences</th>
              </tr>
            </thead>
            <tbody>
              {foldClean(history).map((r) =>
                'runs' in r ? <FoldedRow key={r.id} fold={r} /> : <CheckRow key={r.id} run={r} />,
              )}
              {runs.data && !history.length && <EmptyRow cols={5}>No checks yet.</EmptyRow>}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}

type Folded = { id: string; runs: ReconRun[]; from: string; to: string; rails: string[] };

/** A run of clean checks in a row says one thing; differences always stand on their own. */
function foldClean(history: ReconRun[]): (ReconRun | Folded)[] {
  const out: (ReconRun | Folded)[] = [];
  for (const r of history) {
    const last = out.at(-1);
    if (r.status === 'clean' && last && 'runs' in last) {
      last.runs.push(r);
      last.from = r.at;
      if (!last.rails.includes(r.rail)) last.rails.push(r.rail);
    } else if (r.status === 'clean') {
      out.push({ id: `clean-${r.id}`, runs: [r], from: r.at, to: r.at, rails: [r.rail] });
    } else out.push(r);
  }
  return out.map((x) => ('runs' in x && x.runs.length === 1 ? (x.runs[0] as ReconRun) : x));
}

const transactionsOf = (r: ReconRun) =>
  r.summary.kind === 'comparison' ? r.summary.transactions : 0;

/** Clean checks in a row, with what they read between them; opens to each check's balances. */
function FoldedRow({ fold }: { fold: Folded }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="row" onClick={() => setOpen(!open)}>
        <td className="nowrap">
          <span className="chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <button type="button" className="link" aria-expanded={open}>
            {dateTime(fold.from)} to {dateTime(fold.to).split(', ').at(-1)}
          </button>
        </td>
        <td>{fold.rails.map(railName).join(', ')}</td>
        <td>
          <span className="dot" />
          No differences, {fold.runs.length} checks
        </td>
        <td className="num">{fold.runs.reduce((n, r) => n + transactionsOf(r), 0)}</td>
        <td className="num">0</td>
      </tr>
      {open && (
        <tr className="open">
          <td colSpan={5}>
            <Positions runs={fold.runs} />
          </td>
        </tr>
      )}
    </>
  );
}

/** What each check compared, per currency: the ledger, the rail, the opening and the difference. */
function Positions({ runs }: { runs: ReconRun[] }) {
  const lines = runs.flatMap((r) =>
    r.summary.kind === 'comparison' ? r.summary.positions.map((p) => ({ r, p })) : [],
  );
  return (
    <table className="breaks">
      <thead>
        <tr>
          <th>Checked</th>
          <th>Rail</th>
          <th>Currency</th>
          <th className="num">Ledger</th>
          <th className="num">Rail balance</th>
          <th className="num">Opening</th>
          <th className="num">Difference</th>
        </tr>
      </thead>
      <tbody>
        {lines.map(({ r, p }) => (
          <tr key={`${r.id}-${p.currency}`}>
            <td className="nowrap muted">{dateTime(r.at)}</td>
            <td>{railName(r.rail)}</td>
            <td>{p.currency}</td>
            <td className="num">
              <Money value={p.ledger} currency={p.currency} />
            </td>
            <td className="num">
              <Money value={p.rail} currency={p.currency} />
            </td>
            <td className="num faint">
              <Money value={p.atOpening} currency={p.currency} />
            </td>
            <td className="num">
              <Money value={BigInt(p.rail) - BigInt(p.ledger)} currency={p.currency} />
            </td>
          </tr>
        ))}
        {!lines.length && <EmptyRow cols={7}>No balances were compared.</EmptyRow>}
      </tbody>
    </table>
  );
}

/** One check: it opens to the balances it compared, and to any differences and who decided. */
function CheckRow({ run: r }: { run: ReconRun }) {
  const [open, setOpen] = useState(false);
  const found = r.breaks.length > 0 || r.summary.kind === 'comparison';
  return (
    <>
      <tr className={found ? 'row' : undefined} onClick={found ? () => setOpen(!open) : undefined}>
        <td className="nowrap">
          <span className="chev" aria-hidden="true">
            {found ? (open ? '▾' : '▸') : ''}
          </span>
          {found ? (
            <button type="button" className="link" aria-expanded={open}>
              {dateTime(r.at)}
            </button>
          ) : (
            dateTime(r.at)
          )}
        </td>
        <td>{railName(r.rail)}</td>
        <td>
          <span className={`dot${r.status === 'clean' ? '' : ' stop'}`} />
          {r.status === 'clean'
            ? 'No differences'
            : r.status === 'breaks'
              ? 'Differences'
              : sentence(r.status)}
          {r.decision?.resolution && (
            <span className="muted">
              , {DECIDER_NAME[r.decision.resolution.decider.type] ?? 'decided'}:{' '}
              {actionLabel(r.decision.resolution.action.type).toLowerCase()}
            </span>
          )}
        </td>
        <td className="num">{r.summary.kind === 'comparison' ? r.summary.transactions : '—'}</td>
        <td className="num">{differenceItems(r.breaks).length}</td>
      </tr>
      {open && (
        <tr className="open">
          <td colSpan={5}>
            {r.breaks.length > 0 && <Breaks rail={r.rail} breaks={r.breaks} />}
            <Positions runs={[r]} />
            {r.decision && (
              <p className="decided">
                {r.decision.resolution
                  ? `${DECIDER_NAME[r.decision.resolution.decider.type] ?? 'A decider'} decided: ${actionLabel(r.decision.resolution.action.type).toLowerCase()}.`
                  : 'Waiting for you.'}{' '}
                <Link className="go" href={`/decisions/${r.decision.id}`}>
                  View decision
                </Link>
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
