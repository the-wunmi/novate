import { Fragment, useRef, useState } from 'react';
import { Link } from 'wouter';
import { api, type Page, useAction, useTenant } from '../api.ts';
import { Approvals } from '../approvals.tsx';
import { describeActivity } from '../describe.tsx';
import { differenceItems } from '../differences.ts';
import { ExportButton } from '../export-menu.tsx';
import { unlimited } from '../limits.tsx';
import { NettingRibbon } from '../netting.tsx';
import { usePayoutProblems } from '../ops.tsx';
import { CaseOwner } from '../owner.tsx';
import { useSession } from '../session.tsx';
import { SettlementSwitch } from '../settlement-switch.tsx';
import { monthStart, zoneName } from '../time.ts';
import type {
  Activity,
  CaseRow,
  CycleView,
  DecisionSummary,
  MarginCall,
  RailBook,
  ReconBreak,
  SettlementSummary,
  Tenant,
  UnattributedDeposit,
} from '../types.ts';
import {
  Actor,
  ago,
  caseKind,
  clock,
  dateTime,
  dayLabel,
  duration,
  formatMajor,
  Kpi,
  LoadFailed,
  Money,
  PageHead,
  Panel,
  railName,
  sentences,
  shortId,
  until,
  waiting,
} from '../ui.tsx';

