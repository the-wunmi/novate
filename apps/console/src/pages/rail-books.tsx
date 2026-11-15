import { useState } from 'react';
import { Link } from 'wouter';
import { api, isPending, type Page, type Pending, useAction, useTenant } from '../api.ts';
import { ApprovalActions } from '../approvals.tsx';
import { differenceItems } from '../differences.ts';
import { useSession } from '../session.tsx';
import type { Approval, RailBook, RunBreak, UnattributedDeposit } from '../types.ts';
import {
  Amounts,
  actorName,
  ago,
  dateTime,
  EmptyRow,
  Money,
  moneyText,
  Panel,
  Pill,
  Ref,
  railName,
  sentence,
  shortId,
  words,
} from '../ui.tsx';
import { BreakStatus } from './book-breaks.tsx';

const RAIL_TYPES: Record<string, string> = {
  TRANSFER: 'Transfer',
  CHARGE: 'Charge',
  DEPOSIT: 'Deposit',
  PAYOUT: 'Payout',
  CONVERSION: 'Conversion',
  FEE: 'Fee',
  PAYMENT: 'Card payment',
};
/** Airwallex ids say what they are when the rail gives no transaction type. */
const PREFIXES: Record<string, string> = { tr_: 'Transfer', ch_: 'Charge', dp_: 'Deposit' };

function typeOf(b: RunBreak) {
  if (b.detail?.railType)
    return RAIL_TYPES[b.detail.railType] ?? sentence(words(b.detail.railType).toLowerCase());
  const prefix = Object.keys(PREFIXES).find((p) => b.externalRef?.startsWith(p));
  return prefix ? PREFIXES[prefix] : 'Transaction';
}

/** Why the ledger and the rail disagree, in reconciliation terms. */
export function cause(b: RunBreak, rail: string) {
  const name = railName(rail);
  switch (b.kind) {
    case 'missing_in_ledger':
      return `${typeOf(b)} on the ${name} statement, not in the ledger`;
    case 'missing_on_rail':
      return `Payment in the ledger, not on the ${name} statement`;
    case 'amount_mismatch':
      return `Amounts differ between the ledger and ${name}`;
    default:
      return 'Balance differs';
  }
}

export function Breaks({ rail, breaks }: { rail: string; breaks: RunBreak[] }) {
  const shown = differenceItems(breaks);
  // A balance difference that only follows from the items is shown once, as their net.
  const nets = breaks.filter((b) => !b.countsAsItem);
  return (
    <table className="breaks">
      <thead>
        <tr>
          <th>Unmatched item</th>
          <th>On the rail</th>
          <th className="num">Ledger</th>
          <th className="num">{railName(rail)}</th>
          <th>Reference</th>
          <th>Now</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((b) => (
          <tr key={`${b.kind}-${b.currency}-${b.externalRef}`}>
            <td>{cause(b, rail)}</td>
            <td className="muted nowrap">
              {b.detail?.occurredAt ? dateTime(b.detail.occurredAt) : '—'}
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
              <BreakStatus b={b} />
            </td>
          </tr>
        ))}
      </tbody>
      {nets.length > 0 && (
        <tfoot>
          {nets.map((b) => (
            <tr key={`net-${b.currency}`}>
              <td colSpan={2}>Net difference, {b.currency}</td>
              <td className="num" colSpan={2}>
                <Money value={BigInt(b.actual) - BigInt(b.expected)} currency={b.currency} />
              </td>
              <td colSpan={2} />
            </tr>
          ))}
        </tfoot>
      )}
    </table>
  );
}

