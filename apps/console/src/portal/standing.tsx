// Where the member stands with the house: its status, open margin calls and anything stopping its
// money, shown on every page that moves money.
import type { Me } from '../types.ts';
import { dateTime, Money, Pill, railName } from '../ui.tsx';
import { useMyAccount } from './my.ts';

const STATUS: Record<string, string> = { close_only: 'Close only', suspended: 'Suspended' };

/** Each reason this member's money is held, as its own pill. Every reason withdrawals are held has one. */
export function Holds({ me }: { me: Me }) {
  const account = useMyAccount(me);
  const a = account.data;
  if (!a) return null;
  const h = a.holds;
  const pills = [
    STATUS[a.status] && (
      <Pill key="status" tone="stop">
        {STATUS[a.status]}
      </Pill>
    ),
    h.settlement && (
      <Pill key="s" tone="stop">
        Settlement stopped since {dateTime(h.settlement.since)}
      </Pill>
    ),
    ...h.rails.map((r) => (
      <Pill key={r.rail} tone="stop">
        {railName(r.rail)} held since {dateTime(r.since)}
      </Pill>
    )),
    ...a.marginCalls.map((c) => (
      <Pill key={c.id} tone="stop">
        Margin call <Money value={c.amount} currency={c.currency} /> due {dateTime(c.dueAt)}
      </Pill>
    )),
  ].filter(Boolean);
  return pills.length ? <span className="outcome">{pills}</span> : null;
}
