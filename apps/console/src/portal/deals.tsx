// The member's deals: each from its own side, with the history it may see and its claims.
import { type ReactNode, useDeferredValue, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api, useAction, useLive, usePaged } from '../api.ts';
import { describeDealEvent } from '../describe.tsx';
import { ExportButton } from '../export-menu.tsx';
import { FactCard, heldFindings, replacedFacts } from '../pages/deal.tsx';
import type { Deal, Me, PartyDeal } from '../types.ts';
import {
  DealStatus,
  dateTime,
  EmptyRow,
  LoadFailed,
  Loading,
  Money,
  PageHead,
  Panel,
  Pill,
  parseMinor,
  sentence,
  shortId,
  type Tone,
  toast,
} from '../ui.tsx';
import { counterparty, role, useMyAccount } from './my.ts';

type Group = 'all' | 'open' | 'review' | 'settled' | 'stopped';
const FILTERS: { key: Group; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'review', label: 'In review' },
  { key: 'settled', label: 'Settled' },
  { key: 'stopped', label: 'Cancelled' },
];
const SORTS = { newest: 'Newest', oldest: 'Oldest', largest: 'Largest', smallest: 'Smallest' };

export function MyDeals({ me }: { me: Me }) {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Group>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<keyof typeof SORTS>('newest');
  const needle = useDeferredValue(search.trim());
  const deals = usePaged<Deal, { counts: Record<Group, number> }>(`/tenants/${me.tenantId}/deals`, {
    status: filter === 'all' ? undefined : filter,
    q: needle,
    sort,
  });
  const memberId = me.memberId as string;
  const name = useMyAccount(me).data?.name ?? 'member';
  return (
    <>
      <PageHead
        title="Deals"
        actions={
          <ExportButton
            path={`/tenants/${me.tenantId}/deals.csv`}
            name={`${name.toLowerCase().replaceAll(' ', '-')}-deals`}
          />
        }
      />
      <Panel
        title={
          <span className="toolbar">
            <input
              className="search"
              type="search"
              placeholder="Search deals"
              aria-label="Search deals"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="search"
              aria-label="Sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as keyof typeof SORTS)}
            >
              {Object.entries(SORTS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </span>
        }
        aside={
          <div className="seg">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={filter === f.key}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="n">{deals.head?.counts[f.key] ?? ''}</span>
              </button>
            ))}
          </div>
        }
      >
        {deals.error && !deals.rows ? (
          <LoadFailed error={deals.error} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Deal</th>
                <th>You are</th>
                <th>Counterparty</th>
                <th className="hide-md">Your agent</th>
                <th>Status</th>
                <th>Created</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(deals.rows ?? []).map((d) => (
                <tr key={d.id} className="row" onClick={() => navigate(`/deals/${d.id}`)}>
                  <td className="title-cell">
                    <a href={`#/deals/${d.id}`} onClick={(e) => e.stopPropagation()}>
                      {sentence(d.terms.lines?.[0]?.description ?? d.terms.category)}
                    </a>
                    <small>{shortId('DL', d.id)}</small>
                  </td>
                  <td>{sentence(role(d, memberId))}</td>
                  <td className="muted">{counterparty(d, memberId)}</td>
                  <td className="muted hide-md">
                    {(role(d, memberId) === 'buyer' ? d.buyerAgentName : d.sellerAgentName) ?? '—'}
                  </td>
                  <td>
                    <DealStatus deal={d} />
                  </td>
                  <td className="muted nowrap">{dateTime(d.createdAt)}</td>
                  <td className="num">
                    <Money value={d.amount} currency={d.currency} />
                    {d.releaseAmount && BigInt(d.releaseAmount) !== BigInt(d.amount) && (
                      <small className="sub-line muted">
                        <Money value={d.releaseAmount} currency={d.currency} /> released
                      </small>
                    )}
                  </td>
                </tr>
              ))}
              {deals.rows && !deals.rows.length && <EmptyRow cols={7}>No deals.</EmptyRow>}
              {!deals.rows && <EmptyRow cols={7}>Loading…</EmptyRow>}
            </tbody>
          </table>
        )}
        {deals.more && (
          <div className="panel-foot">
            <button
              type="button"
              className="btn small"
              disabled={deals.loadingMore}
              onClick={deals.more}
            >
              {deals.loadingMore ? 'Loading…' : 'Load older deals'}
            </button>
          </div>
        )}
      </Panel>
    </>
  );
}

