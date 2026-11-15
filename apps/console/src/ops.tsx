// Payouts that need someone, across every cycle, and every member's withdrawals.
import { Link } from 'wouter';
import { api, type Page, useAction, useTenant } from './api.ts';
import { useSession } from './session.tsx';
import type { ProblemPayout, TenantWithdrawal } from './types.ts';
import {
  duration,
  EmptyRow,
  LoadFailed,
  Money,
  PAYOUT_STATUS,
  Panel,
  PayoutStatus,
  railName,
  shortId,
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
            <tr key={w.id}>
              <td className="title-cell">
                {memberId ? (
                  railName(w.rail)
                ) : (
                  <>
                    <Link href={`/members/${w.memberId}`}>{w.memberName}</Link>
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
            </tr>
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