export function RailBooks({ book }: { book: RailBook }) {
  const { tenantId, isHouse } = useSession();
  const { rail, latest, positions, openDifferences } = book;
  const check = useAction(tenantId, {
    run: () =>
      api<{ status: string; breaks: { countsAsItem: boolean }[] }>(
        `/tenants/${tenantId}/reconciliation`,
        { body: { rail } },
      ),
    done: (r) => {
      const n = differenceItems(r.breaks).length;
      return r.status === 'clean'
        ? `Reconciled with ${railName(rail)}`
        : `${n} difference${n === 1 ? '' : 's'} with ${railName(rail)}`;
    },
  });

  return (
    <Panel
      title={railName(rail)}
      sub={`${book.environment} account${latest ? `, checked ${ago(latest.at)}` : ''}${
        book.differencesSince ? `, differences open since ${dateTime(book.differencesSince)}` : ''
      }`}
      aside={
        <div className="actions">
          {latest && (
            <Pill tone={openDifferences ? 'stop' : 'ok'}>
              {openDifferences ? `${openDifferences} open` : 'Reconciled'}
            </Pill>
          )}
          {isHouse && <Rebase rail={rail} />}
          {isHouse && (
            <button
              type="button"
              className="btn small"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
      }
    >
      <table className="fixed">
        <colgroup>
          <col style={{ width: '10%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '10%' }} />
          <col className="hide-md" style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr>
            <th>Currency</th>
            <th className="num">Movement since opening</th>
            <th className="num">Of which the house's own</th>
            <th className="num">Ledger balance</th>
            <th className="num">{railName(rail)} balance</th>
            <th className="num">Difference</th>
            <th className="num hide-md">Opening balance</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const diff = BigInt(p.rail) - BigInt(p.ledger);
            return (
              <tr key={p.currency}>
                <td className="title-cell">{p.currency}</td>
                <td className="num">
                  <Money value={p.movement} currency={p.currency} />
                </td>
                <td className="num muted">
                  <HouseOwn position={p} />
                </td>
                <td className="num">
                  <Money value={p.ledger} currency={p.currency} />
                </td>
                <td className="num">
                  <Money value={p.rail} currency={p.currency} />
                </td>
                <td className="num">
                  {diff === 0n ? (
                    <span className="faint">
                      <Money value={0n} currency={p.currency} />
                    </span>
                  ) : (
                    <span className="error">
                      <Money value={diff} currency={p.currency} />
                    </span>
                  )}
                </td>
                <td className="num faint hide-md">
                  <Money value={p.atOpening} currency={p.currency} />
                </td>
              </tr>
            );
          })}
          {!positions.length && (
            <EmptyRow cols={7}>
              {latest ? 'Shown after the next check.' : 'No checks yet.'}
            </EmptyRow>
          )}
        </tbody>
      </table>
      {latest?.breaks.length ? <Breaks rail={rail} breaks={latest.breaks} /> : null}
      <div className="panel-foot muted">
        Opening {book.openingAt ? dateTime(book.openingAt) : '—'}
        {latest?.absorbedByOpening?.currencies.some((c) => BigInt(c.amount) !== 0n) && (
          <>
            , absorbed <Amounts list={latest.absorbedByOpening.currencies} />
          </>
        )}
        {book.opening && (
          <>
            , recorded by {actorName(book.opening.requestedBy)}
            {book.opening.approvedBy && <>, approved by {actorName(book.opening.approvedBy)}</>}
            {book.opening.reason && <>: {book.opening.reason}</>}
            {book.opening.approvalId && (
              <>
                {' '}
                <Link className="go" href="/people">
                  Approval
                </Link>{' '}
                <Ref id={book.opening.approvalId} />
              </>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

const OWN_PARTS: Record<string, string> = {
  rail_fees: 'Rail fees',
  cards_fronted: 'Card money fronted',
  member_debt: 'Owed by members',
  program_fees: 'Program fees',
  fx_rounding: 'FX rounding',
  fx_open: 'Open FX position',
  default_losses: 'Default losses',
  other: 'In transit',
};

/** The house's own money on a rail, and what it is made of, each part with what it came from. */
function HouseOwn({ position: p }: { position: RailBook['positions'][number] }) {
  return (
    <>
      {p.houseOwn !== null ? <Money value={p.houseOwn} currency={p.currency} /> : '—'}
      {p.houseOwnParts.map((part) => (
        <span key={part.kind} className="sub-line">
          {OWN_PARTS[part.kind] ?? sentence(words(part.kind))}{' '}
          <Money value={part.amount} currency={p.currency} />
          {part.refs.map((r) => (
            <span key={r.id}>
              {' '}
              <Link
                className="ref"
                href={r.type === 'cycle' ? `/settlement/${r.id}` : `/deals/${r.id}`}
              >
                {shortId(r.type === 'cycle' ? 'CY' : 'DL', r.id)}
              </Link>
            </span>
          ))}
          {part.more ? ` +${part.more} more` : null}
        </span>
      ))}
    </>
  );
}

export function Unmatched({ deposits }: { deposits: UnattributedDeposit[] }) {
  const { tenantId, members, memberName, isHouse } = useSession();
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const assign = useAction(tenantId, {
    run: (d: UnattributedDeposit) =>
      api(`/tenants/${tenantId}/deposits/${d.id}/assign`, {
        body: { memberId: chosen[d.id], reason: reasons[d.id]?.trim() },
      }),
    done: (r, d) =>
      isPending(r)
        ? 'Sent for approval'
        : `Credited ${moneyText(d.amount, d.currency)} to ${memberName(chosen[d.id])}`,
  });
  return (
    <Panel title="Unmatched deposits">
      <table>
        <tbody>
          {deposits.map((d) => (
            <tr key={d.id}>
              <td className="title-cell">Received on {d.depositAccountRef}</td>
              <td>
                {isHouse && (
                  <>
                    <select
                      className="field"
                      aria-label="Member"
                      value={chosen[d.id] ?? ''}
                      onChange={(e) => setChosen({ ...chosen, [d.id]: e.target.value })}
                    >
                      <option value="">Choose a member</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>{' '}
                    <input
                      className="search"
                      placeholder="How you know it is theirs"
                      aria-label="Reason"
                      value={reasons[d.id] ?? ''}
                      onChange={(e) => setReasons({ ...reasons, [d.id]: e.target.value })}
                    />{' '}
                    <button
                      type="button"
                      className="btn small"
                      disabled={!chosen[d.id] || !reasons[d.id]?.trim() || assign.isPending}
                      onClick={() => assign.mutate(d)}
                    >
                      Credit member
                    </button>
                  </>
                )}
              </td>
              <td className="num">
                <Money value={d.amount} currency={d.currency} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * Re-records what the rail account holds as the new starting point. Audited, needs a reason, and
 * refused while differences are open unless they are closed with it.
 */
function Rebase({ rail }: { rail: string }) {
  const { tenantId } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [rebaseBreaks, setRebaseBreaks] = useState(false);
  const rebase = useAction(tenantId, {
    run: () =>
      api<Pending>(`/tenants/${tenantId}/rails/${rail}/opening`, {
        body: { reason: reason.trim(), rebaseBreaks },
      }),
    done: 'Sent for approval',
    onDone: () => setOpen(false),
  });
  if (!open)
    return (
      <button type="button" className="btn small ghost" onClick={() => setOpen(true)}>
        Request new opening…
      </button>
    );
  return (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        rebase.mutate();
      }}
    >
      <input
        className="search"
        required
        placeholder="Why the opening changes"
        aria-label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <label className="check-toggle">
        <input
          type="checkbox"
          checked={rebaseBreaks}
          onChange={(e) => setRebaseBreaks(e.target.checked)}
        />
        Close open differences with it
      </label>
      <button
        type="submit"
        className="btn small danger"
        disabled={rebase.isPending || !reason.trim()}
      >
        Ask for approval
      </button>
      <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

type OpeningRequest = Approval<{
  rail: string;
  rebaseBreaks: boolean;
  absorbed: Record<string, string>;
}>;

/** New openings of a rail waiting for a second person, with what each would absorb. */
export function OpeningRequests({ rail }: { rail: string }) {
  const { tenantId } = useSession();
  const requests = useTenant<Page<OpeningRequest>>(tenantId, '/approvals?kind=rail_opening', {
    live: true,
  });
  const mine = requests.data?.rows.filter((r) => r.payload.rail === rail) ?? [];
  if (!mine.length) return null;
  return (
    <Panel title={`New opening for ${railName(rail)} waiting for approval`}>
      <table>
        <thead>
          <tr>
            <th>Asked by</th>
            <th>Why</th>
            <th>What it absorbs</th>
            <th>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {mine.map((r) => {
            const absorbed = Object.entries(r.payload.absorbed);
            return (
              <tr key={r.approvalId}>
                <td>
                  {actorName(r.requestedBy)}
                  <small className="sub-line faint">{dateTime(r.requestedAt)}</small>
                </td>
                <td>
                  {r.reason}
                  {r.payload.rebaseBreaks && (
                    <small className="sub-line">Closes open differences</small>
                  )}
                </td>
                <td className="num">
                  {absorbed.length
                    ? absorbed.map(([currency, amount]) => (
                        <span key={currency} className="sub-line">
                          <Money value={amount} currency={currency} />
                        </span>
                      ))
                    : 'Nothing'}
                </td>
                <td className="muted nowrap">{dateTime(r.expiresAt)}</td>
                <td className="num">
                  <ApprovalActions a={r} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
