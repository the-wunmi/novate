import { Link } from 'wouter';
import { useTenant } from '../api.ts';
import { ExportButton } from '../export-menu.tsx';
import { PeriodSwitch, usePeriod } from '../periods.tsx';
import { useSession } from '../session.tsx';
import type { Economics as EconomicsData } from '../types.ts';
import {
  Amounts,
  EmptyRow,
  Kpi,
  LoadFailed,
  Loading,
  Money,
  PageHead,
  Panel,
  sentence,
} from '../ui.tsx';

/** What the platform earned, what running it cost, and the business that went through it. */
export function Economics() {
  const { tenantId, memberName, programs, me } = useSession();
  const period = usePeriod(['month', 'lastMonth', '90d', 'all', 'custom']);
  const data = useTenant<EconomicsData>(tenantId, `/economics${period.query}`, {
    enabled: period.ready,
  });
  const e = data.data;
  const anyFees = programs.some((p) => p.spec.fees?.sellerBps || p.spec.fees?.buyerBps);

  return (
    <>
      <PageHead
        title="Fees and volume"
        actions={
          <span className="toolbar">
            <ExportButton
              path={`/tenants/${tenantId}/economics.csv`}
              name="fees-and-volume"
              period={period}
            />
            <PeriodSwitch period={period} />
          </span>
        }
      />
      {!e ? (
        data.error ? (
          <LoadFailed error={data.error} />
        ) : (
          data.isLoading && <Loading />
        )
      ) : (
        <>
          <div className="kpis">
            <Kpi
              label={me.kind === 'platform' ? 'You earned' : 'Platform earned'}
              figure={<Amounts list={e.platformEarned} empty="None" />}
              note={
                !anyFees ? (
                  <Link href="/programs">No program charges a fee yet</Link>
                ) : e.platformOwed.some((f) => BigInt(f.amount) > 0n) ? (
                  <>
                    <Amounts list={e.platformOwed} /> still owed
                  </>
                ) : e.houseEarned.some((f) => BigInt(f.amount) > 0n) ? (
                  <>
                    House share <Amounts list={e.houseEarned} />
                  </>
                ) : undefined
              }
            />
            <Kpi
              label="Rail fees"
              figure={<Amounts list={e.railFeesPaid} empty="0.00" />}
              note={
                e.cardFees.some((f) => BigInt(f.amount) > 0n) ? (
                  <>
                    Paid by the house. Card fees of <Amounts list={e.cardFees} /> were paid by
                    buyers
                  </>
                ) : (
                  'Paid by the house'
                )
              }
            />
            <Kpi
              label="Value settled"
              figure={<Amounts list={e.volume.byCurrency} empty="0.00" />}
            />
            <Kpi
              label="Deals"
              figure={e.deals.opened}
              note={`${e.deals.settled} settled${Object.entries(e.deals.byStatus)
                .filter(([s, n]) => n > 0 && !['settled'].includes(s))
                .slice(0, 2)
                .map(([s, n]) => `, ${n} ${sentence(s).toLowerCase()}`)
                .join('')}`}
            />
          </div>
          <div className="stack">
            {e.byMonth.some((m) => m.dealsSettled > 0) && (
              <Panel title="By month">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Deals settled</th>
                      <th className="num">Value settled</th>
                      <th className="num">Fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...e.byMonth]
                      .reverse()
                      .filter(
                        (m) => m.dealsSettled > 0 || m.fees.some((f) => BigInt(f.amount) > 0n),
                      )
                      .map((m) => (
                        <tr key={m.month}>
                          <td className="nowrap">
                            {new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
                              month: 'long',
                              year: 'numeric',
                              timeZone: 'UTC',
                            })}
                          </td>
                          <td className="num">{m.dealsSettled}</td>
                          <td className="num">
                            <Amounts list={m.settled} empty="0.00" />
                          </td>
                          <td className="num">
                            <Amounts list={m.fees} empty="0.00" />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </Panel>
            )}
            <Panel title="By program">
              <table>
                <thead>
                  <tr>
                    <th>Program</th>
                    <th className="num">Deals opened</th>
                    <th className="num">Deals settled</th>
                    <th className="num">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {e.volume.byProgram.map((p) => (
                    <tr key={`${p.programKey}-${p.currency}`}>
                      <td className="title-cell">
                        <Link href={`/programs/${p.programKey}`}>{p.label}</Link>
                      </td>
                      <td className="num">{p.dealsOpened}</td>
                      <td className="num">{p.dealsSettled}</td>
                      <td className="num">
                        <Money value={p.amount} currency={p.currency} />
                      </td>
                    </tr>
                  ))}
                  {!e.volume.byProgram.length && (
                    <EmptyRow cols={4}>No deals in this period.</EmptyRow>
                  )}
                </tbody>
              </table>
            </Panel>
            <Panel title="By member">
              <table>
                <thead>
                  <tr>
                    <th>Member</th>
                    <th className="num">Deals</th>
                    <th className="num">Paid</th>
                    <th className="num">Received</th>
                    <th className="num">Fees</th>
                  </tr>
                </thead>
                <tbody>
                  {e.volume.byMember.map((m) => (
                    <tr key={`${m.memberId}-${m.currency}`}>
                      <td className="title-cell">
                        <Link href={`/members/${m.memberId}`}>{memberName(m.memberId)}</Link>
                      </td>
                      <td className="num">{m.deals}</td>
                      <td className="num">
                        <Money value={m.paid} currency={m.currency} />
                      </td>
                      <td className="num">
                        <Money value={m.received} currency={m.currency} />
                      </td>
                      <td className="num muted">
                        <Money value={m.fees} currency={m.currency} />
                      </td>
                    </tr>
                  ))}
                  {!e.volume.byMember.length && (
                    <EmptyRow cols={5}>Nothing settled in this period.</EmptyRow>
                  )}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
