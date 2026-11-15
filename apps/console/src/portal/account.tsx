// The member's account: what it holds, how to pay in and out, its withdrawals and its agents.
import { type FormEvent, useState } from 'react';
import { useAgentStatus } from '../agent-status.ts';
import { api, isPending, type Page, useAction, usePaged, useTenant } from '../api.ts';
import { DecideApproval } from '../approvals.tsx';
import { APPROVAL_KINDS } from '../describe.tsx';
import { currenciesOf, LimitsView } from '../limits.tsx';
import { PayInPayOut } from '../pay-details.tsx';
import { StatementPanel } from '../statement.tsx';
import type { Agent, Approval, Me, MemberUser, MemberWithdrawal, Statement } from '../types.ts';
import {
  Amounts,
  actorName,
  dateTime,
  EmptyRow,
  formatMajor,
  Kpi,
  LoadFailed,
  Money,
  PAYOUT_STATUS,
  PageHead,
  Panel,
  PayoutStatus,
  Pill,
  parseMinor,
  sentence,
  type Tone,
  until,
} from '../ui.tsx';
import { useMyAccount } from './my.ts';
import { Holds } from './standing.tsx';

export function Account({ me }: { me: Me }) {
  const memberId = me.memberId as string;
  const now = useTenant<Statement>(me.tenantId, `/members/${memberId}/statement`, { live: true });
  const account = useMyAccount(me);
  const closing = now.data?.closingBalance ?? [];
  const [withdrawing, setWithdrawing] = useState(false);
  const held = account.data?.holds.withdrawals ?? null;
  const calls = account.data?.marginCalls ?? [];
  return (
    <>
      <PageHead
        title="Account"
        lede={<Holds me={me} />}
        actions={
          <button
            type="button"
            className="btn"
            disabled={held !== null}
            onClick={() => setWithdrawing(!withdrawing)}
          >
            Withdraw…
          </button>
        }
      />
      <div className="kpis">
        <Kpi
          label="Free to use"
          figure={
            <Amounts
              list={closing.map((b) => ({ currency: b.currency, amount: b.available }))}
              empty="0.00"
              zeros
            />
          }
        />
        <Kpi
          label="Held for deals and margin"
          figure={
            <Amounts
              list={closing.map((b) => ({
                currency: b.currency,
                amount: BigInt(b.amount) - BigInt(b.available),
              }))}
              empty="0.00"
              zeros
            />
          }
        />
        <Kpi label="Open deals" figure={account.data?.openDeals ?? '—'} />
        {calls.map((c) => (
          <Kpi
            key={c.id}
            label="Margin call"
            tone="alert"
            figure={<Money value={c.amount} currency={c.currency} />}
            note={until(c.dueAt).text}
          />
        ))}
      </div>
      <div className="stack">
        <MemberApprovals me={me} />
        {withdrawing && held === null && (
          <Withdraw
            me={me}
            free={closing
              .map((b) => ({ currency: b.currency, amount: BigInt(b.available) }))
              .filter((b) => b.amount > 0n)}
            onDone={() => setWithdrawing(false)}
          />
        )}
        <AccountDetails me={me} />
        <Withdrawals me={me} />
        <WithdrawalLimits me={me} />
        <MyAgents me={me} />
        <People me={me} />
        <StatementPanel
          tenantId={me.tenantId}
          memberId={memberId}
          name={account.data?.name ?? 'member'}
        />
      </div>
    </>
  );
}

