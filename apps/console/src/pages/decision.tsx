import type { HistorySignalProvider } from '@novate/engine';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'wouter';
import { api, isPending, useLive, useTenant } from '../api.ts';
import { checkText, describeDealEvent } from '../describe.tsx';
import { CaseOwner } from '../owner.tsx';
import { useSession } from '../session.tsx';
import type { CaseRow, Check, DealDetail, Fact, Recheck, Trail } from '../types.ts';
import {
  Actor,
  actionLabel,
  caseKind,
  clock,
  DECIDER_NAME,
  deciderActor,
  formatMajor,
  LoadFailed,
  Loading,
  Money,
  moneyText,
  PageHead,
  Panel,
  Pill,
  parseMinor,
  Ref,
  sentence,
  sentences,
  shortId,
  toast,
  toMajor,
} from '../ui.tsx';
import { byFact, FactCard, replacedFacts } from './deal.tsx';
import { VERDICTS } from './decisions.tsx';

/** What a person may choose on each kind of case: a subset of `allowedActions` in the policy package. */
const ALLOWED: Record<string, string[]> = {
  frozen: ['confirm', 'cancel'],
  held: ['waive', 'request_evidence', 'release_full', 'release_partial', 'refund', 'draw_margin'],
  exception: ['refund'],
  margin_review: ['resize_margin', 'margin_call', 'no_action'],
  margin_breach: ['extend_call', 'declare_default'],
  agent_review: ['suspend_agent', 'reinstate_agent', 'no_action'],
  settlement_exception: ['retry_settlement', 'exclude_member'],
  recon_break: ['halt_settlement', 'acknowledge'],
  treasury_review: [],
};
const FIELDS: Record<string, string[]> = {
  request_evidence: ['note'],
  release_partial: ['bps'],
  draw_margin: ['amount', 'reason'],
  resize_margin: ['bps'],
  margin_call: ['amount'],
  acknowledge: ['note'],
};
/** What each field asks a person for. Percentages and amounts are converted before sending. */
const FIELD_LABELS: Record<string, string> = {
  note: 'Note to the agent',
  bps: 'Percent, e.g. 80',
  amount: 'Amount',
  reason: 'Reason',
};

