// A member's statement: every line in the member's own terms, with running balances, a period
// and a CSV that matches the screen. Shared by the house's member page and the member portal.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'wouter';
import { api, LIVE_MS } from './api.ts';
import { lockRateText } from './describe.tsx';
import { ExportButton } from './export-menu.tsx';
import { PeriodSwitch, usePeriod } from './periods.tsx';
import type { Statement, StatementLine } from './types.ts';
import {
  Amounts,
  dateTime,
  EmptyRow,
  fullDateTime,
  LoadFailed,
  Money,
  Panel,
  sentence,
  shortDate,
  shortId,
} from './ui.tsx';

const KINDS: Record<string, string> = {
  deposit: 'Deposit received',
  deposit_reversal: 'Deposit reversed',
  lock: 'Locked for a deal',
  release: 'Released from a deal',
  deal_proceeds: 'Proceeds of a sale',
  amount_owed: 'Owed for a purchase',
  netting_offset: 'Offset by netting',
  fx_conversion: 'Currency converted',
  paid_in: 'Paid in for settlement',
  paid_from_wallet: 'Paid from balance',
  payout: 'Paid to your bank',
  payout_to_wallet: 'Payout kept in balance',
  payout_returned: 'Payout returned',
  withdrawal_requested: 'Withdrawal requested',
  withdrawal: 'Withdrawal',
  fee: 'Fee',
  claim_refund: 'Claim refunded',
  margin_draw: 'Paid from margin',
};

export function StatementPanel({
  tenantId,
  memberId,
  name,
}: {
  tenantId: string;
  memberId: string;
  name: string;
}) {
  const period = usePeriod(['month', 'lastMonth', '30d', 'all', 'custom']);
  const { from, query } = period;
  // The first page carries the balances; older pages only add lines.
  const statement = useInfiniteQuery({
    queryKey: ['tenant', tenantId, 'statement', memberId, query],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(query.slice(1));
      if (pageParam) params.set('before', pageParam);
      const search = params.toString();
      return api<Statement>(
        `/tenants/${tenantId}/members/${memberId}/statement${search ? `?${search}` : ''}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: LIVE_MS,
    enabled: period.ready,
  });
  const first = statement.data?.pages[0];
  const s = first && {
    ...first,
    lines: statement.data?.pages.flatMap((p) => p.lines) ?? [],
  };
  // One currency at a time reads like a bank statement; running balances are per currency anyway.
  const currencies = [...new Set((s?.closingBalance ?? []).map((b) => b.currency))];
  const [currency, setCurrency] = useState('');
  const shown = (s?.lines ?? []).filter((l) => !currency || l.currency === currency);
  const zero = currencies.map((c) => ({ currency: c, amount: '0' }));
  const pick = <T extends { currency: string }>(list: T[]) =>
    list.filter((b) => !currency || b.currency === currency);

  return (
    <Panel
      title="Statement"
      aside={
        <div className="toolbar">
          {currencies.length > 1 && (
            <select
              className="search"
              aria-label="Currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="">All currencies</option>
              {currencies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          )}
          <PeriodSwitch period={period} />
          <ExportButton
            path={`/tenants/${tenantId}/members/${memberId}/statement.csv`}
            name={`${name.toLowerCase().replaceAll(' ', '-')}-statement`}
            period={period}
          />
        </div>
      }
    >
      {statement.isError && !s ? (
        <LoadFailed error={statement.error} />
      ) : (
        <>
          <div className="balances">
            {from && (
              <span>
                <span className="muted">Opening balance </span>
                <Amounts
                  list={pick(s?.openingBalance?.length ? s.openingBalance : zero)}
                  empty="0.00"
                />
              </span>
            )}
            <span>
              <span className="muted">Closing balance </span>
              <Amounts list={pick(s?.closingBalance ?? [])} empty="0.00" />
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th>Reference</th>
                <th className="num">Amount</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: entries posted together share time and reference
                <tr key={`${l.at}-${l.kind}-${i}`}>
                  <td className="nowrap" title={fullDateTime(l.at)}>
                    {dateTime(l.at)}
                  </td>
                  <td>
                    {KINDS[l.kind] ?? sentence(l.kind)}
                    <small className="sub-line faint">{detail(l)}</small>
                  </td>
                  <td>
                    <References line={l} />
                  </td>
                  <td className="num">
                    {l.kind === 'netting_offset' && l.offset ? (
                      <span className="muted">
                        <Money value={l.offset} currency={l.currency} /> offset
                      </span>
                    ) : BigInt(l.amount) === 0n && BigInt(l.available) !== 0n ? (
                      // Nothing came in or went out; money moved between free and set aside.
                      <span className="muted">
                        <Money value={l.available} currency={l.currency} />{' '}
                        {BigInt(l.available) > 0n ? 'freed' : 'set aside'}
                      </span>
                    ) : (
                      <Money value={l.amount} currency={l.currency} />
                    )}
                  </td>
                  <td className="num">
                    <Money value={l.balance} currency={l.currency} />
                    <small className="sub-line faint">
                      <Money value={l.availableBalance} currency={l.currency} /> free
                    </small>
                  </td>
                </tr>
              ))}
              {s && !shown.length && <EmptyRow cols={5}>No movements in this period.</EmptyRow>}
              {!s && statement.isLoading && <EmptyRow cols={5}>Loading…</EmptyRow>}
            </tbody>
          </table>
          {statement.hasNextPage && (
            <div className="panel-foot">
              <button
                type="button"
                className="btn small"
                disabled={statement.isFetchingNextPage}
                onClick={() => statement.fetchNextPage()}
              >
                {statement.isFetchingNextPage ? 'Loading…' : 'Load older'}
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function detail(l: StatementLine) {
  const parts = [
    lockRateText(l) ?? (l.rate ? `at ${l.rate}` : null),
    l.valueDate ? `value date ${shortDate(l.valueDate)}` : null,
  ].filter(Boolean);
  return parts.join(', ');
}

function References({ line: l }: { line: StatementLine }) {
  return (
    <span className="refs">
      {l.dealId && (
        <Link className="ref" href={`/deals/${l.dealId}`}>
          {shortId('DL', l.dealId)}
        </Link>
      )}
      {l.cycleId && (
        <Link className="ref" href={`/settlement/${l.cycleId}`}>
          {shortId('CY', l.cycleId)}
        </Link>
      )}
      {l.externalRef && (
        <span className="ref mono" title={l.externalRef}>
          {l.externalRef.length > 14 ? `${l.externalRef.slice(0, 8)}…` : l.externalRef}
        </span>
      )}
      {!l.dealId && !l.cycleId && !l.externalRef && <span className="faint">—</span>}
    </span>
  );
}