const OUTCOME: Record<string, string> = {
  release: 'Released to the seller',
  partial_release: 'Part released, the rest returned',
  refund: 'Refunded to the buyer',
  hold: 'Held for more evidence',
  extend: 'Deadline extended',
  escalate: 'Passed to a person',
  request_evidence: 'Asked for corrected evidence',
  waive: 'Findings waived',
  release_full: 'Released in full',
  confirm: 'Deal confirmed',
  cancel: 'Deal cancelled',
  draw_margin: "Paid from the seller's margin",
};

export function MyDeal({ me, id }: { me: Me; id: string }) {
  const detail = useLive<PartyDeal>('my-deal', `/deals/${id}`);
  if (!detail.data) return detail.error ? <LoadFailed error={detail.error} /> : <Loading />;
  const { deal, obligations, events, cases } = detail.data;
  const facts = detail.data.facts ?? [];
  const replaced = replacedFacts(facts);
  const failed = heldFindings(events);
  const memberId = me.memberId as string;
  const claims = detail.data.claims ?? [];
  const evidenceOpen =
    isOpen(deal.status) || (deal.status === 'settled' && claims.some((c) => c.status === 'open'));
  return (
    <>
      <PageHead
        crumb={
          <>
            <Link href="/deals">Deals</Link> / {shortId('DL', id)}
          </>
        }
        title={sentence(deal.terms.lines?.[0]?.description ?? deal.terms.category)}
        actions={
          <span className="toolbar">
            {evidenceOpen && <AddEvidence deal={deal} />}
            <Claim deal={deal} side={role(deal, memberId)} until={detail.data.claimUntil ?? null} />
          </span>
        }
        lede={
          <span className="outcome">
            <DealStatus deal={deal} />
            <PaidOf deal={deal} />
            <span className="muted">{sentence(role(deal, memberId))}</span>
            <span className="muted">Counterparty: {counterparty(deal, memberId)}</span>
          </span>
        }
      />
      <div className="stack">
        {claims.length > 0 && (
          <Panel title="Claims">
            <table>
              <thead>
                <tr>
                  <th>Filed</th>
                  <th>By</th>
                  <th>Reason</th>
                  <th>Details</th>
                  <th>Status</th>
                  <th className="num">Asked</th>
                  <th className="num">Granted</th>
                </tr>
              </thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td className="nowrap muted">{dateTime(c.at)}</td>
                    <td>{c.by === role(deal, memberId) ? 'You' : sentence(c.by)}</td>
                    <td>{CLAIM_REASONS[c.category ?? ''] ?? '—'}</td>
                    <td>{c.reason?.replace(/^[^:]+: /, '') ?? '—'}</td>
                    <td>
                      <Pill tone={CLAIM_STATUS[c.status]?.[1] ?? ''}>
                        {CLAIM_STATUS[c.status]?.[0] ?? sentence(c.status)}
                      </Pill>
                    </td>
                    <td className="num">
                      {c.amount ? (
                        <Money value={c.amount} currency={deal.currency} />
                      ) : c.by === 'seller' ? (
                        'All held back'
                      ) : (
                        'Full price'
                      )}
                    </td>
                    <td className="num">
                      {c.outcome?.amount ? (
                        <Money value={c.outcome.amount} currency={deal.currency} />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        {cases.length > 0 && (
          <Panel title="Reviews">
            <table>
              <thead>
                <tr>
                  <th>Why it was reviewed</th>
                  <th>Outcome</th>
                  <th>Decided by</th>
                  <th>Closed</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td>{c.reason}</td>
                    <td>
                      {c.decision ? (
                        <>
                          {OUTCOME[c.decision.action.type] ?? sentence(c.decision.action.type)}
                          {typeof c.decision.action.note === 'string' && (
                            <small className="sub-line">Asked for: {c.decision.action.note}</small>
                          )}
                          <small className="sub-line faint">{c.decision.rationale}</small>
                        </>
                      ) : (
                        <Pill tone="wait">Under review</Pill>
                      )}
                    </td>
                    <td className="muted">
                      {c.decision?.deciderType
                        ? { model: 'AI', person: 'A person', rule: 'Rules', system: 'Rules' }[
                            c.decision.deciderType
                          ]
                        : '—'}
                    </td>
                    <td className="muted nowrap">{c.closedAt ? dateTime(c.closedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        <Panel title="Terms">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Quantity</th>
                <th className="num">Unit price</th>
                <th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {(deal.terms.lines ?? []).map((l) => (
                <tr key={l.sku}>
                  <td className="title-cell">
                    {sentence(l.description)}
                    <small>{l.sku}</small>
                  </td>
                  <td className="num">{l.quantity.toLocaleString('en-GB')}</td>
                  <td className="num">
                    <Money value={l.unitPrice} currency={deal.currency} />
                  </td>
                  <td className="num">
                    <Money
                      value={BigInt(l.unitPrice) * BigInt(l.quantity)}
                      currency={deal.currency}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            {deal.terms.shipmentDate && (
              <tfoot>
                <tr>
                  <td colSpan={4} className="muted">
                    Ship by{' '}
                    {new Date(deal.terms.shipmentDate).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </Panel>
        {facts.length > 0 && (
          <Panel title="Documents and evidence">
            <div className="panel-body facts-list">
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
        <Panel title="Payments">
          <table>
            <thead>
              <tr>
                <th>Direction</th>
                <th>Owed since</th>
                <th>Status</th>
                <th>Cycle</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {obligations.map((o) => (
                <tr key={o.id}>
                  <td>{o.payerMemberId === memberId ? 'You pay' : 'You receive'}</td>
                  <td className="muted nowrap">{dateTime(o.createdAt)}</td>
                  <td>
                    {sentence(o.status)}
                    {o.settledAt && (
                      <small className="sub-line faint">Settled {dateTime(o.settledAt)}</small>
                    )}
                  </td>
                  <td>
                    {o.cycleId ? (
                      <Link className="ref" href={`/settlement/${o.cycleId}`}>
                        {shortId('CY', o.cycleId)}
                      </Link>
                    ) : (
                      <span className="faint">Not yet settled</span>
                    )}
                  </td>
                  <td className="num">
                    <Money value={o.amount} currency={o.currency} />
                  </td>
                </tr>
              ))}
              {!obligations.length && (
                <EmptyRow cols={5}>
                  {['cancelled', 'refunded', 'rejected'].includes(deal.status)
                    ? 'Nothing owed'
                    : 'Nothing owed yet'}
                </EmptyRow>
              )}
            </tbody>
          </table>
        </Panel>
        <Panel title="History">
          <ol className="tape two">
            {[...events].reverse().map((e) => (
              <li key={e.seq}>
                <time dateTime={e.at}>{dateTime(e.at)}</time>
                <span className="what">
                  <Described
                    d={describeDealEvent(
                      e.type,
                      { currency: deal.currency, ...e.payload },
                      (ref) => ref.split('@')[0] ?? ref,
                    )}
                  />
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}

const CLAIM_REASONS: Record<string, string> = {
  not_received: 'Not received',
  short: 'Short delivery',
  quality: 'Quality',
  late: 'Late',
  not_paid: 'Not paid',
  short_paid: 'Paid short',
  other: 'Other',
};
/** What each side may raise, as the engine allows it. */
const SIDE_REASONS: Record<'buyer' | 'seller', string[]> = {
  buyer: ['not_received', 'short', 'quality', 'late', 'other'],
  seller: ['not_paid', 'short_paid', 'other'],
};

const CLAIM_STATUS: Record<string, [string, Tone]> = {
  open: ['Under review', 'wait'],
  refunded: ['Refunded', 'ok'],
  paid: ['Paid', 'ok'],
  closed: ['Closed', ''],
};

const ENDED = ['settled', 'cancelled', 'refunded', 'rejected'];
const isOpen = (status: string) => !ENDED.includes(status);

/**
 * While a deal is open, either side may dispute it, which holds its release for review. Once it
 * settled, during the program's claim window, the buyer may claim a refund and a seller paid short
 * may claim what was held back; the outcome shows under Reviews.
 */
function Claim({
  deal,
  side,
  until,
}: {
  deal: Pick<Deal, 'id' | 'tenantId' | 'currency' | 'amount' | 'releaseAmount' | 'status'>;
  side: 'buyer' | 'seller';
  until: string | null;
}) {
  const { id: dealId, tenantId } = deal;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const settled = deal.status === 'settled';
  const heldBack =
    deal.releaseAmount === null ? 0n : BigInt(deal.amount) - BigInt(deal.releaseAmount);
  const asked = settled && amount.trim() ? parseMinor(amount, deal.currency) : null;
  const file = useAction(tenantId, {
    run: () =>
      api(`/deals/${dealId}/facts`, {
        body: {
          kind: 'dispute',
          type: settled ? 'claim' : 'dispute',
          data: {
            category,
            reason: reason.trim(),
            ...(asked !== null ? { amount: String(asked) } : {}),
          },
        },
      }),
    done: settled ? 'Claim filed' : 'Dispute raised',
    onDone: () => setOpen(false),
  });
  if (!settled && !isOpen(deal.status)) return null;
  if (settled && side === 'seller' && heldBack <= 0n) return null;
  if (settled && until && new Date(until).getTime() < Date.now())
    return <span className="muted">Claims closed {dateTime(until)}</span>;
  const label = settled ? 'Raise a claim…' : 'Raise a dispute…';
  if (!open)
    return (
      <>
        {settled && until && <span className="muted">Claims open until {dateTime(until)}</span>}
        <button type="button" className="btn" onClick={() => setOpen(true)}>
          {label}
        </button>
      </>
    );
  return (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        file.mutate();
      }}
    >
      <select
        className="search"
        required
        aria-label="Reason"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      >
        <option value="">Reason</option>
        {SIDE_REASONS[side].map((k) => (
          <option key={k} value={k}>
            {CLAIM_REASONS[k]}
          </option>
        ))}
      </select>
      <input
        className="search"
        required
        placeholder="Details"
        aria-label="Details"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {settled && (
        <input
          className="search"
          inputMode="decimal"
          placeholder={`${side === 'buyer' ? 'Refund' : 'Payment'} asked (${deal.currency}), optional`}
          aria-label={side === 'buyer' ? 'Refund asked' : 'Payment asked'}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      )}
      <button
        type="submit"
        className="btn primary"
        disabled={
          file.isPending || !reason.trim() || !category || (amount.trim() !== '' && asked === null)
        }
      >
        {settled ? 'File claim' : 'Raise dispute'}
      </button>
      <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

/** Larger than any real photo or scan a party would send; the reader limits what it reads. */
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** A file as the documents route takes it. */
async function evidenceOf(file: File) {
  if (file.type.startsWith('text/')) return { kind: 'text', text: await file.text() };
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  if (file.type === 'application/pdf') return { kind: 'pdf', base64 };
  return { kind: 'image', mediaType: file.type, base64 };
}

/** A photo, scan or note for the reviewers, read like any document on the deal. */
function AddEvidence({ deal }: { deal: Pick<Deal, 'id' | 'tenantId'> }) {
  const send = useAction(deal.tenantId, {
    run: async (file: File) =>
      api(`/deals/${deal.id}/documents`, {
        body: { type: 'claim_evidence', content: await evidenceOf(file) },
      }),
    done: 'Evidence added',
  });
  return (
    <label className="btn file-pick">
      {send.isPending ? 'Reading…' : 'Add evidence…'}
      <input
        type="file"
        accept={['application/pdf', 'text/plain', ...IMAGE_TYPES].join(',')}
        disabled={send.isPending}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > MAX_EVIDENCE_BYTES) return toast('That file is over 10 MB');
          if (
            ![...IMAGE_TYPES, 'application/pdf'].includes(file.type) &&
            !file.type.startsWith('text/')
          )
            return toast('Send a PDF, an image or a text file');
          send.mutate(file);
        }}
      />
    </label>
  );
}

function Described({ d }: { d: { text: ReactNode; detail?: ReactNode } }) {
  return (
    <>
      {d.text}
      {d.detail && <small className="sub-line faint">{d.detail}</small>}
    </>
  );
}

/** The agreed price, and when less was released, what was paid and what went back. */
function PaidOf({ deal }: { deal: Pick<Deal, 'amount' | 'releaseAmount' | 'currency'> }) {
  const agreed = BigInt(deal.amount);
  const released = deal.releaseAmount ? BigInt(deal.releaseAmount) : null;
  if (released === null || released === agreed)
    return <Money value={deal.amount} currency={deal.currency} />;
  return (
    <span>
      <Money value={released} currency={deal.currency} /> released of{' '}
      <Money value={agreed} currency={deal.currency} /> agreed;{' '}
      <Money value={agreed - released} currency={deal.currency} /> back to the buyer
    </span>
  );
}
