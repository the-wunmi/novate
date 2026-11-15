import { useLocation } from 'wouter';
import { useTenant } from '../api.ts';
import type { Me, MemberSettlement } from '../types.ts';
import {
  Amounts,
  dateTime,
  EmptyRow,
  LoadFailed,
  Loading,
  PageHead,
  Panel,
  railName,
  sentence,
  shortId,
} from '../ui.tsx';
import { Holds } from './standing.tsx';

/** What the member will pay or receive next, and every cycle it took part in. */
export function MySettlement({ me }: { me: Me }) {
  const [, navigate] = useLocation();
  const data = useTenant<MemberSettlement>(me.tenantId, `/members/${me.memberId}/settlement`, {
    live: true,
  });
  if (!data.data) return data.error ? <LoadFailed error={data.error} /> : <Loading />;
  const { cycles, upcoming } = data.data;
  return (
    <>
      <PageHead title="Settlement" lede={<Holds me={me} />} />
      <div className="stack">
        <Panel title="Next settlement">
          <table>
            <thead>
              <tr>
                <th>Program</th>
                <th>Runs</th>
                <th className="num">You owe</th>
                <th className="num">You are owed</th>
                <th className="num">Net</th>
                <th className="num">Pay in</th>
                <th className="num">Free now</th>
                <th className="num">Short</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((u) => (
                <tr key={u.settlementGroup.key}>
                  <td className="title-cell">
                    {u.settlementGroup.program.name}
                    <small>
                      {railName(u.settlementGroup.rail)}, {u.deals} deal{u.deals === 1 ? '' : 's'}
                    </small>
                  </td>
                  <td className="nowrap muted">
                    {u.nextRunAt ? dateTime(u.nextRunAt) : 'When the platform runs it'}
                  </td>
                  <td className="num">
                    <Amounts list={u.payable} empty="0.00" />
                  </td>
                  <td className="num">
                    <Amounts list={u.receivable} empty="0.00" />
                  </td>
                  <td className="num">
                    <Amounts list={u.net} empty="0.00" />
                  </td>
                  <td className="num">
                    <Amounts
                      list={u.funding.map((f) => ({ currency: f.currency, amount: f.payIn }))}
                      empty="0.00"
                    />
                  </td>
                  <td className="num">
                    <Amounts
                      list={u.funding
                        .filter((f) => BigInt(f.payIn) > 0n)
                        .map((f) => ({ currency: f.currency, amount: f.free }))}
                      empty="—"
                      zeros
                    />
                  </td>
                  <td className="num error">
                    <Amounts
                      list={u.funding.map((f) => ({ currency: f.currency, amount: f.short }))}
                      empty="—"
                    />
                  </td>
                </tr>
              ))}
              {!upcoming.length && <EmptyRow cols={8}>Nothing waiting to settle.</EmptyRow>}
            </tbody>
          </table>
        </Panel>
        <Panel title="Past cycles">
          <table>
            <thead>
              <tr>
                <th>Cycle</th>
                <th>Status</th>
                <th>Closed</th>
                <th className="num">Your net</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => (
                <tr key={c.id} className="row" onClick={() => navigate(`/settlement/${c.id}`)}>
                  <td className="title-cell">
                    <a href={`#/settlement/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {shortId('CY', c.id)}
                    </a>
                    <small>Started {dateTime(c.createdAt)}</small>
                  </td>
                  <td>{sentence(c.status)}</td>
                  <td className="muted nowrap">{c.closedAt ? dateTime(c.closedAt) : '—'}</td>
                  <td className="num">
                    <Amounts list={c.net} empty="0.00" />
                  </td>
                </tr>
              ))}
              {!cycles.length && <EmptyRow cols={4}>No cycles yet.</EmptyRow>}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
