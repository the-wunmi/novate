// Changes held for a second person: manual credits, write-offs, decisions above the ceiling, new
// rail openings and payout details. The change runs only when someone other than the requester
// approves it, and every request stays on the record with what became of it.
import type { ControlActor } from '@novate/core';
import { useState } from 'react';
import { api, type Page, useAction, usePaged, useTenant } from './api.ts';
import { APPROVAL_KINDS } from './describe.tsx';
import { ExportButton } from './export-menu.tsx';
import { useSession } from './session.tsx';
import type { Approval, Me } from './types.ts';
import {
  actorName,
  dateTime,
  EmptyRow,
  LoadFailed,
  Money,
  Panel,
  Pill,
  sentence,
  type Tone,
  until,
  words,
} from './ui.tsx';

const kindOf = (kind: string) => APPROVAL_KINDS[kind] ?? sentence(kind);

/** What a held change of payout details would set, in place of what. */
function RailRefsChange({ a }: { a: Approval }) {
  const { memberName } = useSession();
  if (a.kind !== 'rail_refs') return null;
  const p = a.payload as {
    memberId: string;
    refs: Record<string, string>;
    before: Record<string, string | null>;
  };
  return (
    <small className="sub-line">
      {memberName(p.memberId)}:{' '}
      {Object.entries(p.refs)
        .map(([k, v]) => `${words(k)} ${p.before[k] ?? 'none'} → ${v}`)
        .join(', ')}
    </small>
  );
}

export function Approvals() {
  const { tenantId } = useSession();
  const list = useTenant<Page<Approval>>(tenantId, '/approvals', { live: true });
  // A member's own requests are for its own people; the house only reads them in the history.
  const rows = (list.data?.rows ?? []).filter((a) => !a.memberId);
  if (!rows.length) return null;
  return (
    <Panel title="Waiting for approval" sub={String(rows.length)}>
      <table>
        <tbody>
          {rows.map((a) => (
            <tr key={a.approvalId}>
              <td className="title-cell">
                {kindOf(a.kind)}
                <small>
                  {actorName(a.requestedBy)}, {dateTime(a.requestedAt)}: {a.reason}
                </small>
                <RailRefsChange a={a} />
              </td>
              <td className="num">
                {a.amount && a.currency ? <Money value={a.amount} currency={a.currency} /> : null}
              </td>
              <td className="muted nowrap">{until(a.expiresAt).text}</td>
              <td className="num">
                <ApprovalActions a={a} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

const OUTCOMES: Record<Approval['status'], [string, Tone]> = {
  pending: ['Waiting', 'wait'],
  approved: ['Approved', 'ok'],
  rejected: ['Rejected', 'stop'],
  expired: ['Expired', ''],
};

const STATUSES = [
  { key: 'decided', label: 'Decided' },
  { key: 'pending', label: 'Waiting' },
  { key: 'all', label: 'All' },
] as const;

/** Every held change and what became of it: who asked, who decided, when and why. */
export function ApprovalHistory() {
  const { tenantId } = useSession();
  const [status, setStatus] = useState<(typeof STATUSES)[number]['key']>('decided');
  const [kind, setKind] = useState('');
  const list = usePaged<Approval>(`/tenants/${tenantId}/approvals`, {
    status,
    kind: kind || undefined,
  });
  const rows = list.rows ?? [];
  return (
    <Panel
      title="Approvals"
      aside={
        <div className="actions">
          <select
            className="field"
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All kinds</option>
            {Object.entries(APPROVAL_KINDS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <div className="seg">
            {STATUSES.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={status === s.key}
                onClick={() => setStatus(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          <ExportButton path={`/tenants/${tenantId}/approvals.csv`} name="approvals" />
        </div>
      }
    >
      {list.error && !list.rows ? (
        <LoadFailed error={list.error} />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Request</th>
              <th>Asked by</th>
              <th className="num">Amount</th>
              <th>Outcome</th>
              <th>Decided by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <HistoryRow key={a.approvalId} a={a} />
            ))}
            {list.rows && !rows.length && <EmptyRow cols={5}>None.</EmptyRow>}
          </tbody>
        </table>
      )}
      {list.more && (
        <div className="panel-foot">
          <button
            type="button"
            className="btn small ghost"
            disabled={list.loadingMore}
            onClick={list.more}
          >
            {list.loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </Panel>
  );
}

function HistoryRow({ a }: { a: Approval }) {
  const [label, tone] = OUTCOMES[a.status];
  const decision = a.decision as { by: ControlActor; at: string; reason: string | null } | null;
  return (
    <tr>
      <td className="title-cell">
        {kindOf(a.kind)}
        <small>{a.reason}</small>
        <RailRefsChange a={a} />
      </td>
      <td>
        {actorName(a.requestedBy)}
        <small className="sub-line faint">{dateTime(a.requestedAt)}</small>
      </td>
      <td className="num">
        {a.amount && a.currency ? <Money value={a.amount} currency={a.currency} /> : '—'}
      </td>
      <td className="nowrap">
        <Pill tone={tone}>{label}</Pill>
        {a.status === 'expired' && (
          <small className="sub-line faint">{dateTime(a.expiresAt)}</small>
        )}
      </td>
      <td>
        {decision ? (
          <>
            {actorName(decision.by)}
            <small className="sub-line faint">{dateTime(decision.at)}</small>
            {decision.reason && <small className="sub-line">{decision.reason}</small>}
          </>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

/** Approve, reject, or withdraw one's own request. */
export function ApprovalActions({ a }: { a: Approval<unknown> }) {
  const { tenantId, me } = useSession();
  return <DecideApproval a={a} tenantId={tenantId} me={me} />;
}

/** The same, outside the operator screens: the member portal has no session context. */
export function DecideApproval({
  a,
  tenantId,
  me,
}: {
  a: Approval<unknown>;
  tenantId: string;
  me: Me;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const mine = Boolean(me.userId) && a.requestedBy.userId === me.userId;
  const mayApprove = !mine && a.approvers.includes(me.kind);
  const decide = useAction(tenantId, {
    run: (to: 'approve' | 'reject') =>
      api(`/tenants/${tenantId}/approvals/${a.approvalId}/${to}`, {
        body: to === 'approve' ? {} : { reason: reason.trim() },
      }),
    done: (_r, to) => (to === 'approve' ? 'Approved' : mine ? 'Withdrawn' : 'Rejected'),
  });
  if (!mine && !mayApprove) return null;
  return rejecting ? (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        decide.mutate('reject');
      }}
    >
      <input
        className="search"
        required
        placeholder="Reason"
        aria-label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="submit"
        className="btn small danger"
        disabled={decide.isPending || !reason.trim()}
      >
        {mine ? 'Withdraw' : 'Reject'}
      </button>
      <button type="button" className="btn small ghost" onClick={() => setRejecting(false)}>
        Cancel
      </button>
    </form>
  ) : (
    <span className="confirm">
      {mayApprove && (
        <button
          type="button"
          className="btn small primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate('approve')}
        >
          Approve
        </button>
      )}
      <button type="button" className="btn small ghost" onClick={() => setRejecting(true)}>
        {mine ? 'Withdraw…' : 'Reject…'}
      </button>
    </span>
  );
}
