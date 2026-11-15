import { type FormEvent, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, useAction, useTenant } from '../api.ts';
import { useSession } from '../session.tsx';
import type { Exposure, HouseRisk } from '../types.ts';
import {
  Amounts,
  EmptyRow,
  LoadFailed,
  Money,
  PageHead,
  Panel,
  Pill,
  sentence,
  type Tone,
} from '../ui.tsx';
import { AgentsPanel } from './agents.tsx';
import { DefaultFund } from './member-page.tsx';

/** Long account numbers and wallet addresses, short enough for a table: "GB91…5278". */
export const masked = (value: string) =>
  value.length > 10 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;

type Row = Exposure['members'][number];

/** Where a member pays in and where it is paid, as values rather than names of fields. */
export function AccountsText({ row }: { row: Pick<Row, 'depositAccounts' | 'payoutAccount'> }) {
  const payIn = row.depositAccounts.map((d) => {
    const number = d.details?.iban ?? d.details?.accountNumber ?? d.reference;
    return `${masked(number)}${d.details ? ` ${d.details.currency}` : ''}`;
  });
  const out = row.payoutAccount;
  if (!payIn.length && !out) return <>—</>;
  return (
    <>
      {payIn.length > 0 && <span className="sub-line">In {payIn.join(', ')}</span>}
      {out && (
        <span className="sub-line">
          Out {out.label}
          {out.currency ? ` ${out.currency}` : ''}
        </span>
      )}
    </>
  );
}

const MEMBER_STATUS: Record<string, [string, Tone]> = {
  active: ['Active', 'ok'],
  close_only: ['Close-out only', 'wait'],
  suspended: ['Suspended', 'stop'],
};

export function MemberStatus({ status }: { status: string }) {
  const [label, tone] = MEMBER_STATUS[status] ?? [sentence(status), ''];
  return <Pill tone={tone}>{label}</Pill>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const sum = (rows: Row['currencies'], pick: (c: Row['currencies'][number]) => string) =>
  rows.map((c) => ({ currency: c.currency, amount: pick(c) }));

export function Members() {
  const { tenantId, agents, me } = useSession();
  const [, navigate] = useLocation();
  const exposure = useTenant<Exposure>(tenantId, '/exposure');
  const [adding, setAdding] = useState(false);
  const rows = exposure.data?.members ?? [];

  return (
    <>
      <PageHead
        title="Members"
        actions={
          me.kind === 'platform' && (
            <button type="button" className="btn primary" onClick={() => setAdding(!adding)}>
              Add member
            </button>
          )
        }
      />
      <div className="stack">
        {exposure.data && <RiskPanel risk={exposure.data.risk} />}
        <Panel>
          {adding && <AddMember onDone={() => setAdding(false)} />}
          {exposure.isError && !exposure.data ? (
            <LoadFailed error={exposure.error} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Status</th>
                  <th className="hide-md">Accounts</th>
                  <th className="num">Available</th>
                  <th className="num">Locked in deals</th>
                  <th className="num">Open net position</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  return (
                    <tr
                      key={m.memberId}
                      className="row"
                      onClick={() => navigate(`/members/${m.memberId}`)}
                    >
                      <td className="title-cell nowrap">
                        <a href={`#/members/${m.memberId}`} onClick={(e) => e.stopPropagation()}>
                          {m.name}
                        </a>
                        <small>
                          {m.homeCurrency},{' '}
                          {plural(agents.filter((a) => a.memberId === m.memberId).length, 'agent')}
                        </small>
                      </td>
                      <td>
                        <MemberStatus status={m.status} />
                        {m.provisioned === false && (
                          <small className="sub-line">No accounts yet</small>
                        )}
                        {m.marginCalls.length > 0 && (
                          <small className="sub-line error">
                            {m.marginCalls.length} margin call
                          </small>
                        )}
                      </td>
                      <td className="muted hide-md">
                        <AccountsText row={m} />
                      </td>
                      <td className="num">
                        <Amounts list={sum(m.currencies, (c) => c.available)} empty="0.00" />
                      </td>
                      <td className="num">
                        <Amounts list={sum(m.currencies, (c) => c.locked)} empty="0.00" />
                      </td>
                      <td className="num">
                        <Amounts
                          list={sum(m.currencies, (c) => c.openObligations.net)}
                          empty="0.00"
                        />
                      </td>
                    </tr>
                  );
                })}
                {exposure.data && !rows.length && <EmptyRow cols={6}>No members yet.</EmptyRow>}
                {!exposure.data && !exposure.isError && <EmptyRow cols={6}>Loading…</EmptyRow>}
              </tbody>
            </table>
          )}
        </Panel>
        <AgentsPanel agents={agents} />
        <DefaultFund />
      </div>
    </>
  );
}

