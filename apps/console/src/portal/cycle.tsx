import { Link } from 'wouter';
import { useLive } from '../api.ts';
import type { MemberCycle } from '../types.ts';
import {
  dateTime,
  EmptyRow,
  Kpi,
  LoadFailed,
  Loading,
  Money,
  PageHead,
  Panel,
  Pill,
  sentence,
  shortId,
  type Tone,
} from '../ui.tsx';

/** A conversion as the rail has it; `booked` when the house already held the currency. */
const CONVERSION: Record<string, [string, Tone]> = {
  booked: ['Booked', 'ok'],
  submitted: ['Under way', 'wait'],
  confirmed: ['Done', 'ok'],
  failed: ['Failed', 'stop'],
};

export function MyCycle({ id }: { id: string }) {
  const cycle = useLive<MemberCycle>('my-cycle', `/cycles/${id}`);
  if (!cycle.data) return cycle.error ? <LoadFailed error={cycle.error} /> : <Loading />;
  const { owed, position, instructions, converted } = cycle.data;
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
            <Pill tone={cycle.data.cycle.status === 'settled' ? 'ok' : 'wait'}>
              {sentence(cycle.data.cycle.status)}
            </Pill>
            <span className="muted">Started {dateTime(cycle.data.cycle.createdAt)}</span>
          </span>
        }
      />
      <div className="kpis">
        {position.map((p) => (
          <Kpi
            key={p.currency}
            label={`Your net in ${p.currency}`}
            figure={<Money value={p.net} currency={p.currency} />}
            note={
              <>
                Owed <Money value={p.owed} currency={p.currency} />, owing{' '}
                <Money value={p.owes} currency={p.currency} />
              </>
            }
          />
        ))}
      </div>
      <div className="stack">
        <Panel title="Your deals in this cycle">
          <table>
            <thead>
              <tr>
                <th>Deal</th>
                <th>You</th>
                <th>Counterparty</th>
                <th className="num">Gross</th>
              </tr>
            </thead>
            <tbody>
              {owed.map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a deal may owe in more than one leg
                <tr key={`${o.dealId}-${i}`}>
                  <td>
                    <Link className="ref" href={`/deals/${o.dealId}`}>
                      {shortId('DL', o.dealId)}
                    </Link>
                  </td>
                  <td>{o.side === 'payer' ? 'Pay' : 'Receive'}</td>
                  <td className="muted">{o.counterpartyName ?? shortId('MB', o.counterpartyId)}</td>
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
            <thead>
              <tr>
                <th>What</th>
                <th>Status</th>
                <th>Reference</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {converted.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: conversions have no id of their own here
                <tr key={`fx-${i}`}>
                  <td>
                    Converted <Money value={c.sellAmount} currency={c.sellCurrency} /> to{' '}
                    {c.buyCurrency}
                    {c.rateLabel && <small className="sub-line faint">{c.rateLabel}</small>}
                  </td>
                  <td>
                    <Pill tone={CONVERSION[c.status ?? 'booked']?.[1] ?? ''}>
                      {CONVERSION[c.status ?? 'booked']?.[0] ?? sentence(c.status)}
                    </Pill>
                  </td>
                  <td className="mono muted">{c.externalRef ?? '—'}</td>
                  <td className="num">
                    <Money value={c.buyAmount} currency={c.buyCurrency} />
                  </td>
                </tr>
              ))}
              {instructions.map((p) => (
                <tr key={p.id}>
                  <td>{p.direction === 'payout' ? 'Paid to your bank' : sentence(p.direction)}</td>
                  <td>
                    {sentence(p.status)}
                    {p.paidAt && (
                      <small className="sub-line faint">Paid {dateTime(p.paidAt)}</small>
                    )}
                    {p.failureReason && <small className="sub-line error">{p.failureReason}</small>}
                  </td>
                  <td className="mono muted">{p.externalRef ?? '—'}</td>
                  <td className="num">
                    <Money value={p.amount} currency={p.currency} />
                  </td>
                </tr>
              ))}
              {!converted.length && !instructions.length && (
                <EmptyRow cols={4}>Nothing moved for you.</EmptyRow>
              )}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
