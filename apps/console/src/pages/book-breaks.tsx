import { useState } from 'react';
import { api, isPending, type Pending, useAction } from '../api.ts';
import { differenceItems } from '../differences.ts';
import { useSession } from '../session.tsx';
import type { ReconBreak, RunBreak } from '../types.ts';
import { actorName, dateTime, duration, Money, Panel, Pill, Ref, railName } from '../ui.tsx';
import { cause } from './rail-books.tsx';

const RESOLUTIONS: Record<string, string> = {
  posted: 'Booked',
  explained: 'Explained',
  written_off: 'Written off',
  opening_rebased: 'Opening re-recorded',
};

export function BreakStatus({ b }: { b: RunBreak }) {
  if (!b.status) return <span className="faint">—</span>;
  if (b.status === 'open') return <Pill tone="stop">Open</Pill>;
  const r = b.resolution;
  return (
    <span title={r?.reason}>
      <Pill tone="ok">{RESOLUTIONS[r?.resolution ?? ''] ?? 'Resolved'}</Pill>
      {r && (
        <small className="sub-line faint">
          {actorName(r.actor)}, {dateTime(r.at)}
        </small>
      )}
    </span>
  );
}

/**
 * Every difference not yet resolved, oldest first, whatever later checks found. Each is closed by
 * saying what it was: booked with a reference, explained, or written off. Settlement waits for all.
 */
export function OpenBreaks({ breaks }: { breaks: ReconBreak[] }) {
  const { isHouse } = useSession();
  const shown = differenceItems(breaks);
  return (
    <Panel title="Open differences">
      <table>
        <thead>
          <tr>
            <th>Difference</th>
            <th>Age</th>
            <th className="num">Ledger</th>
            <th className="num">Rail</th>
            <th>Reference</th>
            <th>Owner</th>
            {isHouse && <th>Resolve</th>}
          </tr>
        </thead>
        <tbody>
          {shown.map((b) => (
            <tr key={b.id}>
              <td>
                {cause(b, b.rail)}
                <small className="sub-line faint">{railName(b.rail)}</small>
              </td>
              <td className={`nowrap${b.ageSeconds > 86_400 ? ' error' : ''}`}>
                {duration(b.ageSeconds)}
              </td>
              <td className="num">
                {b.kind === 'missing_in_ledger' ? (
                  <span className="faint">Not booked</span>
                ) : (
                  <Money value={b.expected} currency={b.currency} />
                )}
              </td>
              <td className="num">
                {b.kind === 'missing_on_rail' ? (
                  <span className="faint">Not on statement</span>
                ) : (
                  <Money value={b.actual} currency={b.currency} />
                )}
              </td>
              <td>{b.externalRef ? <Ref id={b.externalRef} /> : '—'}</td>
              <td>
                <BreakOwner b={b} />
              </td>
              {isHouse && (
                <td>
                  <Resolve b={b} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Resolve({ b }: { b: ReconBreak }) {
  const { tenantId } = useSession();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState('explained');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const resolve = useAction(tenantId, {
    run: () =>
      api<{ resolved: string[] } | Pending>(
        `/tenants/${tenantId}/reconciliation/breaks/${b.id}/resolve`,
        {
          body: {
            resolution,
            reason: reason.trim(),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
          },
        },
      ),
    done: (r) =>
      isPending(r)
        ? 'Sent for approval'
        : r.resolved.length > 1
          ? `Resolved, with ${r.resolved.length - 1} repeats of it`
          : 'Resolved',
  });
  if (!open)
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)}>
        Resolve…
      </button>
    );
  const needsRef = resolution === 'posted';
  return (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        resolve.mutate();
      }}
    >
      <select
        className="search"
        aria-label="Resolution"
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
      >
        <option value="explained">Explained</option>
        <option value="posted">Booked in the ledger</option>
        <option value="written_off">Written off</option>
      </select>
      {needsRef && (
        <input
          className="search"
          required
          placeholder="Ledger transfer ID"
          aria-label="Ledger reference"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      )}
      <input
        className="search"
        required
        placeholder="What it was"
        aria-label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="submit"
        className="btn small primary"
        disabled={resolve.isPending || !reason.trim() || (needsRef && !reference.trim())}
      >
        Resolve
      </button>
      <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** Who is working a difference. Taking it is recorded; anyone can see who has it. */
function BreakOwner({ b }: { b: ReconBreak }) {
  const { tenantId, me, canAct } = useSession();
  const mine = Boolean(me.userId) && b.assignee?.userId === me.userId;
  const change = useAction(tenantId, {
    run: (to: 'assign' | 'unassign') =>
      api(`/tenants/${tenantId}/reconciliation/breaks/${b.id}/${to}`, { body: {} }),
  });
  return (
    <span className="owner">
      {b.assignee ? <span>{actorName(b.assignee)}</span> : <span className="faint">Nobody</span>}{' '}
      {canAct && (
        <button
          type="button"
          className="link"
          disabled={change.isPending}
          onClick={() => change.mutate(mine ? 'unassign' : 'assign')}
        >
          {mine ? 'Release' : b.assignee ? 'Take over' : 'Take it'}
        </button>
      )}
    </span>
  );
}
