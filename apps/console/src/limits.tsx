// An agent's money limits, one pair per currency. A limit has a currency: 10,000 EUR a deal says
// nothing about USD, so each currency the agent may use has its own entry, and a currency with no
// entry may not be traded.
import { useId } from 'react';
import type { Agent } from './types.ts';
import { formatMajor, Pill, parseMinor, sumBig } from './ui.tsx';

export type LimitDraft = Record<string, { perDeal: string; monthly: string }>;
type MandateLimits = Agent['mandate']['limits'];

const major = (v: string | undefined, currency: string) =>
  v === undefined ? '' : formatMajor(v, currency).replaceAll(',', '');

/** The currencies an agent may deal in. */
export const currenciesOf = (m: Agent['mandate']) => Object.keys(m.limits);

export function draftOf(m: Agent['mandate']): LimitDraft {
  return Object.fromEntries(
    Object.entries(m.limits).map(([c, l]) => [
      c,
      { perDeal: major(l.maxPerDeal, c), monthly: major(l.monthlyLimit, c) },
    ]),
  );
}

/** A currency where the agent can commit any amount. */
export const unlimited = (l: MandateLimits[string]) => !l.maxPerDeal && !l.monthlyLimit;

/**
 * Major-unit drafts to the mandate's minor-unit limits. Empty fields mean no limit of that kind;
 * anything that is not an amount in its currency is refused rather than rounded.
 */
export function toLimits(draft: LimitDraft, currencies: string[]): MandateLimits {
  const minor = (text: string, c: string) => {
    const v = parseMinor(text, c);
    if (v === null) throw new Error(`${text} is not an amount in ${c}`);
    return String(v);
  };
  return Object.fromEntries(
    currencies.map((c) => {
      const d = draft[c] ?? { perDeal: '', monthly: '' };
      return [
        c,
        {
          ...(d.perDeal.trim() ? { maxPerDeal: minor(d.perDeal, c) } : {}),
          ...(d.monthly.trim() ? { monthlyLimit: minor(d.monthly, c) } : {}),
        },
      ];
    }),
  );
}

/** A currency with neither limit set: an agent there can commit any amount. */
export const unlimitedIn = (draft: LimitDraft, currencies: string[]) =>
  currencies.filter((c) => !draft[c]?.perDeal.trim() && !draft[c]?.monthly.trim());

export function LimitsEditor({
  currencies,
  draft,
  onChange,
}: {
  currencies: string[];
  draft: LimitDraft;
  onChange: (d: LimitDraft) => void;
}) {
  const id = useId();
  const set = (c: string, k: 'perDeal' | 'monthly', v: string) =>
    onChange({ ...draft, [c]: { ...(draft[c] ?? { perDeal: '', monthly: '' }), [k]: v } });
  if (!currencies.length) return null;
  return (
    <span className="limits-edit">
      <span className="limit-row faint">
        <span />
        <span id={`${id}-perDeal`}>Per deal</span>
        <span id={`${id}-monthly`}>A month</span>
      </span>
      {currencies.map((c) => (
        <span key={c} className="limit-row">
          <span className="mono" id={`${id}-${c}`}>
            {c}
          </span>
          {(['perDeal', 'monthly'] as const).map((k) => (
            <input
              key={k}
              className="search"
              inputMode="decimal"
              aria-labelledby={`${id}-${k} ${id}-${c}`}
              value={draft[c]?.[k] ?? ''}
              onChange={(e) => set(c, k, e.target.value)}
            />
          ))}
        </span>
      ))}
    </span>
  );
}

/** Limits next to what was used this month, per currency and side. */
export function LimitsView({ agent }: { agent: Agent }) {
  const m = agent.mandate;
  const used = (side: string, c: string) =>
    sumBig(agent.usage.amounts.filter((a) => a.side === side && a.currency === c));
  if (Object.values(m.limits).every(unlimited)) {
    return (
      <>
        <Pill tone="stop">No money limit</Pill>
        {agent.usage.amounts.map((u) => (
          <span key={`${u.side}-${u.currency}`} className="sub-line">
            {formatMajor(u.amount, u.currency, true)} {u.currency}{' '}
            {u.side === 'buy' ? 'bought' : 'sold'} this month
          </span>
        ))}
      </>
    );
  }
  return (
    <>
      {Object.entries(m.limits).map(([c, l]) => (
        <span key={c} className="sub-line">
          <strong className="mono">{c}</strong>{' '}
          {l.maxPerDeal ? `${formatMajor(l.maxPerDeal, c, true)} a deal` : 'any amount a deal'}
          {m.roles.map((role) => {
            const u = used(role, c);
            const cap = l.monthlyLimit ? BigInt(l.monthlyLimit) : null;
            if (!cap && u === 0n) return null;
            return (
              <span key={role} className={cap && u > cap ? 'error' : undefined}>
                ; {formatMajor(u, c, true)}
                {cap ? ` of ${formatMajor(cap, c, true)}` : ''} {role === 'buy' ? 'bought' : 'sold'}{' '}
                this month
              </span>
            );
          })}
        </span>
      ))}
    </>
  );
}
