import { useState } from 'react';
import { api, type Page, useAction, useTenant } from '../api.ts';
import { useSession } from '../session.tsx';
import { dayKey, dayStart, zoneName } from '../time.ts';
import type { ControlEvent } from '../types.ts';
import { actorName, clock, dateTime, EmptyRow, Kpi, LoadFailed, Panel } from '../ui.tsx';

/** The end-of-day sign-off: refused until every rail was checked today. */
export function SignOff({ open }: { open: number }) {
  const { tenantId } = useSession();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const [supersede, setSupersede] = useState(false);
  const sign = useAction(tenantId, {
    run: () =>
      api<{ openBreaks: number }>(`/tenants/${tenantId}/books/sign-off`, {
        body: {
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(supersede ? { supersede: true, reason: note.trim() } : {}),
        },
      }),
    done: (r) =>
      r.openBreaks
        ? `Signed off with ${r.openBreaks} differences open`
        : "Today's books signed off",
    onDone: () => {
      setAsking(false);
      setNote('');
    },
    // Already signed today: offer to sign again, which records what it replaces and why.
    onError: (err) => {
      if (err.message.toLowerCase().includes('already')) setSupersede(true);
    },
  });
  if (!asking)
    return (
      <button type="button" className="btn primary" onClick={() => setAsking(true)}>
        Sign off today…
      </button>
    );
  return (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        sign.mutate();
      }}
    >
      <input
        className="search"
        required={open > 0 || supersede}
        placeholder={
          supersede
            ? 'Why sign today again?'
            : open
              ? `Note on the ${open} open differences`
              : 'Note (optional)'
        }
        aria-label="Sign-off note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="submit"
        className="btn primary"
        disabled={sign.isPending || ((open > 0 || supersede) && !note.trim())}
      >
        {supersede ? 'Sign off again' : 'Sign off'}
      </button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </form>
  );
}

/** The sign-offs of the last 60 days at most, newest first. */
function useSignOffs() {
  const { tenantId } = useSession();
  return useTenant<Page<ControlEvent>>(tenantId, '/control-events?type=books_signed_off&limit=60', {
    live: true,
  });
}

const DAYS = 14;

/** The tenant's business days, newest first: the last two weeks, or since the tenant began. */
function businessDays(since: string | undefined) {
  const [y, m, d] = dayKey(new Date()).split('-').map(Number) as [number, number, number];
  const first = since ? dayKey(since) : null;
  const days: string[] = [];
  for (let i = 0; i < DAYS; i++) {
    const day = dayKey(dayStart(y, m, d - i));
    days.push(day);
    if (day === first) break;
  }
  return days;
}

/** Whether today's books are signed off, by whom and when. */
export function TodaySignOff() {
  const events = useSignOffs();
  const today = dayKey(new Date());
  const latest = events.data?.rows.find((e) => e.payload.date === today);
  return (
    <Kpi
      label={`Today (${zoneName()})`}
      tone={events.data && !latest ? 'alert' : ''}
      figure={events.data ? (latest ? 'Signed' : 'Not signed') : '—'}
      note={latest ? `By ${actorName(latest.actor)} at ${clock(latest.createdAt)}` : undefined}
    />
  );
}

/** End-of-day sign-offs, day by day: who signed, when, and what was still open; or that nobody did. */
export function SignOffs() {
  const { tenant } = useSession();
  const events = useSignOffs();
  const signed = events.data?.rows ?? [];
  const days = businessDays(tenant?.createdAt);
  return (
    <Panel title="Sign-offs" sub={zoneName()}>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Signed by</th>
            <th>When</th>
            <th className="num">Open differences</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {events.error && !events.data && (
            <EmptyRow cols={5}>
              <LoadFailed error={events.error} />
            </EmptyRow>
          )}
          {events.data &&
            days.flatMap((day) => {
              const that = signed.filter((e) => e.payload.date === day);
              if (!that.length) {
                return [
                  <tr key={day}>
                    <td className="nowrap">{day}</td>
                    <td className="error">Not signed</td>
                    <td className="muted">—</td>
                    <td className="num muted">—</td>
                    <td className="muted">—</td>
                  </tr>,
                ];
              }
              return that.map((e, i) => (
                <tr key={e.id}>
                  <td className="nowrap">
                    {day}
                    {i > 0 && <small className="sub-line faint">Replaced</small>}
                  </td>
                  <td>{actorName(e.actor)}</td>
                  <td className="muted nowrap">{dateTime(e.createdAt)}</td>
                  <td className={`num${e.payload.openBreaks ? ' error' : ''}`}>
                    {Number(e.payload.openBreaks ?? 0)}
                  </td>
                  <td className="muted">{e.reason ?? '—'}</td>
                </tr>
              ));
            })}
        </tbody>
      </table>
    </Panel>
  );
}