export function DecisionPage({ id }: { id: string }) {
  const { tenantId, programByRef, programLabel, canAct } = useSession();
  const trail = useLive<Trail>('trail', `/tenants/${tenantId}/decisions/${id}`);
  const open = useTenant<CaseRow[]>(tenantId, '/cases', { live: true });
  // The ceiling a case was judged against comes from the deal's own program version.
  const dealId = trail.data?.case.dealId;
  const deal = useLive<DealDetail>('deal', dealId ? `/deals/${dealId}` : null);
  const dealProgram = deal.data ? programLabel(deal.data.deal.programId) : undefined;
  if (!trail.data) return trail.error ? <LoadFailed error={trail.error} /> : <Loading />;
  const t = trail.data;
  const openCase = open.data?.find((c) => c.id === id);
  const last = t.steps.at(-1);
  const decided = t.steps.find((s) => s.accepted && s.action.type !== 'escalate');

  return (
    <>
      <PageHead
        crumb={
          <>
            <Link href="/decisions">Decisions</Link> / {shortId('CS', t.case.id)}
          </>
        }
        title={caseKind(t.case.kind)}
        lede={
          <>
            {sentences(t.case.reason)}
            <span className="outcome">
              {decided ? (
                <Pill tone="ok">
                  {DECIDER_NAME[decided.decider] ?? 'Decided'}: {actionLabel(decided.action.type)}
                </Pill>
              ) : t.case.status === 'open' ? (
                <>
                  <Pill tone="wait">Waiting for you</Pill>
                  {openCase && <CaseOwner c={openCase} />}
                </>
              ) : (
                <Pill>{sentence(t.case.status)}</Pill>
              )}
              {BigInt(t.case.amount) > 0n && (
                <Money value={t.case.amount} currency={t.case.currency} />
              )}
            </span>
          </>
        }
        actions={
          t.case.dealId && (
            <Link className="btn" href={`/deals/${t.case.dealId}`}>
              Open deal
            </Link>
          )
        }
      />

      <div className="trail">
        <Panel
          title={
            <>
              <span className="step-no">1</span>{' '}
              {t.steps.some((s) => s.decider === 'model') ? 'What the AI saw' : 'What was shown'}
            </>
          }
        >
          <div className="panel-body">
            <Seen trail={t} />
          </div>
        </Panel>
        <Panel
          title={
            <>
              <span className="step-no">2</span> What was proposed
            </>
          }
        >
          <div className="panel-body">
            {t.steps.length === 0 && <p className="muted">Nothing yet.</p>}
            {t.steps.map((s) => (
              <div
                key={`${s.at}-${s.action.type}`}
                className={`proposal${s.accepted ? '' : ' refused'}`}
              >
                <div className="chosen">
                  <Actor kind={deciderActor(s.decider)} name={DECIDER_NAME[s.decider]} />
                  <span className="action-chip">{actionLabel(s.action.type)}</span>
                  <span className="faint">
                    {clock(s.at)}
                    {s.model && `, ${s.model}`}
                  </span>
                </div>
                <p className="why">{s.rationale}</p>
                {s.promptVersion && (
                  <p className="faint">
                    Instructions {s.promptVersion}
                    {s.promptHash && (
                      <>
                        , <Ref id={s.promptHash} />
                      </>
                    )}
                  </p>
                )}
                {!s.accepted && (
                  <p className="error" style={{ marginTop: 6 }}>
                    Refused by code:{' '}
                    {s.checks
                      .filter((c) => !c.passed)
                      .map(checkText)
                      .join('; ')}
                  </p>
                )}
              </div>
            ))}
            {openCase && canAct && <DecideForm c={openCase} />}
          </div>
        </Panel>
        <Panel
          title={
            <>
              <span className="step-no">3</span> What code checked
            </>
          }
        >
          <div className="panel-body">
            {last ? (
              <>
                <CheckList
                  measures={t.case.kind !== 'recon_break'}
                  ceilingFrom={dealProgram}
                  checks={last.checks}
                />
                <Verdict trail={t} accepted={last.accepted} decidedAction={decided?.action.type} />
                {t.case.kind !== 'recon_break' && (
                  <WhatIf trail={t} programId={deal.data?.deal.programId} />
                )}
              </>
            ) : null}
          </div>
        </Panel>
      </div>

      <Panel title="What happened next" className="after">
        {t.outcome && (
          <p className="panel-body">
            Judged afterwards:{' '}
            <strong>{VERDICTS[t.outcome.verdict]?.[0] ?? t.outcome.verdict}</strong>
          </p>
        )}
        {t.events.length + t.money.length === 0 ? (
          !t.outcome && <p className="panel-body muted">Nothing yet.</p>
        ) : (
          <ol className="timeline">
            {[
              ...t.events.map((e, i) => ({
                key: `e-${i}`,
                at: e.at,
                ...describeDealEvent(
                  e.type,
                  { currency: t.case.currency, ...e.payload },
                  programByRef,
                ),
              })),
              ...t.money.map((m, i) => ({
                key: `m-${i}`,
                at: m.at,
                actor: 'code' as const,
                actorName: undefined,
                text: `${LEDGER[m.kind] ?? sentence(m.kind)}: ${moneyText(m.amount, m.currency)}`,
                detail: undefined,
                tone: 'key' as const,
              })),
            ]
              .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
              .map((d) => (
                <li key={d.key} className={d.tone}>
                  <time dateTime={d.at}>{clock(d.at)}</time>
                  <div>
                    <div className="ev">
                      {d.text}
                      <Actor kind={d.actor} name={d.actorName} />
                    </div>
                    {d.detail && <div className="ev-detail">{d.detail}</div>}
                  </div>
                </li>
              ))}
          </ol>
        )}
      </Panel>
    </>
  );
}

/** Ledger movements as an operator would name them. */
const LEDGER: Record<string, string> = {
  novation: 'Settled through the house',
  escrow_apply: 'Buyer funds applied',
  escrow_refund: 'Unlocked back to the buyer',
  margin_release: 'Seller margin released',
  margin_draw: 'Paid to the buyer from margin',
  payout: 'Paid out',
  payout_reserve: 'Reserved for payout',
  payout_release: 'Payout reservation released',
  payout_returned: 'Payout returned',
  collection: 'Collected',
  deposit: 'Deposit credited',
  card_fee: 'Card fee',
  fx_buy: 'Bought by conversion',
  fx_sell: 'Sold by conversion',
};

// ── What the decider saw ──────────────────────────────────────────────────

interface ShownDeal {
  amount?: string;
  currency?: string;
  terms?: {
    lines?: { quantity: number; description: string; unitPrice: string }[];
    shipmentDate?: string;
  };
  buyer?: string;
  seller?: string;
}

