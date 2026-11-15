import { useState } from 'react';
import { useAgentStatus } from '../agent-status.ts';
import { api, useAction } from '../api.ts';
import {
  currenciesOf,
  draftOf,
  type LimitDraft,
  LimitsEditor,
  LimitsView,
  toLimits,
  unlimitedIn,
} from '../limits.tsx';
import { useSession } from '../session.tsx';
import type { Agent } from '../types.ts';
import { Copy, EmptyRow, Panel, Pill, sentence, words } from '../ui.tsx';

export function AgentsPanel({ agents, only }: { agents: Agent[]; only?: string }) {
  const { memberName, me } = useSession();
  const [adding, setAdding] = useState(false);
  const shown = only ? agents.filter((a) => a.memberId === only) : agents;
  return (
    <Panel
      title="Agents"
      aside={
        only &&
        me.kind === 'platform' && (
          <button type="button" className="btn small" onClick={() => setAdding(!adding)}>
            Add agent
          </button>
        )
      }
    >
      {adding && only && <AddAgent memberId={only} onDone={() => setAdding(false)} />}
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            {!only && <th>Acts for</th>}
            <th>May</th>
            <th>Limits and use this month</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((a) => (
            <AgentRow key={a.id} agent={a} member={only ? undefined : memberName(a.memberId)} />
          ))}
          {!shown.length && <EmptyRow cols={only ? 5 : 6}>No agents yet.</EmptyRow>}
        </tbody>
      </table>
    </Panel>
  );
}

/** Creates the agent with its mandate, then issues its key, shown once. */
function AddAgent({ memberId, onDone }: { memberId: string; onDone: () => void }) {
  const { tenantId } = useSession();
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['buy']);
  const [currencyText, setCurrencyText] = useState('EUR');
  const [draft, setDraft] = useState<LimitDraft>({});
  const [categories, setCategories] = useState('');
  const [counterparties, setCounterparties] = useState<string[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const { members } = useSession();
  const currencies = [
    ...new Set(
      currencyText
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => /^[A-Z]{3}$/.test(c)),
    ),
  ];
  const missing = unlimitedIn(draft, currencies);
  const add = useAction(tenantId, {
    run: async () => {
      const cats = categories
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const mandate = {
        roles,
        limits: toLimits(draft, currencies),
        ...(cats.length ? { categories: cats } : {}),
        ...(counterparties.length ? { counterparties } : {}),
      };
      const agent = await api<{ id: string }>(`/tenants/${tenantId}/agents`, {
        body: { memberId, name, mandate },
      });
      return api<{ key: string }>(`/tenants/${tenantId}/keys`, {
        body: { name, principal: 'agent', memberId, agentId: agent.id },
      });
    },
    onDone: (r) => setKey(r.key),
  });
  if (key) {
    return (
      <div className="secret">
        Key for {name}, shown once: <span className="mono">{key}</span> <Copy text={key} />{' '}
        <button type="button" className="btn small ghost" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }
  return (
    <form
      className="form-inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && roles.length && currencies.length && !missing.length) add.mutate();
      }}
    >
      <label className="field">
        Agent name
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <fieldset className="field">
        May
        <span className="toolbar">
          {['buy', 'sell'].map((r) => (
            <label key={r} className="check-toggle">
              <input
                type="checkbox"
                checked={roles.includes(r)}
                onChange={(e) =>
                  setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))
                }
              />
              {sentence(r)}
            </label>
          ))}
        </span>
      </fieldset>
      <label className="field">
        Currencies
        <input value={currencyText} onChange={(e) => setCurrencyText(e.target.value)} />
      </label>
      <label className="field">
        Categories
        <input
          placeholder="Any"
          value={categories}
          onChange={(e) => setCategories(e.target.value)}
        />
      </label>
      <label className="field">
        Counterparties
        <select
          multiple
          value={counterparties}
          onChange={(e) => setCounterparties([...e.target.selectedOptions].map((o) => o.value))}
        >
          {members
            .filter((m) => m.id !== memberId)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
        </select>
      </label>
      <fieldset className="field">
        Limits in each currency
        <LimitsEditor currencies={currencies} draft={draft} onChange={setDraft} />
      </fieldset>
      <button
        type="submit"
        className="btn primary"
        disabled={add.isPending || !currencies.length || missing.length > 0}
        title={missing.length ? `Set a limit in ${missing.join(', ')}` : undefined}
      >
        Add agent and issue key
      </button>
    </form>
  );
}

