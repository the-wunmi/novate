import { Link } from 'wouter';
import { useLive } from '../api.ts';
import { NettingRibbon, NettingSummary } from '../netting.tsx';
import { useSession } from '../session.tsx';
import type { CycleDetail } from '../types.ts';
import {
  dateTime,
  LoadFailed,
  Loading,
  longDate,
  Money,
  PageHead,
  Panel,
  PayoutStatus,
  Ref,
  railName,
  shortId,
  words,
} from '../ui.tsx';
import { cycleStatus, timingText } from './settlement.tsx';

const PHASES = [
  { key: 'netting', label: 'Net' },
  { key: 'settling', label: 'Fund, with FX' },
  { key: 'committed', label: 'Book' },
  { key: 'settled', label: 'Pay out' },
];

export function CyclePage({ id }: { id: string }) {
  const { memberName } = useSession();
  const detail = useLive<CycleDetail>('cycle', `/cycles/${id}`);
  if (!detail.data) return detail.error ? <LoadFailed error={detail.error} /> : <Loading />;
  const { cycle, instructions, positions, exchanges, rounding, openFx } = detail.data;
  const reached = PHASES.findIndex((p) => p.key === cycle.status);
  const failed = cycle.status === 'failed' || cycle.status === 'deferred';

  return (
    <>
      <PageHead
        crumb={
          <>
            <Link href="/settlement">Settlement</Link> / {shortId('CY', id)}
          </>
        }
        title={`Cycle ${shortId('CY', id)}`}
        lede={
          <span className="outcome">
            {cycleStatus(cycle.status)}
            <span className="muted">
              {cycle.settlement ? (
                <>
                  {railName(cycle.settlement.rail)}, {words(cycle.settlement.netting)} netting,{' '}
                  {timingText(cycle.settlement.timing)}
                </>
              ) : (
                <>Withdrawal, {railName(instructions[0]?.rail ?? '')}</>
              )}
              {cycle.closedAt && <>. Value date {longDate(cycle.closedAt)}</>}
            </span>
          </span>
        }
      />
      <Panel className="phases-panel">
        <div className="panel-body">
          <ol className="phases">
            {PHASES.map((p, i) => (
              <li
                key={p.key}
                className={
                  failed && i === Math.max(reached, 1)
                    ? 'bad'
                    : i < reached || cycle.status === 'settled'
                      ? 'done'
                      : i === reached
                        ? 'now'
                        : undefined
                }
              >
                {p.label}
                {i === 0 && <small className="sub-line">{dateTime(cycle.createdAt)}</small>}
                {i === PHASES.length - 1 && cycle.closedAt && (
                  <small className="sub-line">{dateTime(cycle.closedAt)}</small>
                )}
              </li>
            ))}
          </ol>
        </div>
      </Panel>
      <NettingSummary cycle={cycle} />
      <Panel title="Netting">
        <div className="panel-body">
          <NettingRibbon key={cycle.id} cycle={cycle} name={memberName} animate />
        </div>
      </Panel>
      {positions.length > 0 && (
        <Panel title="Net positions">
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th className="num">Owes</th>
                <th className="num">Is owed</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={`${p.memberId}-${p.currency}`}>
                  <td className="title-cell">{memberName(p.memberId)}</td>
                  <td className="num">
                    <Money value={p.owes} currency={p.currency} />
                  </td>
                  <td className="num">
                    <Money value={p.owed} currency={p.currency} />
                  </td>
                  <td className="num">
                    {BigInt(p.net) === 0n ? (
                      <span className="faint">Flat</span>
                    ) : (
                      <>
                        <span className="muted">
                          {BigInt(p.net) > 0n ? 'Receives ' : 'Pays in '}
                        </span>
                        <Money
                          value={BigInt(p.net) > 0n ? p.net : -BigInt(p.net)}
                          currency={p.currency}
                        />
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <div className="cols even">
        <Panel title="Gross obligations">
          <table>
            <tbody>
              {cycle.owed.map((o) => (
                <tr key={`${o.dealId}-${o.payer}`}>
                  <td className="title-cell">
                    {memberName(o.payer)} owes {memberName(o.payee)}
                    <small>
                      <Link className="ref" href={`/deals/${o.dealId}`}>
                        {shortId('DL', o.dealId)}
                      </Link>
                    </small>
                  </td>
                  <td className="num">
                    <Money value={o.amount} currency={o.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="Money moved">
          <table>
            <tbody>
              {cycle.converted.map((f) => (
                <tr key={`fx-${f.sellCurrency}-${f.buyCurrency}-${f.buyAmount}`}>
                  <td className="title-cell">
                    Converted <Money value={f.sellAmount} currency={f.sellCurrency} />
                    <small>
                      {f.rateLabel}
                      {f.externalRef && (
                        <>
                          , <Ref id={f.externalRef} />
                        </>
                      )}
                    </small>
                  </td>
                  <td />
                  <td className="num">
                    <Money value={f.buyAmount} currency={f.buyCurrency} />
                  </td>
                </tr>
              ))}
              {exchanges.map((e) => (
                <tr key={`ex-${e.memberId}-${e.sellCurrency}-${e.buyCurrency}`}>
                  <td className="title-cell">
                    {memberName(e.memberId)} sold <Money value={e.sold} currency={e.sellCurrency} />
                  </td>
                  <td />
                  <td className="num">
                    <Money value={e.bought} currency={e.buyCurrency} />
                  </td>
                </tr>
              ))}
              {rounding.map((r) => (
                <tr key={`rounding-${r.currency}`}>
                  <td className="title-cell">
                    Rounding {BigInt(r.amount) > 0n ? 'kept by' : 'paid by'} the house
                  </td>
                  <td />
                  <td className="num">
                    <Money value={r.amount} currency={r.currency} />
                  </td>
                </tr>
              ))}
              {openFx.map((r) => (
                <tr key={`open-fx-${r.currency}`}>
                  <td className="title-cell">Open FX position</td>
                  <td />
                  <td className="num">
                    <Money value={r.amount} currency={r.currency} />
                  </td>
                </tr>
              ))}
              {instructions.map((i) => (
                <tr key={i.id}>
                  <td className="title-cell">
                    {i.direction === 'payout'
                      ? `Payout to ${memberName(i.memberId)}`
                      : `Collection from ${memberName(i.memberId)}`}
                    {i.attempt > 1 && <span className="faint"> (attempt {i.attempt})</span>}
                    <small>
                      {railName(i.rail)}
                      {i.externalRef && (
                        <>
                          , transfer <Ref id={i.externalRef} />
                        </>
                      )}
                      {i.status === 'confirmed' && i.paidAt && <>, paid {dateTime(i.paidAt)}</>}
                    </small>
                    {i.failureReason && <small className="error">{i.failureReason}</small>}
                  </td>
                  <td>
                    <PayoutStatus status={i.status} />
                  </td>
                  <td className="num">
                    <Money value={i.amount} currency={i.currency} />
                  </td>
                </tr>
              ))}
              {!instructions.length && !cycle.converted.length && (
                <tr className="empty-row">
                  <td colSpan={3}>Nothing moved: everything was offset by netting.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
