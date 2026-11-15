import { type FormEvent, useState } from 'react';
import { Link } from 'wouter';
import { api, useAction, useTenant } from './api.ts';
import { differenceItems } from './differences.ts';
import { useSession } from './session.tsx';
import type { ReconBreak, Tenant } from './types.ts';
import { actorName, Pill, railName } from './ui.tsx';

/**
 * Whether settlement is running, and the one switch for it. Stopping holds every member's money, so
 * both directions ask for a reason, which goes on the audit record, before anything happens.
 */
export function SettlementSwitch() {
  const { isHouse, tenantId, canAct: mayAct } = useSession();
  // Reconciliation stops settlement on its own, so both are kept live while the switch shows.
  const tenant = useTenant<Tenant>(tenantId, '', { live: true }).data;
  const halted = Boolean(tenant?.settlementHaltedAt);
  // A rail with an open books difference settles nothing until it is resolved.
  const breaks = useTenant<ReconBreak[]>(tenantId, '/reconciliation/breaks', { live: true });
  const held = [
    ...differenceItems(breaks.data ?? []).reduce(
      (m, b) => m.set(b.rail ?? '', (m.get(b.rail ?? '') ?? 0) + 1),
      new Map<string, number>(),
    ),
  ];
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const toggle = useAction(tenantId, {
    run: () =>
      api(`/tenants/${tenantId}/settlement/${halted ? 'resume' : 'stop'}`, {
        body: { reason: reason.trim() },
      }),
    done: halted ? 'Settlement resumed' : 'Settlement stopped',
    onDone: () => {
      setAsking(false);
      setReason('');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) toggle.mutate();
  };
  // Only the house restarts settlement; the platform can stop it but not undo that.
  const canAct = mayAct && (!halted || isHouse);

  return (
    <>
      {halted ? (
        <Pill tone="stop">
          {tenant?.settlementHaltedBy
            ? `Stopped by ${actorName(tenant.settlementHaltedBy)}`
            : 'Settlement stopped'}
        </Pill>
      ) : held.length ? (
        <Link href="/books">
          <Pill tone="stop">
            Held on {held.map(([rail, n]) => `${railName(rail)} (${n})`).join(', ')}
          </Pill>
        </Link>
      ) : (
        <Pill tone="ok">Settlement running</Pill>
      )}
      {asking ? (
        <form className="confirm" onSubmit={submit}>
          <input
            className="search"
            // biome-ignore lint/a11y/noAutofocus: the form opens because the person asked to type a reason
            autoFocus
            required
            placeholder={halted ? 'Why resume?' : 'Why stop?'}
            aria-label={halted ? 'Reason to resume settlement' : 'Reason to stop settlement'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="submit"
            className={`btn${halted ? '' : ' danger'}`}
            disabled={toggle.isPending || !reason.trim()}
          >
            {halted ? 'Resume' : 'Stop for everyone'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </form>
      ) : (
        canAct && (
          <button type="button" className="btn" onClick={() => setAsking(true)}>
            {halted ? 'Resume settlement…' : 'Stop settlement…'}
          </button>
        )
      )}
    </>
  );
}