/** Money only leaves to the payout account the house has on record, never one typed here. */
function Withdraw({
  me,
  free,
  onDone,
}: {
  me: Me;
  free: { currency: string; amount: bigint }[];
  onDone: () => void;
}) {
  const account = useMyAccount(me);
  const [currency, setCurrency] = useState(free[0]?.currency ?? '');
  const [amount, setAmount] = useState('');
  const [confirming, setConfirming] = useState(false);
  // One key per form, so a double click or a retry cannot send the money twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const available = free.find((f) => f.currency === currency)?.amount ?? 0n;
  const minor = currency ? parseMinor(amount, currency) : null;
  const invalid = minor === null || minor <= 0n || minor > available;
  const send = useAction(me.tenantId, {
    run: () =>
      api(`/tenants/${me.tenantId}/members/${me.memberId}/withdrawals`, {
        body: { currency, amount: String(minor), idempotencyKey },
      }),
    done: (r) => (isPending(r) ? 'Waiting for a second approval' : 'Withdrawal requested'),
    onDone,
    onError: () => setConfirming(false),
  });
  const payee = account.data?.payoutAccount?.label;
  if (!free.length)
    return (
      <Panel title="Withdraw">
        <p className="panel-body muted">Nothing free to withdraw.</p>
      </Panel>
    );
  return (
    <Panel title="Withdraw">
      <form
        className="form-inline"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (invalid) return;
          if (!confirming) setConfirming(true);
          else send.mutate();
        }}
      >
        <label className="field">
          Currency
          <select
            value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
              setConfirming(false);
            }}
          >
            {free.map((f) => (
              <option key={f.currency}>{f.currency}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Amount (free: <Money value={available} currency={currency} />)
          <input
            inputMode="decimal"
            required
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setConfirming(false);
            }}
          />
        </label>
        {confirming && minor !== null ? (
          <>
            <span>
              Send <Money value={minor} currency={currency} /> to {payee ?? 'your payout account'}?
            </span>
            <button type="submit" className="btn primary" disabled={send.isPending}>
              Confirm
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              Back
            </button>
          </>
        ) : (
          <button type="submit" className="btn primary" disabled={invalid}>
            Withdraw
          </button>
        )}
        {amount && minor !== null && minor > available && (
          <span className="error">More than is free</span>
        )}
      </form>
    </Panel>
  );
}

/** Where to send money in, and where money goes out: what a treasurer looks up most. */
function AccountDetails({ me }: { me: Me }) {
  const account = useMyAccount(me);
  const a = account.data;
  if (!a) return null;
  return (
    <Panel title="Pay in and pay out">
      <PayInPayOut accounts={a} />
    </Panel>
  );
}

/** A member hears about a payment with no answer in its own terms. */
const WITHDRAWAL = {
  ...PAYOUT_STATUS,
  in_doubt: ['Waiting for the bank', 'wait'],
} satisfies Record<string, [string, Tone]>;

