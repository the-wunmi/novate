import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'wouter';
import { api, useAction } from '../api.ts';
import { useSession } from '../session.tsx';
import type { Program, ProgramSpec, ProgramSpecInput, ShadowRunDetail } from '../types.ts';
import {
  actorName,
  dateTime,
  LoadFailed,
  Money,
  moneyText,
  PageHead,
  Panel,
  Pill,
  parseMinor,
  railName,
  sentence,
  toMajor,
  words,
} from '../ui.tsx';
import { FUNDING } from './programs.tsx';

export function ProgramPage({ programKey }: { programKey: string }) {
  const { programs, programsError, me } = useSession();
  const versions = programs
    .filter((p) => p.key === programKey)
    .sort((a, b) => b.version - a.version);
  const [picked, setPicked] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const p = versions.find((v) => v.version === picked) ?? versions[0];
  if (!p && programsError) return <LoadFailed error={programsError} />;
  if (!p)
    return programs.length ? (
      <p className="panel-body">
        There is no program called “{programKey}”. <Link href="/programs">See all programs</Link>
      </p>
    ) : (
      <p className="muted">Loading…</p>
    );
  const previous = versions.find((v) => v.version === p.version - 1);

  return (
    <>
      <PageHead
        crumb={
          <>
            <Link href="/programs">Programs</Link> / {p.spec.name}
          </>
        }
        title={`${p.spec.name} v${p.version}`}
        lede={p.spec.description}
        actions={
          me.kind === 'platform' ? (
            <button type="button" className="btn primary" onClick={() => setEditing(!editing)}>
              Publish a new version
            </button>
          ) : undefined
        }
      />
      {editing && (
        <div className="stack">
          <PublishForm base={versions[0]} onDone={() => setEditing(false)} />
        </div>
      )}
      <div className="cols two">
        <SpecView spec={p.spec} />
        <div className="stack">
          <Panel title="Versions">
            <table>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="row" onClick={() => setPicked(v.version)}>
                    <td className="title-cell">
                      v{v.version}
                      <small>
                        {dateTime(v.createdAt)}
                        {`, by ${actorName(v.createdBy)}`}
                      </small>
                      {v.note && <small>{v.note}</small>}
                    </td>
                    <td className="muted">
                      {v.deals} deal{v.deals === 1 ? '' : 's'}
                    </td>
                    <td className="num">
                      {v.version === p.version ? <Pill tone="moved">Viewing</Pill> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          {previous && (
            <Panel title={`Changes from v${previous.version}`}>
              <div className="panel-body">
                <Diff from={previous.spec} to={p.spec} />
              </div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

// ── Reading a program ─────────────────────────────────────────────────────

const bps = (n: number | undefined) =>
  n === undefined ? '—' : `${(n / 100).toFixed(n % 100 ? 1 : 0)}%`;

/** One part of the program, as a row of a settings list: what it is on the left, the rule on the right. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="setting">
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <span key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </span>
      ))}
    </dl>
  );
}

function SpecView({ spec }: { spec: ProgramSpec }) {
  const t = spec.settlement.timing;
  const timing =
    t.mode === 'cycle'
      ? `Scheduled, every ${t.every}`
      : t.mode === 'immediate'
        ? 'Real-time, as each deal clears'
        : 'On demand';
  const limits = spec.decisions.limits;
  const { funding, margin } = spec;
  return (
    <Panel className="settings">
      <Section title="Funding">
        <Facts
          rows={[
            ['Buyer', FUNDING[funding.mode] ?? words(funding.mode)],
            ...(funding.mode === 'partial'
              ? ([['Share up front', bps(funding.bps)]] as [string, ReactNode][])
              : []),
            ...(funding.mode !== 'net_then_fund'
              ? ([['Must fund within', funding.timeout]] as [string, ReactNode][])
              : []),
            ...(funding.mode !== 'net_then_fund' && funding.fxBufferBps
              ? ([['Buffer for FX', bps(funding.fxBufferBps)]] as [string, ReactNode][])
              : []),
          ]}
        />
      </Section>
      <Section title="Fees">
        {spec.fees?.sellerBps || spec.fees?.buyerBps ? (
          <Facts
            rows={[
              ['Seller pays', bps(spec.fees.sellerBps)],
              ['Buyer pays', bps(spec.fees.buyerBps)],
              ['Platform share', bps(spec.fees.platformShareBps)],
              ['House share', bps(10_000 - spec.fees.platformShareBps)],
            ]}
          />
        ) : (
          <p className="muted">No fee is charged.</p>
        )}
      </Section>
      <Section title="Settlement">
        <Facts
          rows={[
            ['Rail', railName(spec.settlement.rail)],
            ['Netting', sentence(spec.settlement.netting)],
            ['Trigger', timing],
          ]}
        />
      </Section>
      <Section title="Seller margin">
        {margin.mode === 'none' ? (
          <p className="muted">No margin is held.</p>
        ) : margin.mode === 'fixed' ? (
          <Facts rows={[['Held', bps(margin.bps)]]} />
        ) : (
          <>
            <Facts
              rows={[
                ['Starts at', bps(margin.baseBps)],
                ['Range', `${bps(margin.minBps)} to ${bps(margin.maxBps)}`],
              ]}
            />
            {margin.adjustments.length > 0 && (
              <ul className="rule-list" style={{ marginTop: 8 }}>
                {margin.adjustments.map((a) => (
                  <li key={a.reason}>
                    {a.addBps > 0 ? 'Add' : 'Take off'} {bps(Math.abs(a.addBps))} when {a.reason}
                    <Rule when={a.when} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>
      <Section title="Who decides">
        <Facts
          rows={[
            [
              'In order',
              sentence(
                spec.decisions.deciders
                  .map((d) => (d === 'model' ? 'AI' : d === 'person' ? 'a person' : d))
                  .join(', then '),
              ),
            ],
            [
              'AI may decide up to',
              Object.entries(spec.decisions.ceiling).length ? (
                <span key="ceiling">
                  {Object.entries(spec.decisions.ceiling).map(([c, v], i) => (
                    <span key={c}>
                      {i > 0 && ', '}
                      <Money value={String(v)} currency={c} />
                    </span>
                  ))}
                </span>
              ) : (
                'Nothing: every case goes to a person'
              ),
            ],
            [
              'Autonomy',
              spec.decisions.autonomy.mode === 'earned'
                ? 'Earned from its track record'
                : 'The whole ceiling, from the start',
            ],
            ['AI retries after code refuses', String(spec.decisions.modelAttempts - 1)],
            ['AI may force a release', limits.allowForceRelease ? 'Yes' : 'No, only a person'],
            ['AI may refund or grant claims', limits.allowRefund ? 'Yes' : 'No, only a person'],
          ]}
        />
      </Section>
      <Section title="What freezes a deal">
        {spec.checks.length ? (
          <ul className="rule-list">
            {spec.checks.map((c) => (
              <li key={c.id}>
                {c.reason}
                <Rule when={c.when} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing. Deals go straight through once authority is checked.</p>
        )}
      </Section>
      <Section title="What releases the money">
        <Condition node={spec.release.condition} />
        <Facts
          rows={[
            [
              'Pays',
              spec.release.amount.type === 'pro_rata_inspection'
                ? 'What passed inspection; the rest to the buyer'
                : 'In full',
            ],
            ['Evidence fails', spec.release.onBlocked === 'escalate' ? 'Decisions' : 'Waits'],
          ]}
        />
      </Section>
      {spec.overrides.length > 0 && (
        <Section title="Exceptions to these rules">
          <ul className="rule-list">
            {spec.overrides.map((o) => (
              <li key={o.id}>
                {o.reason}
                <Rule when={o.when} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </Panel>
  );
}

const DOCS: Record<string, string> = {
  commercial_invoice: 'commercial invoice',
  packing_list: 'packing list',
  bill_of_lading: 'bill of lading',
};

function Condition({ node }: { node: unknown }): ReactNode {
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.all) || Array.isArray(n.any)) {
    const list = (n.all ?? n.any) as unknown[];
    return (
      <div>
        <p className="muted">{n.all ? 'All of these:' : 'Any one of these:'}</p>
        <ul className="rule-list">
          {list.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no identity of their own
            <li key={i}>
              <Condition node={c} />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  switch (n.type) {
    case 'documents':
      return (
        <>
          Documents filed:{' '}
          {((n.require as string[]) ?? []).map((d) => DOCS[d] ?? words(d)).join(', ')}, and they
          agree with each other and the deal
        </>
      );
    case 'inspection':
      return (
        <>An inspection passes at least {Math.round(Number(n.minPassRate) * 100)}% of the goods</>
      );
    case 'no_dispute':
      return <>Nobody has raised a dispute</>;
    case 'acceptance':
      return <>The buyer accepts the goods</>;
    case 'elapsed':
      return <>{String(n.after)} pass with no complaint</>;
    default:
      return <>{sentence(n.type)}</>;
  }
}

// ── Comparing versions ────────────────────────────────────────────────────

function flatten(value: unknown, path = '', out: Record<string, string> = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  } else out[path] = JSON.stringify(value);
  return out;
}

/** The machine form of a rule, for whoever wants to check it. Hidden until asked for. */
function Rule({ when }: { when: string }) {
  return (
    <details className="rule">
      <summary>Show rule</summary>
      <span className="when">{when.replace(/(\d+)\.0\b/g, '$1')}</span>
    </details>
  );
}

/** Names for the settings a version changes most often. Anything else is spelled out from its path. */
const PATH_NAMES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^decisions\.ceiling\.([A-Z]{3})$/, (m) => `AI ceiling (${m[1]})`],
  [/^decisions\.autonomy\.mode$/, () => 'Autonomy'],
  [/^settlement\.netting$/, () => 'Netting'],
  [/^settlement\.rail$/, () => 'Rail'],
  [/^settlement\.timing\.every$/, () => 'Settles every'],
  [/^funding\.mode$/, () => 'Funding'],
  [/^name$/, () => 'Name'],
  [/^fees\.sellerBps$/, () => 'Seller fee'],
  [/^fees\.buyerBps$/, () => 'Buyer fee'],
  [/^fees\.platformShareBps$/, () => 'Platform share of fees'],
];

const pathName = (path: string) =>
  PATH_NAMES.map(([re, name]) => {
    const m = path.match(re);
    return m ? name(m) : null;
  }).find(Boolean) ??
  path
    .split('.')
    .map((p) =>
      /^[A-Z]{3}$/.test(p) ? p : words(p.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()),
    )
    .join(', ');

/** A changed value as a person would read it: money as money, words without quotes. */
function shownValue(path: string, json: string | undefined) {
  if (json === undefined) return undefined;
  const value = JSON.parse(json) as unknown;
  const currency = path.split('.').at(-1) ?? '';
  if (path.includes('ceiling') && /^[A-Z]{3}$/.test(currency) && typeof value === 'number') {
    return moneyText(BigInt(value), currency);
  }
  if (path.endsWith('Bps') && typeof value === 'number') return `${value / 100}%`;
  if (typeof value === 'string') return sentence(value);
  return Array.isArray(value) ? value.map(words).join(', ') : String(value);
}

export function Diff({ from, to }: { from: unknown; to: unknown }) {
  const a = flatten(from);
  const b = flatten(to);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k])
    .sort();
  if (!keys.length) return <p className="muted">Nothing changed.</p>;
  return (
    <ul className="diff">
      {keys.map((k) => (
        <li key={k}>
          <span>{sentence(pathName(k) as string)}</span>
          <span className="was">{shownValue(k, a[k]) ?? 'not set'}</span>
          <span className="now">{shownValue(k, b[k]) ?? 'removed'}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Publishing ────────────────────────────────────────────────────────────

const FEE_FIELDS = ['sellerBps', 'buyerBps', 'platformShareBps'] as const;
const FEE_LABELS: Record<(typeof FEE_FIELDS)[number], { field: string; problem: string }> = {
  sellerBps: { field: 'Fee on the seller (%)', problem: 'Seller fee' },
  buyerBps: { field: 'Fee on the buyer (%)', problem: 'Buyer fee' },
  platformShareBps: { field: 'Platform share of fees (%)', problem: 'Platform share' },
};
/** What the schema fills in when a program sets no fees: all of any fee is the platform's. */
const FEE_DEFAULTS: Record<(typeof FEE_FIELDS)[number], number> = {
  sellerBps: 0,
  buyerBps: 0,
  platformShareBps: 10_000,
};

const PRESET_KEYS: Record<string, string> = {
  tradeAssurance: 'trade-assurance',
  netSettlement: 'net-settlement',
  marketplaceSettlement: 'marketplace',
  realtimeAgentClearing: 'agent-clearing',
};

/**
 * Change the settings people most often change, see exactly what will differ, then publish. Starts
 * from the current version, or from a preset for a new program.
 */
export function PublishForm({ base, onDone }: { base?: Program; onDone: (key: string) => void }) {
  const { tenantId, programs, rails } = useSession();
  const presets = useQuery({
    queryKey: ['presets'],
    queryFn: () => api<Record<string, ProgramSpec>>('/presets'),
  });
  const [preset, setPreset] = useState('');
  const [key, setKey] = useState(base?.key ?? '');
  const start = base?.spec ?? (preset ? presets.data?.[preset] : undefined);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [added, setAdded] = useState<string[]>([]);
  const currencies = [...Object.keys(start?.decisions.ceiling ?? {}), ...added];
  const passRate = inspectionRate(start?.release.condition);
  // Every check any version of this program has had, so one switched off can be switched back on.
  const allChecks = [
    ...new Map(
      [
        ...programs.filter((p) => base && p.key === base.key).flatMap((p) => p.spec.checks),
        ...(start?.checks ?? []),
      ].map((c) => [c.id, c]),
    ).values(),
  ];
  const isOn = (id: string) =>
    edits[`check.${id}`]
      ? edits[`check.${id}`] === 'on'
      : Boolean(start?.checks.some((c) => c.id === id));
  // What the form refuses rather than silently drops.
  const problems: string[] = [];
  for (const c of currencies) {
    const v = edits[`ceiling.${c}`];
    if (v === undefined) {
      if (added.includes(c)) problems.push(`AI ceiling in ${c}`);
      continue;
    }
    const minor = parseMinor(v, c);
    if (minor === null || minor <= 0n) problems.push(`AI ceiling in ${c}`);
  }
  for (const side of FEE_FIELDS) {
    const v = edits[`fee.${side}`];
    if (v !== undefined && v.trim() !== '' && !(Number(v) >= 0 && Number(v) <= 100))
      problems.push(FEE_LABELS[side].problem);
  }
  if (
    edits.passRate !== undefined &&
    !(Number(edits.passRate) > 0 && Number(edits.passRate) <= 100)
  )
    problems.push('Inspection pass mark');

  // Recomputed each render: it is cheap, and depends on everything the form holds.
  const spec = (() => {
    if (!start) return undefined;
    const next: ProgramSpecInput = structuredClone(start);
    if (edits.name !== undefined) next.name = edits.name;
    // Changing the funding mode keeps its other settings (deadline, FX buffer) where they still apply.
    if (edits.funding && edits.funding !== start.funding.mode) {
      // The server checks the result, as it does for any client.
      next.funding = { ...start.funding, mode: edits.funding } as ProgramSpecInput['funding'];
    }
    if (edits.netting) {
      const netting = edits.netting as ProgramSpec['settlement']['netting'];
      next.settlement = { ...next.settlement, netting };
    }
    if (edits.rail) next.settlement = { ...next.settlement, rail: edits.rail };
    if (edits.every)
      next.settlement = { ...next.settlement, timing: { mode: 'cycle', every: edits.every } };
    for (const c of currencies) {
      const minor =
        edits[`ceiling.${c}`] !== undefined ? parseMinor(edits[`ceiling.${c}`] ?? '', c) : null;
      if (minor !== null && minor > 0n) {
        next.decisions = {
          ...next.decisions,
          ceiling: { ...next.decisions?.ceiling, [c]: Number(minor) },
        };
      }
    }
    next.checks = allChecks.filter((c) => isOn(c.id));
    if (edits.passRate !== undefined && Number(edits.passRate) > 0) {
      setInspectionRate(next.release.condition, Number(edits.passRate) / 100);
    }
    for (const side of FEE_FIELDS) {
      const value = edits[`fee.${side}`];
      if (
        value !== undefined &&
        value.trim() !== '' &&
        Number(value) >= 0 &&
        Number(value) <= 100
      ) {
        next.fees = { ...next.fees, [side]: Math.round(Number(value) * 100) };
      }
    }
    if (edits.autonomy) {
      const mode = edits.autonomy as ProgramSpec['decisions']['autonomy']['mode'];
      next.decisions = { ...next.decisions, autonomy: { mode } };
    }
    return next;
  })();

  const publish = useAction(tenantId, {
    run: () =>
      api<Program>(`/tenants/${tenantId}/programs`, {
        body: { key, spec, note: note.trim() },
      }),
    done: (p) => `Published ${p.spec.name} v${p.version}`,
    onDone: (p) => onDone(p.key),
  });
  const set = (k: string) => (e: { target: { value: string } }) =>
    setEdits({ ...edits, [k]: e.target.value });
  const taken = !base && programs.some((p) => p.key === key);

  return (
    <Panel
      title={base ? `New version of ${base.spec.name}` : 'New program'}
      foot={
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={
              !spec || !key || taken || publish.isPending || !note.trim() || problems.length > 0
            }
            onClick={() => publish.mutate()}
          >
            Publish {base ? `v${base.version + 1}` : 'v1'}
          </button>
          {problems.length > 0 && <span className="error">Check: {problems.join(', ')}</span>}
          {taken && (
            <span className="error">
              A program called {key} exists. Publish a new version of it instead.
            </span>
          )}
        </div>
      }
    >
      <div className="panel-body">
        <div className="form-grid">
          {!base && (
            <>
              <label className="field">
                Start from
                <select
                  value={preset}
                  onChange={(e) => {
                    setPreset(e.target.value);
                    setEdits({});
                    if (!key) setKey(PRESET_KEYS[e.target.value] ?? e.target.value);
                  }}
                >
                  <option value="">Choose a preset</option>
                  {Object.entries(presets.data ?? {}).map(([k, p]) => (
                    <option key={k} value={k}>
                      {p.name ?? k}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Key
                <input
                  value={key}
                  onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                />
              </label>
              <span />
            </>
          )}
          {start && (
            <>
              <label className="field">
                Name
                <input value={edits.name ?? start.name} onChange={set('name')} />
              </label>
              <label className="field">
                Funding
                <select value={edits.funding ?? start.funding.mode} onChange={set('funding')}>
                  {Object.entries(FUNDING)
                    .filter(([k]) => k !== 'partial' || start.funding.mode === 'partial')
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </label>
              <label className="field">
                Netting
                <select value={edits.netting ?? start.settlement.netting} onChange={set('netting')}>
                  <option value="multilateral">Multilateral</option>
                  <option value="bilateral">Bilateral</option>
                  <option value="gross">Gross, one payment per deal</option>
                </select>
              </label>
              <label className="field">
                Rail
                <select value={edits.rail ?? start.settlement.rail} onChange={set('rail')}>
                  {[...new Set([start.settlement.rail, ...rails.map((r) => r.name)])].map((r) => (
                    <option key={r} value={r}>
                      {railName(r)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Settle every
                <input
                  placeholder={
                    start.settlement.timing.mode === 'cycle' ? start.settlement.timing.every : '1d'
                  }
                  value={edits.every ?? ''}
                  onChange={set('every')}
                />
              </label>
              {currencies.map((c) => (
                <label key={c} className="field">
                  AI may decide up to ({c})
                  <input
                    inputMode="decimal"
                    value={
                      edits[`ceiling.${c}`] ??
                      (start.decisions.ceiling[c] !== undefined
                        ? String(toMajor(String(start.decisions.ceiling[c]), c))
                        : '')
                    }
                    onChange={set(`ceiling.${c}`)}
                  />
                </label>
              ))}
              <label className="field">
                Add a ceiling currency
                <select
                  value=""
                  onChange={(e) => e.target.value && setAdded([...added, e.target.value])}
                >
                  <option value="">Choose</option>
                  {['EUR', 'GBP', 'USD', 'AUD', 'SGD', 'HKD', 'CNY', 'JPY']
                    .filter((c) => !currencies.includes(c))
                    .map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                </select>
              </label>
              {passRate !== null && (
                <label className="field">
                  Inspection must pass (%)
                  <input
                    inputMode="decimal"
                    value={edits.passRate ?? String(Math.round(passRate * 100))}
                    onChange={set('passRate')}
                  />
                </label>
              )}
              {FEE_FIELDS.map((side) => (
                <label key={side} className="field">
                  {FEE_LABELS[side].field}
                  <input
                    inputMode="decimal"
                    value={
                      edits[`fee.${side}`] ??
                      String((start.fees?.[side] ?? FEE_DEFAULTS[side]) / 100)
                    }
                    onChange={set(`fee.${side}`)}
                  />
                </label>
              ))}
              <label className="field">
                Autonomy
                <select
                  value={edits.autonomy ?? start.decisions.autonomy.mode}
                  onChange={set('autonomy')}
                >
                  <option value="fixed">The whole ceiling from the start</option>
                  <option value="earned">Earned from its track record</option>
                </select>
              </label>
            </>
          )}
        </div>
        {start && allChecks.length > 0 && (
          <fieldset className="checks-edit">
            <legend>What freezes a deal</legend>
            {allChecks.map((c) => (
              <label key={c.id} className="check-toggle">
                <input
                  type="checkbox"
                  checked={isOn(c.id)}
                  onChange={(e) =>
                    setEdits({ ...edits, [`check.${c.id}`]: e.target.checked ? 'on' : 'off' })
                  }
                />
                {c.reason}
              </label>
            ))}
          </fieldset>
        )}
        {start && (
          <label className="field" style={{ marginTop: 14 }}>
            Why
            <input
              required
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        )}
        {base && spec && (
          <div style={{ marginTop: 16 }}>
            <p className="muted" style={{ marginBottom: 6 }}>
              Changes
            </p>
            <Diff from={base.spec} to={spec} />
            <Preview decisions={spec.decisions} />
          </div>
        )}
      </div>
    </Panel>
  );
}

/** The pass mark of the program's inspection condition, wherever it sits in the release rules. */
function inspectionRate(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  if (n.type === 'inspection' && typeof n.minPassRate === 'number') return n.minPassRate;
  for (const child of [...((n.all as unknown[]) ?? []), ...((n.any as unknown[]) ?? [])]) {
    const found = inspectionRate(child);
    if (found !== null) return found;
  }
  return null;
}

function setInspectionRate(node: unknown, rate: number) {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'inspection') n.minPassRate = rate;
  for (const child of [...((n.all as unknown[]) ?? []), ...((n.any as unknown[]) ?? [])]) {
    setInspectionRate(child, rate);
  }
}

/**
 * Re-checks the decisions already made against the new limits before anything is published. It
 * replays the recorded choices through the same gate, so nothing changes and no model is called.
 */
function Preview({ decisions }: { decisions: ProgramSpecInput['decisions'] }) {
  const { tenantId } = useSession();
  const [runId, setRunId] = useState<string | null>(null);
  const start = useAction(tenantId, {
    run: () =>
      api<{ id: string }>(`/tenants/${tenantId}/shadow-runs`, {
        body: { candidate: { decisions } },
      }),
    onDone: (r) => setRunId(r.id),
  });
  const result = useQuery({
    queryKey: ['shadow', runId],
    queryFn: () => api<ShadowRunDetail>(`/tenants/${tenantId}/shadow-runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 1_000 : false),
  });
  const summary = result.data?.run.status === 'done' ? result.data.run.summary : null;
  return (
    <div className="preview">
      <button
        type="button"
        className="btn"
        disabled={start.isPending || result.data?.run.status === 'running'}
        onClick={() => start.mutate()}
      >
        Preview against past decisions
      </button>
      {runId && !summary && <span className="muted">Replaying…</span>}
      {summary && (
        <span>
          Of {summary.replayed} past decisions, {summary.changed} would now go differently,{' '}
          {summary.toPerson} of them to a person.
          {summary.wouldHaveFixed > 0 &&
            ` ${summary.wouldHaveFixed} of those turned out badly the first time.`}
        </span>
      )}
    </div>
  );
}