export function Overview() {
  const { tenantId, readsAsHouse, isHouse, memberName, agents, canAct } = useSession();
  // Settlement can stop without anyone here acting, so the overview keeps the tenant live.
  const tenant = useTenant<Tenant>(tenantId, '', { live: true }).data;
  const cases = useTenant<CaseRow[]>(tenantId, '/cases', { live: true });
  const calls = useTenant<MarginCall[]>(tenantId, '/margin-calls', { live: true });
  const deposits = useTenant<UnattributedDeposit[]>(tenantId, '/deposits/unattributed', {
    enabled: readsAsHouse,
    live: true,
  });
  // Counted by the server over this month, not from whatever page happens to be loaded.
  const [month] = useState(() => `?from=${monthStart().toISOString()}`);
  const summary = useTenant<SettlementSummary>(tenantId, `/settlement-summary${month}`, {
    live: true,
  }).data;
  const decided = useTenant<DecisionSummary>(tenantId, `/decision-summary${month}`, {
    live: true,
  }).data;
  const cycles = useTenant<CycleView[]>(tenantId, '/cycles', { live: true }).data ?? [];
  const books = useTenant<RailBook[]>(tenantId, '/reconciliation/rails', { live: true }).data ?? [];
  const breaks = useTenant<ReconBreak[]>(tenantId, '/reconciliation/breaks', { live: true });
  const payouts = usePayoutProblems(tenantId);
  const requests = useTenant<
    { id: string; memberId: string; name: string; firstRequestedAt: string }[]
  >(tenantId, '/provision-requests', { enabled: readsAsHouse, live: true });

  const [confirmRun, setConfirmRun] = useState(false);
  const settle = useAction(tenantId, {
    run: () => api<{ cycleIds: string[] }>(`/tenants/${tenantId}/cycles`, { method: 'POST' }),
    onDone: () => setConfirmRun(false),
    done: (r) =>
      r.cycleIds.length
        ? `Settlement started (${r.cycleIds.length} cycle${r.cycleIds.length > 1 ? 's' : ''})`
        : 'Nothing to settle',
  });

  const halted = tenant?.settlementHaltedAt
    ? (tenant.settlementHaltReason ?? 'Settlement stopped')
    : null;

  // Netting, per currency: a total across currencies would mean nothing. The largest leads.
  const main = summary?.netting[0];
  const efficiency =
    main && BigInt(main.owed) > 0n
      ? Number((BigInt(main.netted) * 1000n) / BigInt(main.owed)) / 10
      : null;

  // Settlement problems and unbounded agents need a person even when no case is open.
  const doubt = (payouts.data?.rows ?? []).filter((p) => p.status === 'in_doubt');
  const openCount = differenceItems(breaks.data ?? []).length;
  const problems = [
    ...(openCount
      ? [
          {
            key: 'breaks',
            href: '/books',
            title: `${openCount} books difference${openCount === 1 ? '' : 's'} open`,
            note: 'Settlement is held',
          },
        ]
      : []),
    ...cycles.flatMap((c) =>
      c.paid
        .filter((p) => p.status === 'reversed')
        .map((p) => ({
          key: `returned-${c.id}-${p.memberId}`,
          href: `/settlement/${c.id}`,
          title: `A payout came back from ${railName(p.rail)}`,
          note: `Cycle ${shortId('CY', c.id)}`,
        })),
    ),
    ...cycles.flatMap((c) =>
      c.failed
        .filter((p) => !p.returnedToWallet)
        .map((p) => ({
          key: `failed-${c.id}-${p.memberId}-${p.currency}`,
          href: `/settlement/${c.id}`,
          title: `A payout to ${memberName(p.memberId)} failed on ${railName(p.rail)}`,
          note: `Cycle ${shortId('CY', c.id)}${p.failureReason ? `, ${p.failureReason}` : ''}`,
        })),
    ),
    ...cycles
      .filter((c) => c.status === 'failed' || c.status === 'deferred')
      .map((c) => ({
        key: `cycle-${c.id}`,
        href: `/settlement/${c.id}`,
        title: `Cycle ${shortId('CY', c.id)} ${c.status === 'failed' ? 'failed' : 'was held back'}`,
        note: dateTime(c.createdAt),
      })),
    ...(doubt.length
      ? [
          {
            key: 'doubt',
            href: '/settlement',
            title: `${doubt.length} payout${doubt.length === 1 ? '' : 's'} with no answer from the rail`,
            note: `Oldest ${duration(Math.max(...doubt.map((p) => p.ageSeconds)))}`,
          },
        ]
      : []),
    ...(requests.data ?? []).map((r) => ({
      key: `provision-${r.id}`,
      href: isHouse ? `/members/${r.memberId}/accounts` : `/members/${r.memberId}`,
      title: `Open accounts for ${r.name}`,
      note: `Asked ${dateTime(r.firstRequestedAt)}`,
    })),
    ...(() => {
      const open = agents.filter(
        (a) => a.status === 'active' && Object.values(a.mandate.limits).some(unlimited),
      );
      return open.length
        ? [
            {
              key: 'unlimited',
              href: '/members',
              title: `${open.length} agent${open.length === 1 ? '' : 's'} trading with no money limit`,
              note: 'Set limits on Members',
            },
          ]
        : [];
    })(),
  ];

  // Open is what has not been resolved, not what the latest check happened to find.
  const open = differenceItems(breaks.data ?? []);
  const checked = books.flatMap((b) => (b.latest ? [b] : []));
  const lastChecked = checked
    .map((b) => b.latest?.at ?? '')
    .sort()
    .at(-1);

  return (
    <>
      <PageHead
        title="Overview"
        actions={
          <>
            <SettlementSwitch />
            {canAct &&
              (confirmRun ? (
                <span className="confirm">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={settle.isPending}
                    onClick={() => settle.mutate()}
                  >
                    Start settlement
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setConfirmRun(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" className="btn primary" onClick={() => setConfirmRun(true)}>
                  Run settlement now…
                </button>
              ))}
          </>
        }
      />

      <div className="kpis three">
        <Kpi
          label={`Netting efficiency, this month (${zoneName()})`}
          figure={efficiency === null ? '—' : `${efficiency.toFixed(0)}%`}
          note={
            main ? (
              <Link href="/settlement">
                {formatMajor(main.netted, main.currency, true)} of{' '}
                {formatMajor(main.owed, main.currency, true)} {main.currency} offset over{' '}
                {main.cycles} {main.currency} cycle{main.cycles === 1 ? '' : 's'}
              </Link>
            ) : (
              'No cycles'
            )
          }
        />
        <Kpi
          label="Books"
          tone={open.length ? 'alert' : ''}
          figure={
            !checked.length
              ? '—'
              : open.length
                ? `${open.length} open difference${open.length === 1 ? '' : 's'}`
                : 'Reconciled'
          }
          note={
            checked.length
              ? `${checked.map((b) => railName(b.rail)).join(' and ')} checked ${ago(lastChecked ?? '')}`
              : 'No checks yet'
          }
        />
        <Kpi
          label={`Handled without a person, this month (${zoneName()})`}
          figure={
            decided?.decided ? `${decided.decided - decided.byPerson} of ${decided.decided}` : '—'
          }
          note={
            decided?.decided ? (
              <Link href="/decisions">
                {decided.byRule} by rules, {decided.byModel} by AI, {decided.byPerson} by people
              </Link>
            ) : undefined
          }
        />
      </div>

      <div className="cols two">
        <div className="stack">
          <Approvals />
          <NeedsYou
            problems={problems}
            halted={halted}
            cases={cases}
            calls={calls}
            deposits={readsAsHouse ? deposits : undefined}
          />
          {cycles[0] && (
            <Panel
              title={`Latest cycle ${shortId('CY', cycles[0].id)}`}
              sub={cycles[0].closedAt ? ago(cycles[0].closedAt) : 'in progress'}
              aside={<Link href={`/settlement/${cycles[0].id}`}>Open cycle</Link>}
            >
              <div className="panel-body">
                <NettingRibbon
                  key={cycles[0].id}
                  cycle={cycles[0]}
                  name={memberName}
                  animate
                  compact
                />
              </div>
            </Panel>
          )}
        </div>
        <ActivityPanel limit={8} only={notSignIn} />
      </div>
    </>
  );
}

/** Sign-ins are on the Activity page; on the overview they crowd out what happened. */
const notSignIn = (a: Activity | Folded) =>
  'checks' in a || !(a.source === 'control' && a.type === 'user_signed_in');

type Read<T> = { data?: T; error: unknown; isError: boolean };

function NeedsYou({
  problems,
  halted,
  cases,
  calls,
  deposits,
}: {
  problems: { key: string; href: string; title: string; note: string }[];
  halted: string | null;
  cases: Read<CaseRow[]>;
  calls: Read<MarginCall[]>;
  deposits?: Read<UnattributedDeposit[]>;
}) {
  const { memberName } = useSession();
  const failed = [cases, calls, deposits].find((q) => q?.isError && !q.data);
  const loaded = cases.data && calls.data && (!deposits || deposits.data);
  const items =
    (cases.data?.length ?? 0) +
    (calls.data?.length ?? 0) +
    (deposits?.data?.length ?? 0) +
    problems.length;
  return (
    <Panel title="Needs you" sub={items || halted ? String(items + (halted ? 1 : 0)) : undefined}>
      {failed ? (
        <LoadFailed error={failed.error} />
      ) : !loaded ? (
        <p className="panel-body muted">Loading…</p>
      ) : !items && !halted ? (
        <div className="queue-empty">
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          <div>
            <h3>Nothing needs you</h3>
          </div>
        </div>
      ) : (
        <table>
          <tbody>
            {problems.map((p) => (
              <tr key={p.key}>
                <td className="title-cell">
                  <Link href={p.href}>{p.title}</Link>
                  <small>{p.note}</small>
                </td>
                <td />
                <td />
              </tr>
            ))}
            {halted && (
              <tr>
                <td className="title-cell">
                  <Link href="/books">Settlement stopped</Link>
                  <small>{sentences(halted.replace(/run [0-9a-f-]{36} /, ''))}</small>
                </td>
                <td />
                <td />
              </tr>
            )}
            {cases.data?.map((c) => (
              <tr key={c.id}>
                <td className="title-cell">
                  <Link href={`/decisions/${c.id}`}>{caseKind(c.kind)}</Link>
                  <small>{sentences(c.reason)}</small>
                </td>
                <td className="muted nowrap">
                  Waiting {waiting(c.createdAt)}
                  <span className="sub-line">
                    <CaseOwner c={c} />
                  </span>
                </td>
                <td className="num">
                  {BigInt(c.context.amount) > 0n && (
                    <Money value={c.context.amount} currency={c.context.currency} />
                  )}
                </td>
              </tr>
            ))}
            {calls.data?.map((c) => {
              const due = until(c.dueAt);
              return (
                <tr key={c.id}>
                  <td className="title-cell">
                    Margin call on {memberName(c.memberId)}
                    <small className={due.overdue ? 'error' : undefined} title={dateTime(c.dueAt)}>
                      {due.text}
                    </small>
                  </td>
                  <td />
                  <td className="num">
                    <Money value={c.amount} currency={c.currency} />
                  </td>
                </tr>
              );
            })}
            {deposits?.data?.map((d) => (
              <tr key={d.id}>
                <td className="title-cell">
                  <Link href="/books">Unmatched deposit</Link>
                  <small>Received on {d.depositAccountRef}</small>
                </td>
                <td />
                <td className="num">
                  <Money value={d.amount} currency={d.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

type Folded = { id: string; at: string; checks: number; since: string; rails: string[] };

/** Bookkeeping lines a person never needs in a feed. The deal page still shows them. */
const quiet = (a: Activity) =>
  a.source === 'deal' && a.type === 'conditions_evaluated' && a.detail.event.state !== 'passed';

/**
 * Clean checks of the books run every few minutes. A run of them in a row says one thing, so it is
 * shown once. Differences are never folded.
 */
function foldRoutineChecks(items: Activity[]): (Activity | Folded)[] {
  const out: (Activity | Folded)[] = [];
  for (const a of items) {
    if (quiet(a)) continue;
    const last = out.at(-1);
    if (a.source === 'recon' && a.type === 'clean') {
      if (last && 'checks' in last) {
        last.checks += 1;
        last.since = a.at;
        if (!last.rails.includes(a.detail.rail)) last.rails.push(a.detail.rail);
      } else
        out.push({
          id: `checks:${a.id}`,
          at: a.at,
          checks: 1,
          since: a.at,
          rails: [a.detail.rail],
        });
    } else out.push(a);
  }
  return out;
}

const FILTERS: { key: string; label: string; test: (a: Activity | Folded) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  {
    key: 'decisions',
    label: 'Decisions',
    test: (a) => !('checks' in a) && a.source === 'decision',
  },
  {
    key: 'money',
    label: 'Money',
    test: (a) => !('checks' in a) && (a.source === 'money' || a.source === 'cycle'),
  },
  { key: 'books', label: 'Books', test: (a) => 'checks' in a || a.source === 'recon' },
  { key: 'changes', label: 'Changes', test: (a) => !('checks' in a) && a.source === 'control' },
];

export function ActivityPage() {
  const { tenantId } = useSession();
  const [filter, setFilter] = useState('all');
  return (
    <>
      <PageHead
        title="Activity"
        actions={
          <span className="toolbar">
            <ExportButton path={`/tenants/${tenantId}/activity.csv`} name="activity" />
            <ExportButton
              path={`/tenants/${tenantId}/control-events.csv`}
              name="control-log"
              label="Export control log"
            />
            <div className="seg">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </span>
        }
      />
      <ActivityPanel limit={80} title="" days only={FILTERS.find((f) => f.key === filter)?.test} />
    </>
  );
}

export function ActivityPanel({
  limit,
  title = 'Latest activity',
  days = false,
  only,
}: {
  limit: number;
  title?: string;
  days?: boolean;
  only?: (a: Activity | Folded) => boolean;
}) {
  const { tenantId, memberName, programByRef } = useSession();
  const feed = useTenant<Page<Activity>>(tenantId, '/activity', { live: true });
  const seen = useRef<Set<string> | null>(null);
  const items = foldRoutineChecks(feed.data?.rows ?? [])
    .filter(only ?? (() => true))
    .slice(0, limit);
  const fresh = new Set(
    seen.current ? items.filter((i) => !seen.current?.has(i.id)).map((i) => i.id) : [],
  );
  if (feed.data) seen.current = new Set([...(seen.current ?? []), ...items.map((i) => i.id)]);

  return (
    <Panel
      title={title}
      foot={
        !days && (feed.data?.rows.length ?? 0) > limit ? (
          <Link href="/activity">See all activity</Link>
        ) : undefined
      }
    >
      {feed.isError && !feed.data ? (
        <LoadFailed error={feed.error} />
      ) : !items.length ? (
        <p className="panel-body muted">{feed.data ? 'Nothing yet.' : 'Loading…'}</p>
      ) : (
        <ul className="tape">
          {items.map((a, i) => {
            const d =
              'checks' in a
                ? {
                    actor: 'code' as const,
                    actorName: undefined,
                    text: `${a.rails.map(railName).join(' and ')} checked, no new differences`,
                    detail:
                      a.checks > 1
                        ? `${a.checks} checks since ${clock(a.since).slice(0, 5)}`
                        : undefined,
                    href: '/books',
                  }
                : describeActivity(a, memberName, programByRef);
            const prev = items[i - 1];
            const newDay = days && (!prev || dayLabel(prev.at) !== dayLabel(a.at));
            return (
              <Fragment key={a.id}>
                {newDay && <li className="day">{dayLabel(a.at)}</li>}
                <li className={`${days ? 'with-amount' : ''}${fresh.has(a.id) ? ' fresh' : ''}`}>
                  <time dateTime={a.at}>{clock(a.at).slice(0, 5)}</time>
                  <Actor kind={d.actor} name={d.actorName} />
                  <span className="what">
                    {d.href ? <Link href={d.href}>{d.text}</Link> : d.text}
                    {d.detail && <span className="detail">{d.detail}</span>}
                  </span>
                  {days && (
                    <span className="amount num">
                      {'money' in d && d.money && (
                        <Money value={d.money.amount} currency={d.money.currency} />
                      )}
                    </span>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