const percent = (part: bigint, whole: bigint) =>
  whole > 0n ? `${(Number((part * 1000n) / whole) / 10).toFixed(0)}%` : '—';

/**
 * The house's own exposure per currency: what members owe that nothing it holds secures, who would
 * cost most if they failed and what the default fund holds against that, open margin calls, and
 * card money it has credited before the card network paid it over.
 */
function RiskPanel({ risk }: { risk: HouseRisk[] }) {
  return (
    <Panel title="House exposure">
      <table>
        <thead>
          <tr>
            <th>Currency</th>
            <th className="num">Open payables</th>
            <th className="num">Unsecured</th>
            <th>Largest unsecured</th>
            <th className="num">Default fund</th>
            <th className="num">Margin calls</th>
            <th className="num">Card money fronted</th>
          </tr>
        </thead>
        <tbody>
          {risk.map((r) => {
            const largest = r.largest ? BigInt(r.largest.amount) : 0n;
            const short = largest > BigInt(r.defaultFund);
            return (
              <tr key={r.currency}>
                <td className="title-cell">{r.currency}</td>
                <td className="num">
                  <Money value={r.payable} currency={r.currency} />
                </td>
                <td className="num">
                  <Money value={r.unsecured} currency={r.currency} />
                </td>
                <td>
                  {r.largest ? (
                    <>
                      <Link href={`/members/${r.largest.memberId}`}>{r.largest.name}</Link>
                      <small className="sub-line muted">
                        <Money value={r.largest.amount} currency={r.currency} />,{' '}
                        {percent(largest, BigInt(r.unsecured))}
                      </small>
                    </>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="num">
                  <span className={short ? 'error' : undefined}>
                    <Money value={r.defaultFund} currency={r.currency} />
                  </span>
                  {r.largest && (
                    <small className="sub-line muted">
                      {percent(BigInt(r.defaultFund), largest)} of largest
                    </small>
                  )}
                </td>
                <td className="num">
                  {r.marginCalls.count ? (
                    <span className="error">
                      {r.marginCalls.count},{' '}
                      <Money value={r.marginCalls.amount} currency={r.currency} />
                    </span>
                  ) : (
                    <span className="faint">0</span>
                  )}
                </td>
                <td className="num">
                  <Money value={r.cardsFronted} currency={r.currency} />
                </td>
              </tr>
            );
          })}
          {!risk.length && <EmptyRow cols={7}>Nothing open.</EmptyRow>}
        </tbody>
      </table>
    </Panel>
  );
}

function AddMember({ onDone }: { onDone: () => void }) {
  const { tenantId } = useSession();
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [legalName, setLegalName] = useState('');
  const [country, setCountry] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const add = useAction(tenantId, {
    run: () =>
      api(`/tenants/${tenantId}/members`, {
        body: {
          name,
          homeCurrency: currency,
          ...(legalName.trim() ? { legalName: legalName.trim() } : {}),
          ...(country.trim() ? { country: country.trim().toUpperCase() } : {}),
          ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
        },
      }),
    done: `${name} added`,
    onDone,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) add.mutate();
  };
  return (
    <form className="form-inline" onSubmit={submit}>
      <label className="field">
        Business name
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Legal name
        <input value={legalName} onChange={(e) => setLegalName(e.target.value)} />
      </label>
      <label className="field">
        Country
        <input
          placeholder="NL"
          maxLength={2}
          pattern="[A-Za-z]{2}"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
        />
      </label>
      <label className="field">
        Contact email
        <input
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />
      </label>
      <label className="field">
        Home currency
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {['EUR', 'GBP', 'USD', 'AUD', 'SGD', 'HKD', 'CNY', 'JPY'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn primary" disabled={add.isPending}>
        Add member
      </button>
    </form>
  );
}