function Withdrawals({ me }: { me: Me }) {
  const list = usePaged<MemberWithdrawal>(
    `/tenants/${me.tenantId}/members/${me.memberId}/withdrawals`,
  );
  const rows = list.rows ?? [];
  return (
    <Panel title="Withdrawals">
      {list.error && !list.rows ? (
        <LoadFailed error={list.error} />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Asked</th>
              <th>Status</th>
              <th>Reference</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td className="nowrap">{dateTime(w.at)}</td>
                <td>
                  <PayoutStatus status={w.status} labels={WITHDRAWAL} />
                  {w.paidAt && <small className="sub-line faint">Paid {dateTime(w.paidAt)}</small>}
                  {w.failureReason && <small className="sub-line error">{w.failureReason}</small>}
                  {w.returnedToWallet && <small className="sub-line">Back in your balance</small>}
                </td>
                <td className="mono muted">{w.externalRef ?? '—'}</td>
                <td className="num">
                  <Money value={w.amount} currency={w.currency} />
                </td>
              </tr>
            ))}
            {list.rows && !rows.length && <EmptyRow cols={4}>No withdrawals.</EmptyRow>}
            {!list.rows && <EmptyRow cols={4}>Loading…</EmptyRow>}
          </tbody>
        </table>
      )}
      {list.more && (
        <div className="panel-foot">
          <button
            type="button"
            className="btn small"
            disabled={list.loadingMore}
            onClick={list.more}
          >
            {list.loadingMore ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </Panel>
  );
}

/** Requests the member's own people made that wait for a second of them. */
function MemberApprovals({ me }: { me: Me }) {
  const list = useTenant<Page<Approval>>(me.tenantId, '/approvals', { live: true });
  const rows = list.data?.rows ?? [];
  if (!rows.length) return null;
  return (
    <Panel title="Waiting for approval" sub={String(rows.length)}>
      <table>
        <tbody>
          {rows.map((a) => (
            <tr key={a.approvalId}>
              <td className="title-cell">
                {APPROVAL_KINDS[a.kind] ?? sentence(a.kind)}
                <small>
                  {actorName(a.requestedBy)}, {dateTime(a.requestedAt)}: {a.reason}
                </small>
                <LimitsChange a={a} />
              </td>
              <td className="num">
                {a.amount && a.currency ? <Money value={a.amount} currency={a.currency} /> : null}
              </td>
              <td className="muted nowrap">{until(a.expiresAt).text}</td>
              <td className="num">
                <DecideApproval a={a} tenantId={me.tenantId} me={me} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

const limitsText = (limits: Record<string, string>) =>
  Object.entries(limits)
    .map(([c, v]) => `${formatMajor(v, c)} ${c}`)
    .join(', ') || 'none';

function LimitsChange({ a }: { a: Approval }) {
  if (a.kind !== 'member_controls') return null;
  const p = a.payload as { before: Record<string, string>; after: Record<string, string> };
  return (
    <small className="sub-line">
      {limitsText(p.before)} → {limitsText(p.after)}
    </small>
  );
}

/**
 * Above these amounts a withdrawal waits for a second of the member's people. Lowering or adding
 * one applies at once; raising or removing one waits for a second person too.
 */
function WithdrawalLimits({ me }: { me: Me }) {
  const account = useMyAccount(me);
  const [editing, setEditing] = useState(false);
  const limits = account.data?.withdrawalFourEyesAbove ?? {};
  return (
    <Panel
      title="Withdrawal approval"
      aside={
        !editing && (
          <button type="button" className="btn small" onClick={() => setEditing(true)}>
            Change…
          </button>
        )
      }
    >
      {editing ? (
        <LimitsForm
          me={me}
          limits={limits}
          currencies={account.data?.homeCurrency ? [account.data.homeCurrency] : []}
          onDone={() => setEditing(false)}
        />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Currency</th>
              <th className="num">Second approval above</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(limits).map(([c, v]) => (
              <tr key={c}>
                <td>{c}</td>
                <td className="num">
                  <Money value={v} currency={c} />
                </td>
              </tr>
            ))}
            {!Object.keys(limits).length && <EmptyRow cols={2}>Off</EmptyRow>}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function LimitsForm({
  me,
  limits,
  currencies,
  onDone,
}: {
  me: Me;
  limits: Record<string, string>;
  currencies: string[];
  onDone: () => void;
}) {
  const shown = [...new Set([...Object.keys(limits), ...currencies])];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(shown.map((c) => [c, limits[c] ? formatMajor(limits[c], c) : ''])),
  );
  const [added, setAdded] = useState('');
  const [reason, setReason] = useState('');
  const parsed = Object.entries(values)
    .filter(([, v]) => v.trim())
    .map(([c, v]) => [c, parseMinor(v, c)] as const);
  const invalid = parsed.some(([, v]) => v === null);
  const save = useAction(me.tenantId, {
    run: () =>
      api(`/tenants/${me.tenantId}/members/${me.memberId}/controls`, {
        method: 'PUT',
        body: {
          withdrawalFourEyesAbove: Object.fromEntries(parsed.map(([c, v]) => [c, String(v)])),
          reason: reason.trim(),
        },
      }),
    done: (r) =>
      isPending(r)
        ? 'Waiting for a second approval'
        : (r as { status: string }).status === 'unchanged'
          ? 'Unchanged'
          : 'Saved',
    onDone,
  });
  return (
    <form
      className="form-inline panel-body"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) save.mutate();
      }}
    >
      {Object.keys(values).map((c) => (
        <label key={c} className="field">
          {c}
          <input
            inputMode="decimal"
            placeholder="Off"
            value={values[c]}
            onChange={(e) => setValues({ ...values, [c]: e.target.value })}
          />
        </label>
      ))}
      <label className="field">
        Add currency
        <input
          maxLength={3}
          value={added}
          onChange={(e) => setAdded(e.target.value.toUpperCase())}
        />
      </label>
      <button
        type="button"
        className="btn small"
        disabled={!/^[A-Z]{3}$/.test(added) || added in values}
        onClick={() => {
          setValues({ ...values, [added]: '' });
          setAdded('');
        }}
      >
        Add
      </button>
      <label className="field">
        Reason
        <input required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={save.isPending || invalid || !reason.trim()}
      >
        Save
      </button>
      <button type="button" className="btn ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

/** Who at the member can sign in. Read only: the platform manages them. */
function People({ me }: { me: Me }) {
  const users = useTenant<MemberUser[]>(me.tenantId, `/members/${me.memberId}/users`);
  return (
    <Panel title="People">
      {users.error && !users.data ? (
        <LoadFailed error={users.error} />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Two-step</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {(users.data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="title-cell">
                  {u.name}
                  <small>{u.email}</small>
                </td>
                <td>
                  <Pill tone={u.status === 'active' ? 'ok' : u.status === 'invited' ? 'wait' : ''}>
                    {sentence(u.status)}
                  </Pill>
                  {u.inviteExpiresAt && (
                    <small className="sub-line faint">
                      Invite expires {dateTime(u.inviteExpiresAt)}
                    </small>
                  )}
                </td>
                <td>{u.mfa ? 'On' : 'Off'}</td>
                <td className="muted nowrap">{u.lastLoginAt ? dateTime(u.lastLoginAt) : '—'}</td>
              </tr>
            ))}
            {users.data && !users.data.length && <EmptyRow cols={4}>Nobody yet.</EmptyRow>}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/** The member's own trading agents: what each may do and how much of its limit it has used. */
function MyAgents({ me }: { me: Me }) {
  const agents = useTenant<Agent[]>(me.tenantId, `/members/${me.memberId}/agents`);
  if (!agents.data?.length) return null;
  return (
    <Panel title="Your agents">
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>May</th>
            <th>Limits and use this month</th>
            <th>Key last used</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {agents.data.map((a) => (
            <tr key={a.id}>
              <td className="title-cell">{a.name}</td>
              <td className="muted">
                {sentence(a.mandate.roles.join(' and '))} in {currenciesOf(a.mandate).join(', ')}
              </td>
              <td className="muted">
                <LimitsView agent={a} />
              </td>
              <td className="muted nowrap">
                {a.keyLastUsedAt ? dateTime(a.keyLastUsedAt) : 'Never'}
              </td>
              <td>
                <Pill tone={a.status === 'blocked' ? 'stop' : 'ok'}>
                  {a.status === 'blocked' ? 'Suspended' : 'Active'}
                </Pill>
              </td>
              <td className="num">
                {a.status !== 'blocked' && <SuspendAgent me={me} agent={a} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function SuspendAgent({ me, agent }: { me: Me; agent: Agent }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const stop = useAgentStatus(me.tenantId, agent, () => setAsking(false));
  if (!asking)
    return (
      <button type="button" className="btn small danger" onClick={() => setAsking(true)}>
        Suspend…
      </button>
    );
  return (
    <form
      className="confirm"
      onSubmit={(e) => {
        e.preventDefault();
        stop.mutate(reason.trim());
      }}
    >
      <input
        className="search"
        required
        placeholder="Reason"
        aria-label={`Reason to suspend ${agent.name}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        type="submit"
        className="btn small danger"
        disabled={stop.isPending || !reason.trim()}
      >
        Suspend
      </button>
      <button type="button" className="btn small ghost" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </form>
  );
}
