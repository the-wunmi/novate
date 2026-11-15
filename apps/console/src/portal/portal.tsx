// The member portal: what a member's own users see when they sign in. Only the member's own money,
// deals and settlement, through the same routes and permissions as any other client.
import { useEffect } from 'react';
import { Link, Redirect, Route, Switch, useLocation } from 'wouter';
import { AccountPage } from '../account.tsx';
import { ErrorBoundary } from '../error-boundary.tsx';
import { zoneLabel } from '../time.ts';
import type { Me } from '../types.ts';
import { shortId } from '../ui.tsx';
import { Account } from './account.tsx';
import { MyCycle } from './cycle.tsx';
import { MyDeal, MyDeals } from './deals.tsx';
import { useMyAccount } from './my.ts';
import { MySettlement } from './settlement.tsx';

export function MemberPortal({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const [location] = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page starts at the top
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  const nav = [
    { href: '/account', label: 'Account' },
    { href: '/deals', label: 'Deals' },
    { href: '/settlement', label: 'Settlement' },
  ];
  return (
    <div className="app">
      <aside className="side">
        <Link className="brand" href="/account">
          <img src="/console/mark.svg" alt="" width={24} height={24} />
          <span>novate</span>
        </Link>
        <p className="tenant">
          <span className="tenant-label">Member</span>
          <span className="tenant-name">
            <BusinessName me={me} />
          </span>
        </p>
        <nav aria-label="Sections">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={
                location === n.href || location.startsWith(`${n.href}/`) ? 'page' : undefined
              }
            >
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <Link className="who" href="/security">
            <strong>{me.name}</strong>
            <span>{me.mfa ? 'Member' : 'Member, two-step sign-in off'}</span>
          </Link>
          <p className="tz">Times in {zoneLabel()}</p>
          <button type="button" className="sign-out" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </aside>
      <div className="frame">
        <main>
          <ErrorBoundary key={location}>
            <Switch>
              <Route path="/account">{() => <Account me={me} />}</Route>
              <Route path="/deals">{() => <MyDeals me={me} />}</Route>
              <Route path="/deals/:id">{(p) => <MyDeal me={me} id={p.id} />}</Route>
              <Route path="/settlement">{() => <MySettlement me={me} />}</Route>
              <Route path="/security">{() => <AccountPage me={me} />}</Route>
              <Route path="/settlement/:id">{(p) => <MyCycle id={p.id} />}</Route>
              <Route>
                <Redirect to="/account" />
              </Route>
            </Switch>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

function BusinessName({ me }: { me: Me }) {
  const account = useMyAccount(me);
  return <>{account.data?.name ?? shortId('MB', me.memberId ?? '')}</>;
}
