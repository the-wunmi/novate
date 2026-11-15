// Building blocks every page uses: money, time, statuses, who did what, panels.
import type { ControlActor } from '@novate/core';
import type { ReactNode } from 'react';
import { dayKey, timeZone } from './time.ts';
import type { Amount, Deal, Minor } from './types.ts';

// ── Money ─────────────────────────────────────────────────────────────────

const digitsCache = new Map<string, number>();
export function digits(currency: string) {
  let d = digitsCache.get(currency);
  if (d === undefined) {
    d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits as number;
    digitsCache.set(currency, d);
  }
  return d;
}

export const toMajor = (minor: Minor | bigint, currency: string) =>
  Number(BigInt(minor)) / 10 ** digits(currency);

/**
 * A typed amount to minor units without floating point: "50,000.5" EUR is 5000050n. Thousands
 * separators are allowed; anything else that is not a plain decimal, or has more decimals than the
 * currency, gives null so the form can refuse it rather than guess.
 */
export function parseMinor(text: string, currency: string): bigint | null {
  const clean = text.trim().replaceAll(',', '').replaceAll(' ', '');
  const d = digits(currency);
  const match = clean.match(/^(\d+)(?:\.(\d*))?$/);
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > d) return null;
  return BigInt(match[1] as string) * 10n ** BigInt(d) + BigInt(fraction.padEnd(d, '0') || '0');
}

export function formatMajor(minor: Minor | bigint, currency: string, whole = false) {
  const d = whole ? 0 : digits(currency);
  return new Intl.NumberFormat('en', { minimumFractionDigits: d, maximumFractionDigits: d }).format(
    Math.abs(toMajor(minor, currency)),
  );
}

/** "12,880.00 EUR", the code muted, so decimals line up down a column. Negatives in brackets. */
export function Money({
  value,
  currency,
  whole,
}: {
  value: Minor | bigint;
  currency: string;
  whole?: boolean;
}) {
  const text = formatMajor(value, currency, whole);
  return (
    <span className="amt">
      {BigInt(value) < 0n ? `(${text})` : text}
      <span className="cur">{currency}</span>
    </span>
  );
}

/** For sentences, in the same form as tables: "12,880.00 EUR". */
export const moneyText = (minor: Minor | bigint, currency: string) =>
  BigInt(minor) < 0n
    ? `(${formatMajor(minor, currency)}) ${currency}`
    : `${formatMajor(minor, currency)} ${currency}`;

export const sumBig = (rows: { amount: Minor }[]) =>
  rows.reduce((t, r) => t + BigInt(r.amount), 0n);

export function byCurrency(rows: Amount[]): { currency: string; amount: bigint }[] {
  const totals = new Map<string, bigint>();
  for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0n) + BigInt(r.amount));
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

/** Amounts in several currencies. `zeros` keeps a currency at nil, so none silently drops out. */
export function Amounts({
  list,
  empty = 'None',
  zeros = false,
}: {
  list: { currency: string; amount: Minor | bigint }[];
  empty?: string;
  zeros?: boolean;
}) {
  const shown = zeros ? list : list.filter((a) => BigInt(a.amount) !== 0n);
  if (!shown.length) return <span className="faint">{empty}</span>;
  return (
    <span>
      {shown.map((a, i) => (
        <span key={a.currency}>
          {i > 0 && <span className="faint">, </span>}
          <Money value={a.amount} currency={a.currency} />
        </span>
      ))}
    </span>
  );
}

// ── Time ──────────────────────────────────────────────────────────────────

export function ago(when: string | Date) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(when).getTime()) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  return shortDate(when);
}

/** "13 Nov", in the tenant's zone. */
export const shortDate = (when: string | Date) =>
  new Date(when).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: timeZone(),
  });

/** "13 Nov 2026", in the tenant's zone. */
export const longDate = (when: string | Date) =>
  new Date(when).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: timeZone(),
  });

/** A span of time, coarsely: "12 min", "5 h", "3 days". */
export const duration = (seconds: number) =>
  seconds < 3_600
    ? `${Math.max(1, Math.round(seconds / 60))} min`
    : seconds < 172_800
      ? `${Math.round(seconds / 3_600)} h`
      : `${Math.round(seconds / 86_400)} days`;

/** How long since something started waiting: "12 min". */
export const waiting = (since: string | Date) =>
  duration(Math.max(0, (Date.now() - new Date(since).getTime()) / 1000));

/** A deadline: "Due in 3 h", or "Overdue by 20 min" once passed. */
export function until(when: string | Date) {
  const seconds = Math.round((new Date(when).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return { text: `Overdue by ${waiting(when)}`, overdue: true };
  const minutes = Math.round(seconds / 60);
  const text =
    minutes < 60
      ? `Due in ${Math.max(1, minutes)} min`
      : minutes < 60 * 24
        ? `Due in ${Math.round(minutes / 60)} h`
        : `Due ${dateTime(when)}`;
  return { text, overdue: false };
}

export const clock = (when: string | Date) =>
  new Date(when).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: timeZone(),
  });

