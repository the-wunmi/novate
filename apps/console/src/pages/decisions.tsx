import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { type Page, useTenant } from '../api.ts';
import { ExportButton } from '../export-menu.tsx';
import { CaseOwner } from '../owner.tsx';
import { useSession } from '../session.tsx';
import type { CaseRow, DecisionFeedRow, TrackRecord } from '../types.ts';
import {
  Actor,
  actionLabel,
  caseKind,
  DECIDER_NAME,
  dateTime,
  deciderActor,
  EmptyRow,
  LoadFailed,
  Money,
  PageHead,
  Panel,
  Pill,
  sentences,
  shortId,
  type Tone,
  waiting,
} from '../ui.tsx';

export const VERDICTS: Record<string, [string, Tone]> = {
  good: ['Turned out well', 'ok'],
  bad: ['Went wrong', 'stop'],
  neutral: ['No way to tell', ''],
};

const FILTERS: { key: string; label: string; test: (d: DecisionFeedRow) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'model', label: 'AI', test: (d) => d.resolution?.decider.type === 'model' },
  { key: 'rule', label: 'Rules', test: (d) => d.resolution?.decider.type === 'rule' },
  { key: 'person', label: 'Person', test: (d) => d.resolution?.decider.type === 'person' },
];

export function Decisions() {
  const { tenantId, programByRef, programs, memberName } = useSession();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState('all');
  const feed = useTenant<Page<DecisionFeedRow>>(tenantId, '/decisions', { live: true });
  const open = useTenant<CaseRow[]>(tenantId, '/cases', { live: true });
  const records = useTenant<TrackRecord[]>(tenantId, '/track-record', { live: true });
  const parties = (d: { buyerMemberId: string | null; sellerMemberId: string | null }) =>
    d.buyerMemberId && d.sellerMemberId
      ? `${memberName(d.buyerMemberId)} and ${memberName(d.sellerMemberId)}`
      : null;
  const rows = (feed.data?.rows ?? []).filter((d) => d.resolution);
  const test = FILTERS.find((f) => f.key === filter)?.test ?? (() => true);
  const shown = rows.filter(test);
  const queue = open.data ?? [];
  // Earned autonomy only means something on a program that uses it.
  const earned = (key: string | null) =>
    programs.filter((p) => p.key === key).sort((a, b) => b.version - a.version)[0]?.spec.decisions
      .autonomy?.mode === 'earned';

  return (
    <>
      <PageHead
        title="Decisions"
        actions={
          <span className="toolbar">
            <ExportButton path={`/tenants/${tenantId}/decisions.csv`} name="decisions" />
            <ExportButton
              path={`/tenants/${tenantId}/decision-records.csv`}
              name="decision-records"
              label="Export every step"
            />
          </span>
        }
      />
      <div className="stack">
        <Panel title="Waiting for you" sub={queue.length ? String(queue.length) : undefined}>
          {open.isError && !open.data ? (
            <LoadFailed error={open.error} />
          ) : (
            <table>
              <tbody>
                {queue.map((c) => (
                  <tr key={c.id} className="row" onClick={() => navigate(`/decisions/${c.id}`)}>
                    <td className="title-cell">
                      <a href={`#/decisions/${c.id}`} onClick={(e) => e.stopPropagation()}>
                        {caseKind(c.kind)}
                      </a>
                      <small>{sentences(c.reason)}</small>
                    </td>
                    <td className="muted">{parties(c) ?? '—'}</td>
                    <td className="muted nowrap">Waiting {waiting(c.createdAt)}</td>
                    <td>
                      <CaseOwner c={c} />
                    </td>
                    <td className="num">
                      {BigInt(c.context.amount) > 0n && (
                        <Money value={c.context.amount} currency={c.context.currency} />
                      )}
                    </td>
                  </tr>
                ))}
                {open.data && !queue.length && (
                  <EmptyRow cols={5}>Nothing is waiting for a person.</EmptyRow>
                )}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Decided"
          sub="Exceptions only"
          aside={
            <div className="seg">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                  <span className="n">{rows.filter(f.test).length}</span>
                </button>
              ))}
            </div>
          }
        >
          {feed.isError && !feed.data ? (
            <LoadFailed error={feed.error} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Deal</th>
                  <th>Decided by</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th className="num">Amount</th>
                  <th className="num hide-md">Ceiling then</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => {
                  const verdict = d.verdict ? VERDICTS[d.verdict] : undefined;
                  const decider = d.resolution?.decider.type ?? 'system';
                  return (
                    <tr key={d.id} className="row" onClick={() => navigate(`/decisions/${d.id}`)}>
                      <td className="title-cell">
                        <a href={`#/decisions/${d.id}`} onClick={(e) => e.stopPropagation()}>
                          {caseKind(d.kind)}
                        </a>
                        <small>{dateTime(d.createdAt)}</small>
                      </td>
                      <td>
                        {d.dealId ? (
                          <>
                            <Link className="ref" href={`/deals/${d.dealId}`}>
                              {shortId('DL', d.dealId)}
                            </Link>
                            <small className="sub-line">{parties(d)}</small>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <Actor kind={deciderActor(decider)} name={DECIDER_NAME[decider]} />
                      </td>
                      <td>{d.resolution ? actionLabel(d.resolution.action.type) : '—'}</td>
                      <td className="nowrap">
                        <Pill tone={verdict?.[1] ?? ''}>{verdict?.[0] ?? 'Not judged yet'}</Pill>
                      </td>
                      <td className="num">
                        {d.amount && d.currency && BigInt(d.amount) > 0n && (
                          <Money value={d.amount} currency={d.currency} />
                        )}
                      </td>
                      <td className="num muted hide-md">
                        {d.ceiling && d.currency ? (
                          <>
                            <Money value={d.ceiling} currency={d.currency} />
                            {d.programVersion && (
                              <small className="sub-line">v{d.programVersion}</small>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
                {feed.data && !shown.length && <EmptyRow cols={7}>No decisions yet.</EmptyRow>}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Earned autonomy">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th className="num">Turned out well</th>
                <th className="num">Proven rate (lower bound)</th>
                <th className="num">Share of ceiling</th>
              </tr>
            </thead>
            <tbody>
              {(records.data ?? []).map((r) => (
                <tr key={`${r.kind}-${r.programKey}`}>
                  <td className="title-cell">
                    {caseKind(r.kind)}
                    {r.programKey && <small>{programByRef(r.programKey)}</small>}
                  </td>
                  <td className="num">
                    {r.good} of {r.good + r.bad}
                  </td>
                  <td className="num">{(r.confidenceBps / 100).toFixed(1)}%</td>
                  <td className="num">
                    {earned(r.programKey) ? (
                      `${(r.earnedShareBps / 100).toFixed(0)}%`
                    ) : (
                      <span className="faint">Not used: full ceiling</span>
                    )}
                  </td>
                </tr>
              ))}
              {!records.data?.length && <EmptyRow cols={4}>No decision judged yet.</EmptyRow>}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
