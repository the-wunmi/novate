// What the next cycle of each settlement group would do if it ran now: who pays in, who is paid,
// who cannot cover their side, and whether the rail holds enough to pay out. Computed by the same
// netting the cycle uses, so nothing here is an estimate of a different method.
import { Link } from 'wouter';
import { useTenant } from './api.ts';
import { useSession } from './session.tsx';
import type { SettlementPreview } from './types.ts';
import { dateTime, EmptyRow, Money, Panel, Pill, railName, words } from './ui.tsx';

export function NextCycles() {
  const { tenantId } = useSession();
  const preview = useTenant<SettlementPreview>(tenantId, '/settlement/preview', {
    live: true,
  });
  const groups = preview.data?.groups ?? [];
  if (!preview.data || !groups.length) return null;
  return (
    <Panel
      title="Next settlement"
      sub={
        preview.data.settlementStopped
          ? `Settlement is stopped: ${preview.data.settlementStopped.reason}`
          : undefined
      }
    >
      {groups.map((g) => {
        const short = g.positions.filter((p) => BigInt(p.shortfall) > 0n);
        const railShort = g.currencies.filter(
          (c) => c.railShortfall && BigInt(c.railShortfall) > 0n,
        );
        return (
          <div key={g.settlementGroup.key} className="preview-group">
            <p className="preview-head">
              <strong>{g.settlementGroup.program.name}</strong>{' '}
              <span className="muted">
                {railName(g.settlementGroup.rail)}, {words(g.settlementGroup.netting)} netting,{' '}
                {g.deals} deal
                {g.deals === 1 ? '' : 's'},{' '}
                {g.nextRunAt ? `runs ${dateTime(g.nextRunAt)}` : 'runs when started'}
              </span>{' '}
              {short.length > 0 && <Pill tone="stop">{short.length} cannot cover</Pill>}
              {railShort.length > 0 && <Pill tone="stop">Rail short</Pill>}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Member</th>
                  <th className="num">Pays in</th>
                  <th className="num">Receives</th>
                  <th className="num">Free balance</th>
                  <th className="num">Short by</th>
                </tr>
              </thead>
              <tbody>
                {g.positions.map((p) => (
                  <tr key={`${p.memberId}-${p.currency}`}>
                    <td className="title-cell">
                      <Link href={`/members/${p.memberId}`}>{p.name}</Link>
                      {p.paidTo === 'wallet' && <small>Paid to balance, not the bank</small>}
                    </td>
                    <td className="num">
                      <Money value={p.payIn} currency={p.currency} />
                    </td>
                    <td className="num">
                      <Money value={p.receive} currency={p.currency} />
                    </td>
                    <td className="num muted">
                      <Money value={p.walletAvailable} currency={p.currency} />
                    </td>
                    <td className={`num${BigInt(p.shortfall) > 0n ? ' error' : ' faint'}`}>
                      <Money value={p.shortfall} currency={p.currency} />
                    </td>
                  </tr>
                ))}
                {!g.positions.length && <EmptyRow cols={5}>Nothing to settle.</EmptyRow>}
              </tbody>
              <tfoot>
                {g.currencies.map((c) => (
                  <tr key={c.currency}>
                    <td>
                      {c.currency} on {railName(g.settlementGroup.rail)}
                      {c.railBalance === null && (
                        <small className="sub-line faint">Rail balance not yet checked</small>
                      )}
                    </td>
                    <td className="num">
                      <Money value={c.payIn} currency={c.currency} />
                    </td>
                    <td className="num">
                      <Money value={c.payouts} currency={c.currency} />
                    </td>
                    <td className="num muted">
                      {c.railBalance !== null ? (
                        <Money value={c.railBalance} currency={c.currency} />
                      ) : (
                        '—'
                      )}
                      <small className="sub-line faint">on the rail</small>
                    </td>
                    <td
                      className={`num${c.railShortfall && BigInt(c.railShortfall) > 0n ? ' error' : ' faint'}`}
                    >
                      {c.railShortfall !== null ? (
                        <Money value={c.railShortfall} currency={c.currency} />
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tfoot>
            </table>
          </div>
        );
      })}
    </Panel>
  );
}
