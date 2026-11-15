// Payouts that need someone, across every cycle, and every member's withdrawals.
import { type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import { api, type Page, useAction, useTenant } from './api.ts';
import { useSession } from './session.tsx';
import type { ProblemPayout, TenantWithdrawal, WithdrawalAttempt } from './types.ts';
import {
  dateTime,
  duration,
  EmptyRow,
  LoadFailed,
  Money,
  PAYOUT_STATUS,
  Panel,
  PayoutStatus,
  railName,
  shortId,
  type Tone,
} from './ui.tsx';

/** Payouts in doubt, failed or returned, newest first: one list the overview reads too. */
export const usePayoutProblems = (tenantId: string) =>
  useTenant<Page<ProblemPayout>>(tenantId, '/payouts', { live: true });

export function ProblemPayouts() {
  const { tenantId, isHouse } = useSession();
  const problems = usePayoutProblems(tenantId);
  const rows = problems.data?.rows ?? [];
  const refresh = useAction(tenantId, {
    run: (id: string) =>
      api<{ was: string; status: string; applied: boolean }>(
        `/tenants/${tenantId}/payouts/${id}/refresh`,
        { body: {} },
      ),
    done: (r) =>
      r.applied ? `Now ${PAYOUT_STATUS[r.status]?.[0] ?? r.status}` : 'No change on the rail',
  });
  if (problems.error && !problems.data) {
    return (
      <Panel title="Payouts needing attention">
        <LoadFailed error={problems.error} />
      </Panel>
    );
  }
  if (!rows.length) return null;
  return (
    <Panel title="Payouts needing attention">
      <table>
        <thead>
          <tr>
            <th>To</th>
            <th>Status</th>
            <th>Waiting</th>
            <th>Reference</th>
            <th className="num">Amount</th>
            {isHouse && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="title-cell">
                <Link href={`/members/${p.memberId}`}>{p.memberName}</Link>
                <small>
                  {p.withdrawal ? 'Withdrawal' : p.cycleId ? shortId('CY', p.cycleId) : ''},{' '}
                  {railName(p.rail)}
                  {p.attempt > 1 ? `, attempt ${p.attempt}` : ''}
                </small>
              </td>
              <td>
                <PayoutStatus status={p.status} />
                {p.failureReason && <small className="sub-line error">{p.failureReason}</small>}
              </td>
              <td className={`nowrap${p.ageSeconds > 86_400 ? ' error' : ''}`}>
                {duration(p.ageSeconds)}
              </td>
              <td className="mono muted">{p.externalRef ?? '—'}</td>
              <td className="num">
                <Money value={p.amount} currency={p.currency} />
              </td>
              {isHouse && (
                <td className="num">
                  {p.externalRef && (
                    <button
                      type="button"
                      className="btn small"
                      disabled={refresh.isPending}
                      onClick={() => refresh.mutate(p.id)}
                    >
                      Ask the rail
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/** Withdrawals across members, or one member's when `memberId` is given. */
export function AllWithdrawals({ memberId }: { memberId?: string }) {
  const { tenantId } = useSession();
  const list = useTenant<Page<TenantWithdrawal>>(
    tenantId,
    `/withdrawals?limit=50${memberId ? `&memberId=${memberId}` : ''}`,
    { live: true },
  );
  const rows = list.data?.rows ?? [];
  return (
    <Panel title="Withdrawals">
      <table>
        <thead>
          <tr>
            <th>{memberId ? 'Rail' : 'Member'}</th>
            <th>Status</th>
            <th>Age</th>
            <th>Reference</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => (
            <ExpandableRow
              key={w.id}
              cols={5}
              detail={<WithdrawalAttempts tenantId={tenantId} memberId={w.memberId} id={w.id} />}
              cells={(toggle) => (
                <>
                  <td className="title-cell">
                    {toggle}
                    {memberId ? (
                      railName(w.rail)
                    ) : (
                      <>
                        <Link href={`/members/${w.memberId}`} onClick={(e) => e.stopPropagation()}>
                          {w.memberName}
                        </Link>
                        <small>{railName(w.rail)}</small>
                      </>
                    )}
                  </td>
                  <td>
                    <PayoutStatus status={w.status} />
                    {w.failureReason && <small className="sub-line error">{w.failureReason}</small>}
                    {w.returnedToWallet && <small className="sub-line">Back in balance</small>}
                  </td>
                  <td className="muted nowrap">{duration(w.ageSeconds)}</td>
                  <td className="mono muted">{w.externalRef ?? '—'}</td>
                  <td className="num">
                    <Money value={w.amount} currency={w.currency} />
                  </td>
                </>
              )}
            />
          ))}
          {list.data && !rows.length && <EmptyRow cols={5}>No withdrawals.</EmptyRow>}
          {list.error && !list.data && (
            <EmptyRow cols={5}>
              <LoadFailed error={list.error} />
            </EmptyRow>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

/** A row that opens beneath itself to show more. `cells` places the toggle in its first cell. */
export function ExpandableRow({
  cols,
  cells,
  detail,
}: {
  cols: number;
  cells: (toggle: ReactNode) => ReactNode;
  detail: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="row" onClick={() => setOpen(!open)}>
        {cells(
          <span className="chev" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>,
        )}
      </tr>
      {open && (
        <tr className="open">
          <td colSpan={cols}>{detail}</td>
        </tr>
      )}
    </>
  );
}

/** Each attempt at paying one withdrawal: a failed one is retried as a new attempt. */
export function WithdrawalAttempts({
  tenantId,
  memberId,
  id,
  labels,
}: {
  tenantId: string;
  memberId: string;
  id: string;
  labels?: Record<string, [string, Tone]>;
}) {
  const detail = useTenant<WithdrawalAttempt[]>(
    tenantId,
    `/members/${memberId}/withdrawals/${id}`,
    { live: true },
  );
  if (detail.error && !detail.data) return <LoadFailed error={detail.error} />;
  return (
    <table>
      <thead>
        <tr>
          <th>Attempt</th>
          <th>Status</th>
          <th>Reference</th>
          <th>Created</th>
          <th>Updated</th>
          <th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {(detail.data ?? []).map((i) => (
          <tr key={i.id}>
            <td>{i.attempt}</td>
            <td>
              <PayoutStatus status={i.status} labels={labels} />
              {i.failureReason && <small className="sub-line error">{i.failureReason}</small>}
              {i.returnedToWalletAt && (
                <small className="sub-line">Back in balance {dateTime(i.returnedToWalletAt)}</small>
              )}
            </td>
            <td className="mono muted">{i.externalRef ?? '—'}</td>
            <td className="muted nowrap">{dateTime(i.createdAt)}</td>
            <td className="muted nowrap">{dateTime(i.updatedAt)}</td>
            <td className="num">
              <Money value={i.amount} currency={i.currency} />
            </td>
          </tr>
        ))}
        {!detail.data && <EmptyRow cols={6}>Loading…</EmptyRow>}
      </tbody>
    </table>
  );
}