function Seen({ trail }: { trail: Trail }) {
  const { memberName } = useSession();
  const shown = trail.case.shown as {
    deal?: ShownDeal;
    facts?: Fact[];
    evidence?: {
      checks?: { id: string; reason: string }[];
      findings?: { code: string; message?: string; factId?: string }[];
      signals?: { history?: Record<string, Record<string, number>> };
      [k: string]: unknown;
    };
    findings?: { code: string; message?: string }[];
  };
  const deal = shown.deal;
  const line = deal?.terms?.lines?.[0];
  const history = shown.evidence?.signals?.history ?? {};
  const fired = shown.evidence?.checks ?? [];
  const replaced = replacedFacts(shown.facts ?? []);
  const failed = byFact(shown.evidence?.findings ?? []);
  const breaks = (shown.evidence?.breaks ?? []) as {
    kind: string;
    currency: string;
    expected: string;
    actual: string;
    externalRef?: string;
  }[];
  return (
    <>
      {deal?.amount && deal.currency && (
        <div className="seen-section">
          <h3>The deal</h3>
          <dl className="facts">
            {deal.buyer && (
              <>
                <dt>Between</dt>
                <dd>
                  {memberName(deal.buyer)} and {memberName(deal.seller)}
                </dd>
              </>
            )}
            {line && (
              <>
                <dt>Goods</dt>
                <dd>
                  {line.quantity.toLocaleString('en')} {line.description} at{' '}
                  {moneyText(line.unitPrice, deal.currency)}
                </dd>
              </>
            )}
            <dt>Amount</dt>
            <dd>
              <Money value={deal.amount} currency={deal.currency} />
            </dd>
          </dl>
        </div>
      )}
      {breaks.length > 0 && (
        <div className="seen-section">
          <h3>Differences between the ledger and the rail</h3>
          <ul className="rule-list">
            {breaks.map((b) => (
              <li key={`${b.kind}-${b.currency}-${b.externalRef}`}>
                {sentence(b.kind)}: ledger {moneyText(b.expected, b.currency)}, rail{' '}
                {moneyText(b.actual, b.currency)}
                {b.externalRef && <span className="faint"> ({b.externalRef})</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fired.length > 0 && (
        <div className="seen-section">
          <h3>Rules that fired</h3>
          <ul className="rule-list">
            {fired.map((c) => (
              <li key={c.id}>{c.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {Object.keys(history).length > 0 && (
        <div className="seen-section">
          <h3>Track records</h3>
          <dl className="facts">
            {Object.entries(history).map(([who, stats]) => (
              <Stats key={who} who={who} stats={stats} currency={deal?.currency} />
            ))}
          </dl>
        </div>
      )}
      {(shown.facts ?? []).length > 0 && (
        <div className="seen-section">
          <h3>Evidence filed</h3>
          {(shown.facts ?? []).map((f) => (
            <FactCard
              key={f.id}
              fact={f}
              replaced={replaced.has(f.id)}
              findings={failed.get(f.id)}
            />
          ))}
        </div>
      )}
      <div className="seen-section">
        <h3>Integrity</h3>
        <dl className="facts">
          <dt>What it was shown</dt>
          <dd className={trail.integrity.shown.matches ? undefined : 'error'}>
            {trail.integrity.shown.matches ? 'Verified' : 'Changed'}
          </dd>
          <dt>Context</dt>
          <dd className={trail.integrity.context.matches ? undefined : 'error'}>
            {trail.integrity.context.matches ? 'Verified' : 'Changed'}
          </dd>
        </dl>
      </div>
      <details className="raw">
        <summary>Raw record (JSON)</summary>
        <pre>{JSON.stringify(trail.case.shown, null, 2)}</pre>
      </details>
    </>
  );
}

const STAT_NAMES: Record<string, string> = {
  buyer: 'Buyer',
  seller: 'Seller',
  buyerAgent: 'Buyer’s agent',
  sellerAgent: 'Seller’s agent',
};

type HistorySignal = Awaited<ReturnType<HistorySignalProvider['resolve']>>;
type StatKey = { [W in keyof HistorySignal]: keyof HistorySignal[W] }[keyof HistorySignal];

/** Every figure the history signal carries, and how to read it. A new one fails typecheck here. */
const STAT_FORMATS: Record<
  StatKey,
  { label: string; kind: 'count' | 'rate' | 'money' | 'number' }
> = {
  dealCount: { label: 'deals', kind: 'count' },
  completedDeals: { label: 'completed deals', kind: 'count' },
  pricedDeals: { label: 'priced deals', kind: 'count' },
  counterparties: { label: 'counterparties', kind: 'number' },
  defaults: { label: 'defaults', kind: 'number' },
  medianQuantity: { label: 'median quantity', kind: 'number' },
  medianAmount: { label: 'median amount', kind: 'money' },
  medianUnitPrice: { label: 'median unit price', kind: 'money' },
  onTimeRate: { label: 'on time', kind: 'rate' },
  defectRate: { label: 'defects', kind: 'rate' },
};

function Stats({
  who,
  stats,
  currency,
}: {
  who: string;
  stats: Record<string, number>;
  currency: string | undefined;
}) {
  const known = Object.entries(stats).flatMap(([k, v]) => {
    const format = STAT_FORMATS[k as StatKey];
    return format ? [{ ...format, v }] : [];
  });
  const none = known.every((s) => s.kind !== 'count' || s.v === 0);
  const parts = known.map(({ label, kind, v }) =>
    kind === 'rate'
      ? `${label} ${(v * 100).toFixed(0)}%`
      : kind === 'money' && currency
        ? `${label} ${moneyText(BigInt(Math.round(v)), currency)}`
        : `${label} ${v.toLocaleString('en')}`,
  );
  return (
    <>
      <dt>{STAT_NAMES[who] ?? sentence(who)}</dt>
      <dd>{none ? <span className="faint">No history yet</span> : parts.join(', ')}</dd>
    </>
  );
}

// ── What code checked ─────────────────────────────────────────────────────

function CheckList({
  measures = true,
  ceilingFrom,
  checks,
}: {
  measures?: boolean;
  ceilingFrom?: string;
  checks: Check[];
}) {
  if (!checks.length) return <p className="muted">Nothing was checked</p>;
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li
          key={`${c.code}:${JSON.stringify(c.params ?? {})}`}
          className={c.passed ? undefined : 'fail'}
        >
          <span className="mark" role="img" aria-label={c.passed ? 'passed' : 'failed'}>
            {c.passed ? '✓' : '✕'}
          </span>
          <span>
            {checkText(c)}
            {measures && c.measure && <Gauge measure={c.measure} from={ceilingFrom} />}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Gauge({ measure, from }: { measure: NonNullable<Check['measure']>; from?: string }) {
  const { amount, limit, currency } = measure;
  if (limit === null)
    return (
      <span className="why">No ceiling is set for {currency}, so only a person may decide.</span>
    );
  const share = Math.min(
    100,
    (toMajor(amount, currency) / Math.max(toMajor(limit, currency), 0.01)) * 100,
  );
  const over = BigInt(amount) > BigInt(limit);
  return (
    <div className={`gauge${over ? ' over' : ''}`}>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${share}%` }} />
      </div>
      <div className="gauge-scale">
        <span>
          {formatMajor(amount, currency)} {currency} at stake
        </span>
        <span>
          {formatMajor(limit, currency)} {currency} ceiling{from ? ` (${from})` : ''}
        </span>
      </div>
    </div>
  );
}

function Verdict({
  trail,
  accepted,
  decidedAction,
}: {
  trail: Trail;
  accepted: boolean;
  decidedAction?: string;
}) {
  const moved = trail.money.length > 0;
  if (!accepted) {
    return (
      <div className="verdict stop">
        <span>✕</span>
        <span>
          Refused by code
          <small>
            {trail.case.status === 'open' ? 'Sent to a person to decide.' : 'Nothing was applied.'}
          </small>
        </span>
      </div>
    );
  }
  return (
    <div className="verdict ok">
      <span>✓</span>
      <span>
        Accepted by code{decidedAction ? `: ${actionLabel(decidedAction).toLowerCase()}` : ''}
        <small>{moved ? 'Money moved later in this deal, below.' : 'No money moved.'}</small>
      </span>
    </div>
  );
}

/** Run the same gate again under a tighter ceiling. Nothing is applied: it only shows the answer. */
function WhatIf({ trail, programId }: { trail: Trail; programId?: string }) {
  const { tenantId, programs, canAct } = useSession();
  const currency = trail.case.currency;
  const amount = BigInt(trail.case.amount);
  // Start from today's ceiling for this program, the question an owner asks after changing it.
  const key = programs.find((p) => p.id === programId)?.key;
  const current = programs.filter((p) => p.key === key).sort((a, b) => b.version - a.version)[0]
    ?.spec.decisions.ceiling[currency];
  const [ceiling, setCeiling] = useState(() =>
    formatMajor(current !== undefined ? BigInt(current) : amount / 2n || 1n, currency),
  );
  const recheck = useMutation({
    mutationFn: (minor: bigint) =>
      api<Recheck>(`/tenants/${tenantId}/decisions/${trail.case.id}/recheck`, {
        // Program ceilings are plain numbers of minor units, as in the program spec.
        body: { ceiling: { [currency]: Number(minor) } },
      }),
  });
  if (amount <= 0n || !canAct) return null;
  const minor = parseMinor(ceiling, currency);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (minor !== null && minor > 0n) recheck.mutate(minor);
  };
  return (
    <div className="whatif">
      <h3>What if the ceiling were lower?</h3>
      <form onSubmit={submit}>
        <label className="field">
          Ceiling in {currency}
          <input inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} />
        </label>
        <button type="submit" className="btn" disabled={recheck.isPending || !minor}>
          Re-check
        </button>
      </form>
      {minor === null && ceiling.trim() && <p className="error">Not an amount in {currency}</p>}
      {recheck.error && <p className="error">{recheck.error.message}</p>}
      {recheck.data && (
        <div
          className="whatif-result"
          ref={(node) => node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}
        >
          {/* Only what the lower ceiling changes: the rest already passed above. */}
          <CheckList ceilingFrom="what-if" checks={recheck.data.checks.filter((c) => !c.passed)} />
          <div className={`verdict ${recheck.data.accepted ? 'ok' : 'stop'}`}>
            <span>{recheck.data.accepted ? '✓' : '✕'}</span>
            <span>
              {recheck.data.accepted ? 'Code would still accept it' : 'Code would refuse it'}
              <small>
                {recheck.data.accepted
                  ? 'Inside that ceiling too.'
                  : `At ${moneyText(recheck.variables, currency)}, ${DECIDER_NAME[recheck.data.decider.type] ?? 'it'} could not have decided this. It would have gone to a person.`}
              </small>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── A person deciding ─────────────────────────────────────────────────────

function DecideForm({ c }: { c: CaseRow }) {
  const queries = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [rationale, setRationale] = useState('');
  const decide = useMutation({
    mutationFn: (type: string) => {
      const action: Record<string, unknown> = { type };
      for (const f of FIELDS[type] ?? []) {
        const value = values[`${type}.${f}`] ?? '';
        action[f] =
          f === 'bps'
            ? Math.round(Number(value) * 100)
            : f === 'amount'
              ? String(parseMinor(value, c.context.currency) ?? '')
              : value;
      }
      const subject = c.context as { subject?: { id: string }; memberIds?: string[] };
      if (type === 'suspend_agent' || type === 'reinstate_agent')
        action.agentId = subject.subject?.id;
      if (type === 'exclude_member') action.memberId = subject.memberIds?.[0];
      return api(`/cases/${c.id}/decision`, {
        body: { bindingHash: c.bindingHash, action, rationale: rationale.trim() },
      });
    },
    onSuccess: (r, type) => {
      toast(isPending(r) ? 'Sent for approval' : `Decided: ${actionLabel(type)}`);
      queries.invalidateQueries();
    },
    onError: (err) => toast(err.message),
  });
  // A claim is granted with the claimant's own remedy: a refund for the buyer, the rest for a seller.
  const claimant = (c.context as { claimant?: string }).claimant;
  const actions =
    c.kind === 'exception' && claimant === 'seller' ? ['release_full'] : (ALLOWED[c.kind] ?? []);
  return (
    <div className="whatif">
      <h3>Your decision</h3>
      <label className="field">
        Why
        <textarea
          rows={2}
          required
          maxLength={2000}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </label>
      <div className="decide">
        {actions.map((type) => (
          <span key={type} className="decide">
            {(FIELDS[type] ?? []).map((f) => (
              <input
                key={f}
                className="field"
                placeholder={f === 'amount' ? `Amount (${c.context.currency})` : FIELD_LABELS[f]}
                aria-label={`${actionLabel(type)}: ${FIELD_LABELS[f] ?? f}`}
                value={values[`${type}.${f}`] ?? ''}
                onChange={(e) => setValues({ ...values, [`${type}.${f}`]: e.target.value })}
              />
            ))}
            <button
              type="button"
              className="btn"
              disabled={decide.isPending || !rationale.trim()}
              title={rationale.trim() ? undefined : 'Say why first'}
              onClick={() => decide.mutate(type)}
            >
              {actionLabel(type)}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
