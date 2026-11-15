import { Link } from 'wouter';
import { useLive } from '../api.ts';
import { dealSummary, describeDealEvent } from '../describe.tsx';
import { useSession } from '../session.tsx';
import type { DealDetail, Fact } from '../types.ts';
import {
  Actor,
  actionLabel,
  caseKind,
  clock,
  DECIDER_NAME,
  DealStatus,
  dateTime,
  dayLabel,
  deciderActor,
  LoadFailed,
  Loading,
  Money,
  moneyText,
  PageHead,
  Panel,
  Pill,
  Ref,
  sentence,
  sentences,
  shortId,
  words,
} from '../ui.tsx';

const QUIET = new Set(['locks_planned']);

const WAITING_FOR: Record<NonNullable<DealDetail['waitingFor']>, string> = {
  documents: 'Waiting for proof of delivery',
  acceptance: 'Waiting for the buyer to accept',
  conditions: 'Waiting for the release conditions',
};

export function DealDetailPage({ id }: { id: string }) {
  const { memberName, agentName, programLabel, programByRef } = useSession();
  const detail = useLive<DealDetail>('deal', `/deals/${id}`);
  if (!detail.data) return detail.error ? <LoadFailed error={detail.error} /> : <Loading />;
  const { deal, facts, obligations, events, cases } = detail.data;
  const returned =
    deal.releaseAmount && BigInt(deal.releaseAmount) < BigInt(deal.amount)
      ? BigInt(deal.amount) - BigInt(deal.releaseAmount)
      : 0n;
  // Late shipment, measured against the bill of lading in force and the program's tolerance.
  const lading = [...facts].reverse().find((f) => f.type === 'bill_of_lading');
  const shipped = (lading?.data.fields as { shipmentDate?: string } | undefined)?.shipmentDate;
  const lateBy =
    shipped && deal.terms.shipmentDate
      ? Math.round(
          (new Date(shipped).getTime() - new Date(deal.terms.shipmentDate).getTime()) / 86_400_000,
        )
      : null;
  const tolerance = detail.data.shipmentTolerance;
  const waitingFor = WAITING_FOR[detail.data.waitingFor ?? 'conditions'];
  const replaced = replacedFacts(facts);
  const failed = heldFindings(events);
  const line = deal.terms.lines?.[0];
  const steps = [
    ...events
      .filter(
        (e) =>
          !QUIET.has(e.type) &&
          // "Held" says the evidence failed; the check before it says the same thing.
          !(e.type === 'conditions_evaluated' && e.payload.state !== 'passed'),
      )
      .map((e, i) => ({
        key: e.id ?? `${e.type}-${i}`,
        at: e.createdAt,
        ...describeDealEvent(e.type, { currency: deal.currency, ...e.payload }, programByRef),
        ...(e.type === 'awaiting_conditions' ? { text: waitingFor } : {}),
        ...agentOf(e.payload),
        ...moneyNote(e.type, e.payload),
      })),
    // A decision is not a deal event, but it is what moved the deal on, so it belongs in the story.
    ...cases
      .filter((c) => c.resolution && c.closedAt)
      .map((c) => {
        const r = c.resolution as NonNullable<typeof c.resolution>;
        return {
          key: `case-${c.id}`,
          at: c.closedAt as string,
          actor: deciderActor(r.decider.type),
          actorName: DECIDER_NAME[r.decider.type],
          text: (
            <Link href={`/decisions/${c.id}`}>
              {DECIDER_NAME[r.decider.type] ?? 'A decider'} decided:{' '}
              {actionLabel(r.action.type).toLowerCase()}
            </Link>
          ),
          detail: undefined,
          tone: 'key' as const,
        };
      }),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  /** What the generic event line cannot know: what came back. */
  function moneyNote(type: string, p: Record<string, unknown>) {
    if (type === 'settled') {
      const parts = [
        p.marginReturned && BigInt(String(p.marginReturned)) > 0n
          ? `Seller margin of ${moneyText(String(p.marginReturned), deal.currency)} released`
          : null,
        returned > 0n ? `${moneyText(returned, deal.currency)} returned to the buyer` : null,
      ].filter(Boolean);
      return parts.length ? { detail: parts.join('. ') } : {};
    }
    return {};
  }

  /** Names the agent that filed or submitted something, where the event says which. */
  function agentOf(p: Record<string, unknown>) {
    return typeof p.agentId === 'string' ? { actorName: agentName(p.agentId) } : {};
  }

  return (
    <>
      <PageHead
        crumb={
          <>
            <Link href="/deals">Deals</Link> / {shortId('DL', deal.id)}
          </>
        }
        title={dealSummary(deal, memberName)}
        lede={
          <span className="outcome">
            <DealStatus deal={deal} />
            <span className="muted">Created {dateTime(deal.createdAt)}</span>
          </span>
        }
        actions={
          <div className="headline-amount">
            <span className="muted">{returned ? 'Released' : 'Amount'}</span>
            <strong>
              <Money value={deal.releaseAmount ?? deal.amount} currency={deal.currency} />
            </strong>
            {returned > 0n && (
              <span className="muted">
                of {moneyText(deal.amount, deal.currency)}; {moneyText(returned, deal.currency)}{' '}
                back to the buyer
              </span>
            )}
          </div>
        }
      />
      <div className="cols two">
        <Panel title="What happened">
          <ol className="timeline">
            {steps.map((d, i) => {
              const prev = steps[i - 1];
              const newDay =
                !prev || new Date(prev.at).toDateString() !== new Date(d.at).toDateString();
              return (
                <li key={d.key} className={d.tone}>
                  <time dateTime={d.at}>
                    {newDay && <span className="sub-line">{dayLabel(d.at)}</span>}
                    {clock(d.at)}
                  </time>
                  <div>
                    <div className="ev">
                      {d.text}
                      <Actor kind={d.actor} name={d.actorName} />
                    </div>
                    {d.detail && <div className="ev-detail">{d.detail}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </Panel>
        <div className="stack">
          <Panel title="Terms">
            <div className="panel-body">
              <dl className="facts">
                <dt>Buyer</dt>
                <dd>
                  {memberName(deal.buyerMemberId)}
                  {deal.buyerAgentId && (
                    <span className="faint">, through {agentName(deal.buyerAgentId)}</span>
                  )}
                </dd>
                <dt>Seller</dt>
                <dd>
                  {memberName(deal.sellerMemberId)}
                  {deal.sellerAgentId && (
                    <span className="faint">, through {agentName(deal.sellerAgentId)}</span>
                  )}
                </dd>
                {line && (
                  <>
                    <dt>Goods</dt>
                    <dd>
                      {line.quantity.toLocaleString('en')} {line.description}
                      <span className="faint"> ({line.sku})</span>
                    </dd>
                    <dt>Unit price</dt>
                    <dd>
                      <Money value={line.unitPrice} currency={deal.currency} />
                    </dd>
                  </>
                )}
                <dt>Total</dt>
                <dd>
                  <Money value={deal.amount} currency={deal.currency} />
                </dd>
                {deal.terms.shipmentDate && (
                  <>
                    <dt>Ship by</dt>
                    <dd>{longDate(deal.terms.shipmentDate)}</dd>
                  </>
                )}
                <dt>Program</dt>
                <dd>{programLabel(deal.programId)}</dd>
                <dt>Deal ID</dt>
                <dd>
                  <Ref id={deal.id} />
                </dd>
              </dl>
            </div>
          </Panel>
          {facts.length > 0 && (
            <Panel title="Evidence">
              <div className="panel-body">
                {lateBy !== null && lateBy > 0 && (
                  <p className={`late${tolerance !== null && lateBy > tolerance ? ' error' : ''}`}>
                    Shipped {lateBy} day{lateBy === 1 ? '' : 's'} after the ship-by date
                    {tolerance !== null && `; the program allows ${tolerance}`}.
                  </p>
                )}
                {facts.map((f) => (
                  <FactCard
                    key={f.id}
                    fact={f}
                    replaced={replaced.has(f.id)}
                    findings={failed.get(f.id)}
                  />
                ))}
              </div>
            </Panel>
          )}
          {cases.length > 0 && (
            <Panel title="Decisions">
              <table>
                <tbody>
                  {cases.map((c) => (
                    <tr key={c.id}>
                      <td className="title-cell">
                        <Link href={`/decisions/${c.id}`}>{caseKind(c.kind)}</Link>
                        <small>{sentences(c.reason)}</small>
                      </td>
                      <td className="num">
                        {c.resolution ? actionLabel(c.resolution.action.type) : sentence(c.status)}
                        <Link className="go sub-line" href={`/decisions/${c.id}`}>
                          View decision
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          {obligations.length > 0 && (
            <Panel title="Settlement">
              <table>
                <tbody>
                  {obligations.map((o) => (
                    <tr key={o.id}>
                      <td>
                        {memberName(o.payerMemberId)} owes {memberName(o.payeeMemberId)}
                        <small className="sub-line">{sentence(o.status)}</small>
                      </td>
                      <td>
                        {o.cycleId && (
                          <Link className="go nowrap" href={`/settlement/${o.cycleId}`}>
                            Cycle {shortId('CY', o.cycleId)}
                          </Link>
                        )}
                      </td>
                      <td className="num">
                        <Money value={o.amount} currency={o.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

const DOC_NAMES: Record<string, string> = {
  commercial_invoice: 'Commercial invoice',
  packing_list: 'Packing list',
  bill_of_lading: 'Bill of lading',
};

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

function fieldText(k: string, v: unknown, fields: Record<string, unknown>) {
  if (k === 'amount' && typeof fields.currency === 'string')
    return `amount ${moneyText(String(v), fields.currency)}`;
  if (k === 'currency' && 'amount' in fields) return null;
  if (k === 'passed' && typeof fields.inspected === 'number')
    return `${Number(v).toLocaleString('en')} of ${fields.inspected.toLocaleString('en')} passed`;
  if (k === 'inspected' && 'passed' in fields) return null;
  if (typeof v === 'number') return `${words(k).toLowerCase()} ${v.toLocaleString('en')}`;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return `${words(k.replace(/([A-Z])/g, '_$1').toLowerCase())} ${longDate(v)}`;
  }
  return `${words(k.replace(/([A-Z])/g, '_$1').toLowerCase())} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`;
}

type Issue = { code: string; message?: string };

/** A document filed again replaces the one before it; the earlier one stays on record. */
export function replacedFacts(facts: Pick<Fact, 'id' | 'kind' | 'type'>[]): Set<string> {
  return new Set(
    facts
      .filter((f, i) => f.kind === 'document' && facts.slice(i + 1).some((g) => g.type === f.type))
      .map((f) => f.id),
  );
}

/** What failed each document when the deal was last held: the evidence check, not the reader. */
export function heldFindings(
  events: { type: string; payload: Record<string, unknown> }[],
): Map<string, Issue[]> {
  const held = events.findLast((e) => e.type === 'held');
  return byFact((held?.payload.findings ?? []) as (Issue & { factId?: string })[]);
}

export function byFact(findings: (Issue & { factId?: string })[]): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>();
  for (const { factId, ...f } of findings) {
    if (factId) out.set(factId, [...(out.get(factId) ?? []), f]);
  }
  return out;
}

export function FactCard({
  fact,
  replaced = false,
  findings = [],
}: {
  fact: Pick<Fact, 'kind' | 'type' | 'data' | 'source'>;
  replaced?: boolean;
  findings?: Issue[];
}) {
  const issues = [
    ...(fact.data.issues ?? []),
    ...findings.filter((f) => !fact.data.issues?.some((i) => i.code === f.code)),
  ];
  const source = (fact.data.fields ?? (fact.kind === 'document' ? {} : fact.data)) as Record<
    string,
    unknown
  >;
  const fields = Object.entries(source).filter(
    ([k]) => !['issues', 'extraction', 'fields'].includes(k),
  );
  // An inspection passes or fails part of the goods; a partial pass is not "no issues".
  const inspected = Number(source.inspected ?? 0);
  const rejected = inspected ? inspected - Number(source.passed ?? inspected) : 0;
  const title =
    fact.kind === 'document'
      ? (DOC_NAMES[fact.type ?? ''] ?? sentence(fact.type))
      : `${sentence(fact.kind)}${fact.type ? ` (${words(fact.type)})` : ''}`;
  return (
    <div className={`doc${issues.length && !replaced ? ' bad' : ''}${replaced ? ' replaced' : ''}`}>
      <div className="doc-name">
        <span>{title}</span>
        {replaced ? (
          <Pill>Replaced</Pill>
        ) : issues.length ? (
          <Pill tone="stop">{`${issues.length} issue${issues.length > 1 ? 's' : ''}`}</Pill>
        ) : rejected > 0 ? (
          <Pill tone="wait">{`${rejected.toLocaleString('en')} rejected`}</Pill>
        ) : (
          <Pill tone="ok">No issues</Pill>
        )}
      </div>
      {fields.length > 0 && (
        <div className="doc-fields">
          {fields
            .map(([k, v]) => fieldText(k, v, source))
            .filter(Boolean)
            .join(', ')}
        </div>
      )}
      {issues.length > 0 && (
        <ul>
          {issues.map((i) => (
            <li key={i.code} className="issue">
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
