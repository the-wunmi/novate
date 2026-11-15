import { useDeferredValue, useState } from 'react';
import { useLocation } from 'wouter';
import { usePaged } from '../api.ts';
import { dealSummary } from '../describe.tsx';
import { ExportButton } from '../export-menu.tsx';
import { useSession } from '../session.tsx';
import type { Deal } from '../types.ts';
import {
  DealStatus,
  dateTime,
  EmptyRow,
  LoadFailed,
  Money,
  PageHead,
  Panel,
  shortId,
} from '../ui.tsx';

type Group = 'all' | 'open' | 'review' | 'settled' | 'stopped';
const FILTERS: { key: Group; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'review', label: 'In review' },
  { key: 'settled', label: 'Settled' },
  { key: 'stopped', label: 'Cancelled' },
];

const SORTS = {
  createdAt: ['newest', 'oldest'],
  amount: ['largest', 'smallest'],
} as const;

const FUNDING: Record<string, string> = { card: 'Card', x402: 'Stablecoin (x402)' };

export function Deals() {
  const { tenantId, memberName, programLabel, members } = useSession();
  const [, navigate] = useLocation();
  const [member, setMember] = useState('');
  const [filter, setFilter] = useState<Group>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ by: 'createdAt' | 'amount'; desc: boolean }>({
    by: 'createdAt',
    desc: true,
  });
  const needle = useDeferredValue(search.trim());
  const deals = usePaged<Deal, { counts: Record<Group, number> }>(`/tenants/${tenantId}/deals`, {
    memberId: member,
    status: filter === 'all' ? undefined : filter,
    q: needle,
    sort: SORTS[sort.by][sort.desc ? 0 : 1],
  });
  const describe = (d: Deal) => dealSummary(d, memberName);
  const shown = deals.rows ?? [];
  const sortable = (by: 'createdAt' | 'amount', label: string, className?: string) => (
    <th
      className={className}
      aria-sort={sort.by === by ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        type="button"
        className="sort"
        onClick={() => setSort({ by, desc: sort.by === by ? !sort.desc : true })}
      >
        {label}
        {sort.by === by ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <>
      <PageHead
        title="Deals"
        actions={<ExportButton path={`/tenants/${tenantId}/deals.csv`} name="deals" />}
      />
      <Panel
        title={
          <span className="toolbar">
            <select
              className="search"
              aria-label="Member"
              value={member}
              onChange={(e) => setMember(e.target.value)}
            >
              <option value="">All members</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <input
              className="search"
              type="search"
              placeholder="Search deals or members"
              aria-label="Search deals or members"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </span>
        }
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
                <span className="n">{deals.head?.counts[f.key] ?? ''}</span>
              </button>
            ))}
          </div>
        }
      >
        {deals.error && !deals.rows ? (
          <LoadFailed error={deals.error} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Deal</th>
                <th className="hide-md">Program</th>
                <th className="hide-md">Funded by</th>
                <th>Status</th>
                {sortable('createdAt', 'Created')}
                {sortable('amount', 'Amount', 'num')}
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className="row" onClick={() => navigate(`/deals/${d.id}`)}>
                  <td className="title-cell">
                    <a href={`#/deals/${d.id}`} onClick={(e) => e.stopPropagation()}>
                      {describe(d)}
                    </a>
                    <small>{shortId('DL', d.id)}</small>
                  </td>
                  <td className="muted nowrap hide-md">{programLabel(d.programId)}</td>
                  <td className="muted nowrap hide-md">
                    {FUNDING[d.funding ?? ''] ?? 'Wallet balance'}
                  </td>
                  <td className="nowrap">
                    <DealStatus deal={d} />
                  </td>
                  <td className="muted nowrap">{dateTime(d.createdAt)}</td>
                  <td className="num">
                    <Money value={d.amount} currency={d.currency} />
                    {(() => {
                      // What actually settled, when less than agreed: a partial release.
                      const settled = d.settledAmount ?? d.releaseAmount;
                      return settled && BigInt(settled) !== BigInt(d.amount) ? (
                        <small className="sub-line muted">
                          <Money value={settled} currency={d.currency} />{' '}
                          {d.settledAmount ? 'settled' : 'released'}
                        </small>
                      ) : null;
                    })()}
                  </td>
                </tr>
              ))}
              {!shown.length && (
                <EmptyRow cols={6}>
                  {!deals.rows ? 'Loading…' : needle ? 'No deals match.' : 'No deals yet.'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        )}
        {deals.more && (
          <div className="panel-foot">
            <button
              type="button"
              className="btn small"
              disabled={deals.loadingMore}
              onClick={deals.more}
            >
              {deals.loadingMore ? 'Loading…' : 'Load older deals'}
            </button>
          </div>
        )}
      </Panel>
    </>
  );
}
