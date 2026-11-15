import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, type Page, useAction, usePaged, useTenant } from '../api.ts';
import { dealSummary } from '../describe.tsx';
import { AllWithdrawals } from '../ops.tsx';
import { PayInPayOut } from '../pay-details.tsx';
import { useSession } from '../session.tsx';
import { StatementPanel } from '../statement.tsx';
import type { Approval, Deal, DefaultFundView, Exposure, User } from '../types.ts';
import {
  Amounts,
  actorName,
  ago,
  Copy,
  DealStatus,
  dateTime,
  EmptyRow,
  Kpi,
  LoadFailed,
  Loading,
  Money,
  PageHead,
  Panel,
  Pill,
  sentence,
  shortId,
  sumBig,
  toast,
  until,
} from '../ui.tsx';
import { AgentsPanel } from './agents.tsx';
import {
  ChangePayout,
  CreditMember,
  EditMember,
  MoveDefaultFund,
  payeeRails,
} from './member-forms.tsx';
import { MemberStatus, sum } from './members.tsx';
import { OpenAccounts, openableRails } from './open-accounts.tsx';

/** One member: what it holds and owes, its agents and every line of its statement. */
export function MemberPage({ id, opening = false }: { id: string; opening?: boolean }) {
  const { tenantId, agents, canAct, isHouse, rails } = useSession();
  const [, navigate] = useLocation();
  const [opened, setOpened] = useState(opening);
  const [form, setForm] = useState<null | 'payout' | 'credit'>(null);
  const exposure = useTenant<Exposure>(tenantId, '/exposure');
  const row = exposure.data?.members.find((m) => m.memberId === id);
  if (!row) return exposure.error ? <LoadFailed error={exposure.error} /> : <Loading />;
  const cur = row.currencies;
  const openable = isHouse ? openableRails(rails, row) : [];
  const payable = isHouse ? payeeRails(rails, row) : [];
  const closeForm = () => {
    setOpened(false);
    if (opening) navigate(`/members/${id}`, { replace: true });
  };

  return (
    <>
      <PageHead
        crumb={
          <>
            <Link href="/members">Members</Link> / {shortId('MB', id)}
          </>
        }
        title={row.name}
        actions={
          canAct && (
            <MemberActions
              id={id}
              name={row.name}
              status={row.status}
              onCredit={isHouse ? () => setForm('credit') : undefined}
            />
          )
        }
        lede={
          <span className="outcome">
            <MemberStatus status={row.status} />
            <span className="muted">Home currency {row.homeCurrency}</span>
          </span>
        }
      />
      <div className="kpis">
        <Kpi
          label="Available"
          figure={<Amounts list={sum(cur, (c) => c.available)} empty="0.00" />}
        />
        <Kpi
          label="Locked in deals"
          figure={<Amounts list={sum(cur, (c) => c.locked)} empty="0.00" />}
        />
        <Kpi
          label="Open net position"
          figure={<Amounts list={sum(cur, (c) => c.openObligations.net)} empty="0.00" />}
        />
        <Kpi
          label="Margin calls"
          tone={row.marginCalls.length ? 'alert' : ''}
          figure={row.marginCalls.length || '—'}
          note={row.marginCalls[0] ? until(row.marginCalls[0].dueAt).text : undefined}
        />
      </div>
      <div className="stack">
        {form === 'credit' && <CreditMember row={row} onClose={() => setForm(null)} />}
        <Panel title="Exposure by currency">
          <table>
            <thead>
              <tr>
                <th>Currency</th>
                <th className="num">Available</th>
                <th className="num">Escrow</th>
                <th className="num">Deal margin</th>
                <th className="num">Portfolio margin</th>
                <th className="num">Payable</th>
                <th className="num">Receivable</th>
                <th className="num">Owes the house</th>
              </tr>
            </thead>
            <tbody>
              {cur.map((c) => {
                const by = (kind: string) => sumBig(c.lockedByDeal.filter((l) => l.kind === kind));
                return (
                  <tr key={c.currency}>
                    <td className="title-cell">{c.currency}</td>
                    <td className="num">
                      <Money value={c.available} currency={c.currency} />
                    </td>
                    <td className="num">
                      <Money value={by('escrow')} currency={c.currency} />
                    </td>
                    <td className="num">
                      <Money value={by('margin')} currency={c.currency} />
                    </td>
                    <td className="num">
                      <Money value={c.portfolioMargin.posted} currency={c.currency} />
                    </td>
                    <td className="num">
                      <Money value={c.openObligations.payable} currency={c.currency} />
                    </td>
                    <td className="num">
                      <Money value={c.openObligations.receivable} currency={c.currency} />
                    </td>
                    <td className="num">
                      {BigInt(c.debt) > 0n ? (
                        <span className="error">
                          <Money value={c.debt} currency={c.currency} />
                        </span>
                      ) : (
                        <span className="faint">
                          <Money value={0n} currency={c.currency} />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!cur.length && <EmptyRow cols={8}>Nothing held for this member.</EmptyRow>}
            </tbody>
          </table>
          {row.marginCalls.length > 0 && (
            <div className="panel-foot">
              {row.marginCalls.map((c) => (
                <p key={c.id} className="error">
                  Margin call: <Money value={c.amount} currency={c.currency} />,{' '}
                  {until(c.dueAt).text.toLowerCase()} ({dateTime(c.dueAt)})
                </p>
              ))}
            </div>
          )}
        </Panel>
        {opened && openable.length > 0 && (
          <OpenAccounts row={row} rails={openable} onClose={closeForm} />
        )}
        <MemberDetails
          id={id}
          row={row}
          onOpen={openable.length && !opened ? () => setOpened(true) : undefined}
        />
        {form === 'payout' && payable.length > 0 && (
          <ChangePayout row={row} rails={payable} onClose={() => setForm(null)} />
        )}
        <Panel
          title="Pay in and pay out"
          aside={
            <span className="toolbar">
              <PayoutChangeWaiting id={id} />
              {payable.length > 0 && form !== 'payout' && (
                <button type="button" className="btn small" onClick={() => setForm('payout')}>
                  Change payout details
                </button>
              )}
            </span>
          }
        >
          <PayInPayOut accounts={row} />
        </Panel>
        <MemberPeople id={id} />
        <AgentsPanel agents={agents} only={id} />
        <MemberDeals id={id} />
        <AllWithdrawals memberId={id} />
        <StatementPanel tenantId={tenantId} memberId={id} name={row.name} />
      </div>
    </>
  );
}

/**
 * What the platform and the house can do to a member: invite its treasurer to its own portal, and
 * stop or restart its trading. Each needs a reason, which goes on the control log.
 */
function MemberActions({
  id,
  name,
  status,
  onCredit,
}: {
  id: string;
  name: string;
  status: string;
  onCredit?: () => void;
}) {
  const { tenantId, isHouse } = useSession();
  const [asking, setAsking] = useState<null | 'suspend' | 'reinstate' | 'invite'>(null);
  const [reason, setReason] = useState('');
  const [person, setPerson] = useState({ name: '', email: '' });
  const [link, setLink] = useState<string | null>(null);
  const change = useAction(tenantId, {
    run: (to: 'suspend' | 'reinstate') =>
      api(`/tenants/${tenantId}/members/${id}/${to}`, { body: { reason: reason.trim() } }),
    done: (_r, to) => `${name} ${to === 'suspend' ? 'suspended' : 'reinstated'}`,
    onDone: () => {
      setAsking(null);
      setReason('');
    },
  });
  // A member's treasurer signs in as themselves; the portal shows only this member's money.
  const invite = useAction(tenantId, {
    run: () =>
      api<{ inviteUrl?: string; user: { email: string } }>(`/tenants/${tenantId}/users`, {
        body: {
          name: person.name.trim(),
          email: person.email.trim(),
          role: 'member',
          memberId: id,
        },
      }),
    onDone: (r) => {
      if (r.inviteUrl) setLink(r.inviteUrl);
      else toast(`Invite sent to ${r.user.email}`);
      setAsking(null);
    },
  });
  if (link)
    return (
      <span className="secret">
        Invite link for {person.name}, shown once: <span className="mono">{link}</span>{' '}
        <Copy text={link} />{' '}
        <button type="button" className="btn small ghost" onClick={() => setLink(null)}>
          Done
        </button>
      </span>
    );
  if (asking === 'invite')
    return (
      <form
        className="confirm"
        onSubmit={(e) => {
          e.preventDefault();
          invite.mutate();
        }}
      >
        <input
          className="search"
          required
          placeholder="Their name"
          aria-label="Their name"
          value={person.name}
          onChange={(e) => setPerson({ ...person, name: e.target.value })}
        />
        <input
          className="search"
          type="email"
          required
          placeholder="Their email"
          aria-label="Their email"
          value={person.email}
          onChange={(e) => setPerson({ ...person, email: e.target.value })}
        />
        <button type="submit" className="btn primary" disabled={invite.isPending}>
          Create invite link
        </button>
        <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
          Cancel
        </button>
      </form>
    );
  if (asking)
    return (
      <form
        className="confirm"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate(asking);
        }}
      >
        <input
          className="search"
          required
          placeholder={asking === 'suspend' ? 'Why suspend?' : 'Why reinstate?'}
          aria-label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="submit"
          className={`btn${asking === 'suspend' ? ' danger' : ''}`}
          disabled={change.isPending || !reason.trim()}
        >
          {asking === 'suspend' ? 'Suspend' : 'Reinstate'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setAsking(null)}>
          Cancel
        </button>
      </form>
    );
  return (
    <span className="toolbar">
      {onCredit && (
        <button type="button" className="btn" onClick={onCredit}>
          Credit member…
        </button>
      )}
      <button type="button" className="btn" onClick={() => setAsking('invite')}>
        Invite to the portal
      </button>
      {/* Either may suspend; only the house may let a member trade again. */}
      {(status === 'active' || isHouse) && (
        <button
          type="button"
          className={`btn${status === 'active' ? ' danger' : ''}`}
          onClick={() => setAsking(status === 'active' ? 'suspend' : 'reinstate')}
        >
          {status === 'active' ? 'Suspend…' : 'Reinstate…'}
        </button>
      )}
    </span>
  );
}

/**
 * The mutualised pool behind every member. When a member fails to pay, its own margin goes first,
 * then this fund, then the house: so who put in what, and what was drawn, belongs on show.
 */
export function DefaultFund() {
  const { tenantId, isHouse, members } = useSession();
  const [moving, setMoving] = useState<null | 'contribute' | 'withdraw'>(null);
  const fund = useTenant<DefaultFundView>(tenantId, '/default-fund');
  const f = fund.data;
  if (!f) return null;
  const currencies = [
    ...new Set([...f.contributions.map((c) => c.currency), ...members.map((m) => m.homeCurrency)]),
  ];
  return (
    <Panel
      title="Default fund"
      aside={
        <span className="toolbar">
          <Amounts list={f.balances} zeros />
          {isHouse && !moving && (
            <>
              <button type="button" className="btn small" onClick={() => setMoving('contribute')}>
                Contribute…
              </button>
              <button type="button" className="btn small" onClick={() => setMoving('withdraw')}>
                Withdraw…
              </button>
            </>
          )}
        </span>
      }
    >
      {moving && (
        <MoveDefaultFund
          key={moving}
          direction={moving}
          currencies={currencies}
          onClose={() => setMoving(null)}
        />
      )}
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th className="num">Put in</th>
            <th className="num">Drawn</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {!f.contributions.length && <EmptyRow cols={4}>No contributions.</EmptyRow>}
          {f.contributions.map((c) => (
            <tr key={`${c.memberId}-${c.currency}`}>
              <td className="title-cell">
                <Link href={`/members/${c.memberId}`}>{c.name}</Link>
              </td>
              <td className="num">
                <Money value={c.contributed} currency={c.currency} />
              </td>
              <td className="num">
                <Money value={c.drawn} currency={c.currency} />
              </td>
              <td className="num">
                <Money value={c.balance} currency={c.currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th>Losses covered</th>
            <th className="num">1. Deal margin</th>
            <th className="num">2. Portfolio margin</th>
            <th className="num">3. Default fund</th>
            <th className="num">4. House</th>
          </tr>
        </thead>
        <tbody>
          {f.waterfall.map((w) => (
            <tr key={w.currency}>
              <td className="title-cell">{w.currency}</td>
              {[w.dealMargin, w.portfolioMargin, w.defaultFund, w.house].map((amount, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the four steps are fixed
                <td key={i} className="num">
                  <Money value={amount} currency={w.currency} />
                </td>
              ))}
            </tr>
          ))}
          {!f.waterfall.length && <EmptyRow cols={5}>No defaults.</EmptyRow>}
        </tbody>
      </table>
      {f.draws.length > 0 && (
        <div className="panel-foot">
          {f.draws.map((d) => (
            <p key={`${d.cycleId}-${d.at}`} className="error">
              {dateTime(d.at)}: <Money value={d.amount} currency={d.currency} /> drawn from{' '}
              {d.contributorName} to cover {d.defaulterName}
              {d.cycleId && (
                <>
                  {' '}
                  in <Link href={`/settlement/${d.cycleId}`}>{shortId('CY', d.cycleId)}</Link>
                </>
              )}
            </p>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** Who the member is, and whether its accounts are open; the platform can ask the house to open them. */
function MemberDetails({
  id,
  row,
  onOpen,
}: {
  id: string;
  row: Exposure['members'][number];
  onOpen?: () => void;
}) {
  const { tenantId, me } = useSession();
  const [editing, setEditing] = useState(false);
  const asks = useTenant<
    { memberId: string; requestedAt: string; requestedBy: Parameters<typeof actorName>[0] }[]
  >(tenantId, '/provision-requests', { enabled: row.provisioned === false });
  const asked = asks.data?.find((a) => a.memberId === id);
  const ask = useAction(tenantId, {
    run: () => api(`/tenants/${tenantId}/members/${id}/provision-request`, { body: {} }),
    done: 'Sent to the house',
  });
  return (
    <Panel
      title="Details"
      aside={
        <span className="toolbar">
          {me.kind === 'platform' && !editing && (
            <button type="button" className="btn small" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {onOpen ? (
            <button type="button" className="btn small" onClick={onOpen}>
              Open accounts
            </button>
          ) : (
            row.provisioned === false &&
            me.kind === 'platform' && (
              <button
                type="button"
                className="btn small"
                disabled={ask.isPending}
                onClick={() => ask.mutate()}
              >
                Ask the house to open accounts
              </button>
            )
          )}
        </span>
      }
    >
      {editing && <EditMember row={row} onClose={() => setEditing(false)} />}
      <dl className="facts panel-body">
        <dt>Legal name</dt>
        <dd>{row.legalName ?? '—'}</dd>
        <dt>Country</dt>
        <dd>{row.country ?? '—'}</dd>
        <dt>Contact</dt>
        <dd>{row.contactEmail ?? '—'}</dd>
        <dt>Accounts</dt>
        <dd>
          {row.provisioned
            ? `Open${row.accountsOpenedAt ? ` since ${dateTime(row.accountsOpenedAt)}` : ''}`
            : `Not open${row.waitingSince ? `, waiting since ${dateTime(row.waitingSince)}` : ''}`}
        </dd>
        {asked && (
          <>
            <dt>Asked</dt>
            <dd>
              {ago(asked.requestedAt)} by {actorName(asked.requestedBy)}
            </dd>
          </>
        )}
      </dl>
    </Panel>
  );
}

/** A change of where this member is paid, still waiting for a second house person. */
function PayoutChangeWaiting({ id }: { id: string }) {
  const { tenantId } = useSession();
  const held = useTenant<Page<Approval<{ memberId?: string }>>>(
    tenantId,
    '/approvals?kind=rail_refs',
    { live: true },
  );
  if (!held.data?.rows.some((a) => a.payload.memberId === id)) return null;
  return <Pill tone="wait">Change waiting for approval</Pill>;
}

function MemberDeals({ id }: { id: string }) {
  const { tenantId, memberName } = useSession();
  const [, navigate] = useLocation();
  const deals = usePaged<Deal>(`/tenants/${tenantId}/deals`, { memberId: id, limit: '10' });
  const rows = deals.rows ?? [];
  return (
    <Panel
      title="Deals"
      foot={
        deals.more && (
          <button
            type="button"
            className="btn small ghost"
            disabled={deals.loadingMore}
            onClick={() => deals.more?.()}
          >
            Load more
          </button>
        )
      }
    >
      <table>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id} className="row" onClick={() => navigate(`/deals/${d.id}`)}>
              <td className="title-cell">
                <a href={`#/deals/${d.id}`} onClick={(e) => e.stopPropagation()}>
                  {dealSummary(d, memberName)}
                </a>
                <small>{shortId('DL', d.id)}</small>
              </td>
              <td className="nowrap">
                <DealStatus deal={d} />
              </td>
              <td className="muted nowrap">{dateTime(d.createdAt)}</td>
              <td className="num">
                <Money value={d.amount} currency={d.currency} />
              </td>
            </tr>
          ))}
          {!rows.length && (
            <EmptyRow cols={4}>{deals.rows ? 'No deals yet.' : 'Loading…'}</EmptyRow>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function MemberPeople({ id }: { id: string }) {
  const { tenantId } = useSession();
  const people = useTenant<User[]>(tenantId, `/users?memberId=${id}`);
  if (!people.data?.length) return null;
  return (
    <Panel title="People">
      <table>
        <tbody>
          {people.data.map((u) => (
            <tr key={u.id}>
              <td className="title-cell">
                {u.name}
                <small>{u.email}</small>
              </td>
              <td>
                <Pill
                  tone={u.status === 'active' ? 'ok' : u.status === 'invited' ? 'wait' : 'stop'}
                >
                  {sentence(u.status)}
                </Pill>
              </td>
              <td className="muted">{u.mfa ? 'Two-step on' : 'Two-step off'}</td>
              <td className="muted nowrap">
                {u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never signed in'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