function AgentRow({ agent, member }: { agent: Agent; member?: string }) {
  const { tenantId, me, memberName, canAct } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  const m = agent.mandate;
  const currencies = currenciesOf(m);
  const [draft, setDraft] = useState<LimitDraft>(() => draftOf(m));
  const removing = unlimitedIn(draft, currencies);
  const blocked = agent.status === 'blocked';
  const toggle = useAgentStatus(tenantId, agent, () => {
    setConfirming(false);
    setReason('');
  });
  const limits = useAction(tenantId, {
    run: () =>
      api(`/tenants/${tenantId}/agents/${agent.id}/mandate`, {
        method: 'PATCH',
        body: { mandate: { ...m, limits: toLimits(draft, currencies) }, reason: reason.trim() },
      }),
    done: `Limits changed for ${agent.name}`,
    onDone: () => {
      setEditing(false);
      setReason('');
    },
  });

  return (
    <tr>
      <td className="title-cell nowrap">{agent.name}</td>
      {member !== undefined && <td className="nowrap">{member}</td>}
      <td className="muted">
        {sentence(m.roles.map(words).join(' and ')) || '—'}
        {m.categories?.length ? `, ${m.categories.join(', ')}` : ''}
        {currencies.length ? ` in ${currencies.join(', ')}` : ''}
        {m.counterparties?.length ? (
          <small className="sub-line">
            With {m.counterparties.map((id) => memberName(id)).join(', ')} only
          </small>
        ) : null}
      </td>
      <td className="muted">
        {editing ? (
          <form
            className="limits-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim()) limits.mutate();
            }}
          >
            <LimitsEditor currencies={currencies} draft={draft} onChange={setDraft} />
            {removing.length > 0 && (
              <span className="sub-line error">
                No limit in {removing.join(', ')}: can't trade there
              </span>
            )}
            <input
              className="search"
              required
              placeholder="Why change them"
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <span className="confirm">
              <button
                type="submit"
                className="btn small primary"
                disabled={limits.isPending || !reason.trim()}
              >
                Save limits
              </button>
              <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </span>
          </form>
        ) : (
          <LimitsView agent={agent} />
        )}
      </td>
      <td>
        <Pill tone={blocked ? 'stop' : 'ok'}>{blocked ? 'Suspended' : 'Active'}</Pill>
      </td>
      <td className="num">
        {confirming ? (
          <span className="confirm">
            <input
              className="search"
              placeholder="Reason"
              aria-label={`Reason to ${blocked ? 'reinstate' : 'suspend'} ${agent.name}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="button"
              className={`btn small${blocked ? '' : ' danger'}`}
              disabled={toggle.isPending || !reason.trim()}
              onClick={() => toggle.mutate(reason.trim())}
            >
              {blocked ? 'Reinstate' : 'Suspend'}
            </button>
            <button type="button" className="btn small ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </span>
        ) : (
          canAct &&
          !editing && (
            <span className="confirm">
              {me.kind === 'platform' && (
                <button
                  type="button"
                  className="btn small ghost"
                  onClick={() => {
                    setDraft(draftOf(m));
                    setEditing(true);
                  }}
                >
                  Edit limits
                </button>
              )}
              <button
                type="button"
                className={`btn small${blocked ? '' : ' danger'}`}
                onClick={() => setConfirming(true)}
              >
                {blocked ? 'Reinstate…' : 'Suspend…'}
              </button>
            </span>
          )
        )}
      </td>
    </tr>
  );
}