export const dateTime = (when: string | Date) =>
  new Date(when).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZone(),
  });

/** Date and time to the second, for a title on hover. */
export const fullDateTime = (when: string | Date) =>
  new Date(when).toLocaleString('en-GB', { timeZone: timeZone() });

// ── Words ─────────────────────────────────────────────────────────────────

/** A short, stable reference a person can read out: DL-7F3A. */
export const shortId = (prefix: string, id: string) =>
  `${prefix}-${id.replaceAll('-', '').slice(0, 4).toUpperCase()}`;

export const words = (text: unknown) => String(text ?? '').replaceAll('_', ' ');
export const sentence = (text: unknown) => {
  const t = words(text);
  return t.charAt(0).toUpperCase() + t.slice(1);
};
/** Reasons from models and rules arrive joined by semicolons. */
export const sentences = (text: unknown) =>
  String(text ?? '')
    .replaceAll('.; ', '. ')
    .replaceAll('; ', '. ');

// ── Statuses ──────────────────────────────────────────────────────────────

export type Tone = '' | 'ok' | 'wait' | 'stop' | 'moved';

export function Pill({ tone = '', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

const DEAL_STATUS: Record<string, [string, Tone]> = {
  submitted: ['Waiting for the other side', ''],
  authorised: ['Authorised', ''],
  frozen: ['Frozen for review', 'wait'],
  awaiting_funding: ['Waiting for funds', 'wait'],
  awaiting_conditions: ['Waiting for delivery', ''],
  held: ['Held for review', 'wait'],
  eligible: ['Cleared to settle', 'moved'],
  settling: ['Settling', 'moved'],
  settled: ['Settled', 'ok'],
  cancelled: ['Cancelled', 'stop'],
  refunded: ['Refunded', 'stop'],
  rejected: ['Rejected', 'stop'],
  exception: ['Needs attention', 'stop'],
};

export function DealStatus({ deal }: { deal: Pick<Deal, 'status' | 'statusReason'> }) {
  const [label, tone] = DEAL_STATUS[deal.status] ?? [sentence(deal.status), ''];
  const text =
    deal.status === 'cancelled' && deal.statusReason
      ? sentence(deal.statusReason.replace('by model', 'by AI'))
      : label;
  return <Pill tone={tone}>{text}</Pill>;
}

/** Where a payment to or from a member stands. */
export const PAYOUT_STATUS: Record<string, [string, Tone]> = {
  pending: ['Sending', 'wait'],
  submitted: ['Sent', 'moved'],
  in_doubt: ['No answer', 'wait'],
  confirmed: ['Paid', 'ok'],
  failed: ['Failed', 'stop'],
  reversed: ['Returned', 'stop'],
};

export function PayoutStatus({
  status,
  labels = PAYOUT_STATUS,
}: {
  status: string;
  labels?: Record<string, [string, Tone]>;
}) {
  const [label, tone] = labels[status] ?? [sentence(status), ''];
  return <Pill tone={tone}>{label}</Pill>;
}

// ── Who did it ────────────────────────────────────────────────────────────

export type ActorKind = 'claude' | 'person' | 'agent' | 'key' | 'rules' | 'code' | 'rail';
const ACTOR_LABEL: Record<ActorKind, string> = {
  claude: 'AI',
  person: 'Person',
  agent: 'Agent',
  key: 'Key',
  rules: 'Rules',
  code: 'System',
  rail: 'Rail',
};

/**
 * Who took a recorded action, by what they are: a signed-in person by name, a trading agent by its
 * name, any other key as a key, novate acting on its own as novate.
 */
export function actorOf(a: ControlActor): { kind: ActorKind; name: string } {
  if (a.via === 'system' || a.kind === 'system') return { kind: 'code', name: 'novate' };
  if (a.via === 'session') return { kind: 'person', name: a.name ?? a.operator ?? 'Someone' };
  if (a.kind === 'operator') {
    return { kind: 'key', name: a.operator ? `Operator (${a.operator})` : 'Operator' };
  }
  if (a.kind === 'agent') return { kind: 'agent', name: a.name ?? 'Agent' };
  const key = `${sentence(a.kind)} key${a.name && a.name !== a.kind ? ` "${a.name}"` : ''}`;
  return { kind: 'key', name: a.operator ? `${key} (${a.operator})` : key };
}

/** Who took a recorded action, as a name in a sentence. */
export const actorName = (a: ControlActor) => actorOf(a).name;

export function Actor({ kind, name }: { kind: ActorKind; name?: string }) {
  return (
    <span className={`actor ${kind}`}>
      <i />
      {name ?? ACTOR_LABEL[kind]}
    </span>
  );
}

export const deciderActor = (type: string): ActorKind =>
  type === 'model' ? 'claude' : type === 'person' ? 'person' : type === 'rule' ? 'rules' : 'code';

export const DECIDER_NAME: Record<string, string> = {
  model: 'AI',
  person: 'A person',
  rule: 'A rule',
  system: 'Code',
};

const RAIL_NAMES: Record<string, string> = {
  airwallex: 'Airwallex',
  metal: 'Metal',
  mock: 'Simulated rail',
};
export const railName = (rail: string) => RAIL_NAMES[rail] ?? sentence(rail);

export const ACTION_LABELS: Record<string, string> = {
  confirm: 'Confirm the deal',
  cancel: 'Cancel the deal',
  reprice: 'Reprice',
  waive: 'Waive the findings',
  request_evidence: 'Ask for corrected evidence',
  release_full: 'Release in full',
  release_partial: 'Release part',
  refund: 'Refund the buyer',
  draw_margin: 'Pay buyer from margin',
  resize_margin: 'Resize margin',
  margin_call: 'Call for margin',
  extend_call: 'Extend the margin call',
  declare_default: 'Declare a default',
  suspend_agent: 'Suspend the agent',
  reinstate_agent: 'Reinstate the agent',
  no_action: 'Take no action',
  retry_settlement: 'Retry settlement',
  exclude_member: 'Exclude the member',
  choose_plan: 'Choose a plan',
  halt_settlement: 'Stop settlement',
  acknowledge: 'Acknowledge',
  escalate: 'Send to a person',
};
export const actionLabel = (type: string) => ACTION_LABELS[type] ?? sentence(type);

export const CASE_KINDS: Record<string, string> = {
  frozen: 'Frozen deal',
  held: 'Held evidence',
  exception: 'Deal exception',
  margin_review: 'Margin review',
  margin_breach: 'Margin call overdue',
  agent_review: 'Agent review',
  settlement_exception: 'Settlement exception',
  recon_break: 'Books differ',
  treasury_review: 'Treasury plan',
};
export const caseKind = (k: string) => CASE_KINDS[k] ?? sentence(k);

// ── Layout ────────────────────────────────────────────────────────────────

export function PageHead({
  title,
  lede,
  crumb,
  actions,
}: {
  title: ReactNode;
  lede?: ReactNode;
  crumb?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        {crumb && <div className="crumb">{crumb}</div>}
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Panel({
  title,
  sub,
  aside,
  children,
  foot,
  className = '',
}: {
  title?: ReactNode;
  sub?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-head">
          <h2>
            {title}
            {sub && <span className="sub"> {sub}</span>}
          </h2>
          {aside}
        </div>
      )}
      {children}
      {foot && <div className="panel-foot">{foot}</div>}
    </section>
  );
}

export function Kpi({
  label,
  figure,
  note,
  tone = '',
}: {
  label: string;
  figure: ReactNode;
  note?: ReactNode;
  tone?: '' | 'alert' | 'good' | 'moved';
}) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="label">{label}</div>
      <div className="figure">{figure}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function EmptyRow({ cols, children }: { cols: number; children: ReactNode }) {
  return (
    <tr className="empty-row">
      <td colSpan={cols}>{children}</td>
    </tr>
  );
}

export function Loading() {
  return <p className="muted">Loading…</p>;
}

/** A short note at the bottom of the screen, for the result of something the person did. */
export function toast(text: string) {
  let node = document.getElementById('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    node.setAttribute('role', 'status');
    document.body.append(node);
  }
  node.textContent = text;
  node.hidden = false;
  window.clearTimeout(Number(node.dataset.timer));
  node.dataset.timer = String(
    window.setTimeout(() => {
      (node as HTMLElement).hidden = true;
    }, 3200),
  );
}

/** A read that failed says so, in place of the data it would have shown. Never an empty "all clear". */
export function LoadFailed({ error }: { error: unknown }) {
  return (
    <p className="panel-body error" role="alert">
      Couldn't load this. {error instanceof Error ? error.message : ''}
    </p>
  );
}

/** A day heading for long lists: "Today", "Yesterday" or "13 Nov". */
export function dayLabel(when: string | Date) {
  const days = Math.round((Date.parse(dayKey(new Date())) - Date.parse(dayKey(when))) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return shortDate(when);
}

/** Copies a reference an operator will paste into the bank's portal. */
export function Copy({ text }: { text: string }) {
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${text}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(text);
        toast('Copied');
      }}
    >
      Copy
    </button>
  );
}

/** A long reference shortened, with the whole of it copyable. */
export function Ref({ id }: { id: string }) {
  return (
    <span className="refline">
      <span className="mono" title={id}>
        {id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id}
      </span>
      <Copy text={id} />
    </span>
  );
}
