import { useState } from 'react';
import { useLocation } from 'wouter';
import { useSession } from '../session.tsx';
import type { Program } from '../types.ts';
import { ago, EmptyRow, Money, PageHead, Panel, railName, words } from '../ui.tsx';
import { PublishForm } from './program.tsx';

export const FUNDING: Record<string, string> = {
  prefunded: 'Buyer prefunds in full',
  partial: 'Buyer prefunds part',
  net_then_fund: 'Members fund their net position',
  none: 'No funding',
};

/** Funding and netting together, as a settlement desk would describe the arrangement. */
export function moneyType(p: Program) {
  const funding = FUNDING[p.spec.funding.mode] ?? words(p.spec.funding.mode);
  const netting =
    p.spec.settlement.netting === 'gross'
      ? 'gross settlement, no netting'
      : `${words(p.spec.settlement.netting)} netting`;
  return `${funding}; ${netting}`;
}

/** Two programs can share a name; the rail tells them apart. */
export function programTitle(p: Program, all: Program[]) {
  const name = p.spec.name;
  const twins = all.filter((q) => q.key !== p.key && q.spec.name === name);
  return twins.length ? `${name} (${railName(p.spec.settlement.rail)})` : name;
}

export function latestByKey(programs: Program[]) {
  const latest = new Map<string, Program>();
  for (const p of programs) {
    const seen = latest.get(p.key);
    if (!seen || p.version > seen.version) latest.set(p.key, p);
  }
  return [...latest.values()];
}

export function Programs() {
  const { programs, me } = useSession();
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const current = latestByKey(programs);
  const deals = (key: string) =>
    programs.filter((p) => p.key === key).reduce((n, p) => n + p.deals, 0);

  return (
    <>
      <PageHead
        title="Programs"
        actions={
          me.kind === 'platform' ? (
            <button type="button" className="btn primary" onClick={() => setCreating(!creating)}>
              New program
            </button>
          ) : undefined
        }
      />
      {creating && (
        <div className="stack">
          <PublishForm onDone={(key) => navigate(`/programs/${key}`)} />
        </div>
      )}
      <Panel>
        <table>
          <thead>
            <tr>
              <th>Program</th>
              <th>Funding and netting</th>
              <th>Rail</th>
              <th className="num">AI ceiling</th>
              <th className="num">Deals</th>
              <th>Latest version</th>
            </tr>
          </thead>
          <tbody>
            {current.map((p) => {
              const ceilings = Object.entries(p.spec.decisions.ceiling);
              return (
                <tr key={p.id} className="row" onClick={() => navigate(`/programs/${p.key}`)}>
                  <td className="title-cell">
                    <a href={`#/programs/${p.key}`} onClick={(e) => e.stopPropagation()}>
                      {programTitle(p, current)}
                    </a>
                  </td>
                  <td className="muted">{moneyType(p)}</td>
                  <td>{railName(p.spec.settlement.rail)}</td>
                  <td className="num">
                    {ceilings.length
                      ? ceilings.map(([currency, ceiling]) => (
                          <span key={currency} className="sub-line">
                            <Money value={String(ceiling)} currency={currency} />
                          </span>
                        ))
                      : '—'}
                  </td>
                  <td className="num">{deals(p.key)}</td>
                  <td className="muted nowrap">
                    v{p.version}, {ago(p.createdAt)}
                  </td>
                </tr>
              );
            })}
            {!current.length && <EmptyRow cols={6}>No programs yet.</EmptyRow>}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
