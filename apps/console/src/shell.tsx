import { Fragment, useEffect } from 'react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { AccountPage } from './account.tsx';
import { useTenant } from './api.ts';
import { ErrorBoundary } from './error-boundary.tsx';
import { Books } from './pages/books.tsx';
import { CyclePage } from './pages/cycle.tsx';
import { DealDetailPage } from './pages/deal.tsx';
import { Deals } from './pages/deals.tsx';
import { DecisionPage } from './pages/decision.tsx';
import { Decisions } from './pages/decisions.tsx';
import { Economics } from './pages/economics.tsx';
import { MemberPage } from './pages/member-page.tsx';
import { Members } from './pages/members.tsx';
import { ActivityPage, Overview } from './pages/overview.tsx';
import { ProgramPage } from './pages/program.tsx';
import { Programs } from './pages/programs.tsx';
import { Settlement } from './pages/settlement.tsx';
import { Users } from './pages/users.tsx';
import { useSession } from './session.tsx';
import { zoneLabel } from './time.ts';
import type { CaseRow } from './types.ts';
import { railName, sentence } from './ui.tsx';

/** Grouped the way an operations team divides the work: the day's flow, the money, the rules. */
const NAV: { group: string; items: { href: string; label: string; count?: 'cases' }[] }[] = [
  {
    group: 'Operate',
    items: [
      { href: '/overview', label: 'Overview' },
      { href: '/decisions', label: 'Decisions', count: 'cases' },
      { href: '/deals', label: 'Deals' },
      { href: '/activity', label: 'Activity' },
    ],
  },
  {
    group: 'Money',
    items: [
      { href: '/settlement', label: 'Settlement' },
      { href: '/books', label: 'Books' },
      { href: '/members', label: 'Members' },
      { href: '/economics', label: 'Fees and volume' },
    ],
  },
  {
    group: 'Rules',
    items: [
      { href: '/programs', label: 'Programs' },
      { href: '/people', label: 'People and access' },
    ],
  },
];

const ENV_LABEL = { sandbox: 'sandbox', testnet: 'testnet', simulated: 'simulated', live: 'live' };

/** Changes are refused until the signed-in person turns on two-step sign-in, when the house requires it. */
function TwoStepBanner() {
  const { tenant, me, canAct } = useSession();
  if (!canAct || !tenant?.settings.requireTwoStep || me.mfa) return null;
  return (
    <div className="test-mode stop">
      <Link href="/account">Turn on two-step sign-in to make changes</Link>
    </div>
  );
}

/** Says on every page when no real money moves, which is true unless every rail is live. */
function TestModeBanner() {
  const { rails } = useSession();
  const owned = rails.filter((r) => r.owned);
  const shown = owned.length ? owned : rails;
  if (!shown.length || shown.every((r) => r.environment === 'live')) return null;
  return (
    <div className="test-mode">
      <strong>Test mode</strong>
      <span>
        {shown
          .filter((r) => r.environment !== 'live')
          .map((r) => `${railName(r.name)} ${ENV_LABEL[r.environment]}`)
          .join(', ')}
        . No real money moves.
      </span>
    </div>
  );
}

function Side({ onSignOut }: { onSignOut: () => void }) {
  const { tenant, me, tenantId } = useSession();
  const [location] = useLocation();
  const cases = useTenant<CaseRow[]>(tenantId, '/cases', { live: true });
  const open = cases.data?.length ?? 0;
  return (
    <aside className="side">
      <Link className="brand" href="/overview">
        <img src="/console/mark.svg" alt="" width={24} height={24} />
        <span>novate</span>
      </Link>
      <p className="tenant">
        <span className="tenant-label">Tenant</span>
        <span className="tenant-name">{tenant?.name ?? ''}</span>
      </p>
      <nav aria-label="Sections">
        {NAV.map((g) => (
          <Fragment key={g.group}>
            <p className="group">{g.group}</p>
            {g.items.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={
                  location === n.href || location.startsWith(`${n.href}/`) ? 'page' : undefined
                }
              >
                <span>{n.label}</span>
                {n.count === 'cases' && open > 0 && <span className="count">{open}</span>}
              </Link>
            ))}
          </Fragment>
        ))}
      </nav>
      <div className="side-foot">
        <Link className="who" href="/account">
          <strong>{me.name}</strong>
          <span>
            {sentence(me.kind)}
            {me.mfa ? '' : ', two-step sign-in off'}
          </span>
        </Link>
        <p className="tz">Times in {zoneLabel()}</p>
        <button type="button" className="sign-out" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </aside>
  );
}

export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const { me } = useSession();
  const [location] = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts at the top
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  return (
    <>
      <TestModeBanner />
      <TwoStepBanner />
      <div className="app">
        <Side onSignOut={onSignOut} />
        <div className="frame">
          <main>
            <ErrorBoundary key={location}>
              <Switch>
                <Route path="/overview" component={Overview} />
                <Route path="/activity" component={ActivityPage} />
                <Route path="/deals" component={Deals} />
                <Route path="/deals/:id">{(p) => <DealDetailPage id={p.id} />}</Route>
                <Route path="/decisions" component={Decisions} />
                <Route path="/decisions/:id">{(p) => <DecisionPage id={p.id} />}</Route>
                <Route path="/settlement" component={Settlement} />
                <Route path="/settlement/:id">{(p) => <CyclePage id={p.id} />}</Route>
                <Route path="/members" component={Members} />
                <Route path="/members/:id/accounts">
                  {(p) => <MemberPage id={p.id} opening />}
                </Route>
                <Route path="/members/:id">{(p) => <MemberPage id={p.id} />}</Route>
                <Route path="/books" component={Books} />
                <Route path="/economics" component={Economics} />
                <Route path="/people" component={Users} />
                <Route path="/account">{() => <AccountPage me={me} />}</Route>
                <Route path="/programs" component={Programs} />
                <Route path="/programs/:key">{(p) => <ProgramPage programKey={p.key} />}</Route>
                <Route>
                  <Redirect to="/overview" />
                </Route>
              </Switch>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </>
  );
}
