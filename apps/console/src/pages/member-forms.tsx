// What the house and the platform change on a member: who it is, where it is paid, money credited
// by hand and its part of the default fund.
import { type ReactNode, useState } from 'react';
import { api, isPending, type Pending, useAction } from '../api.ts';
import { useSession } from '../session.tsx';
import type { Exposure, Rail } from '../types.ts';
import { Panel, parseMinor, railName } from '../ui.tsx';
import { beneficiaryOf, CURRENCIES, PayeeFields, payeeDefaults } from './open-accounts.tsx';

type MemberRow = Exposure['members'][number];

/** Rails where this member is paid to a payee the house can replace. */
export const payeeRails = (rails: Rail[], row: MemberRow) =>
  rails.filter((r) => r.opensAccounts === 'beneficiary' && row.payoutAccount?.rail === r.name);

function FormPanel({
  title,
  error,
  busy,
  submit,
  disabled,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  error: Error | null;
  busy: boolean;
  submit: string;
  disabled?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <Panel
        title={title}
        foot={
          <div className="actions">
            {error && <span className="error">{error.message}</span>}
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy || disabled}>
              {submit}
            </button>
          </div>
        }
      >
        <div className="panel-body">{children}</div>
      </Panel>
    </form>
  );
}

/** A new payee on the rail; paying it waits for a second house person. */
export function ChangePayout({
  row,
  rails,
  onClose,
}: {
  row: MemberRow;
  rails: Rail[];
  onClose: () => void;
}) {
  const { tenantId } = useSession();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [rail, setRail] = useState(rails[0]?.name ?? '');
  const [method, setMethod] = useState<'LOCAL' | 'SWIFT'>('LOCAL');
  const currency = row.payoutAccount?.currency ?? row.homeCurrency;
  const [payee, setPayee] = useState(() => payeeDefaults(row, currency));
  const [reason, setReason] = useState('');
  const change = useAction(tenantId, {
    run: () =>
      api<Pending | { status: 'unchanged' }>(`/tenants/${tenantId}/members/${row.memberId}/payee`, {
        body: {
          rail,
          transferMethods: [method],
          beneficiary: beneficiaryOf(payee),
          idempotencyKey: key,
          reason: reason.trim(),
        },
      }),
    done: (r) => (isPending(r) ? 'Sent for approval' : 'Unchanged'),
    onDone: onClose,
    // The engine replays a failed attempt under the same key, so trying again needs a new one.
    onError: () => setKey(crypto.randomUUID()),
  });
  return (
    <FormPanel
      title="Change payout details"
      error={change.error}
      busy={change.isPending}
      submit={change.isPending ? 'Sending…' : 'Send for approval'}
      disabled={!rail || !reason.trim()}
      onSubmit={() => change.mutate()}
      onClose={onClose}
    >
      <div className="form-grid">
        <label className="field">
          Rail
          <select required value={rail} onChange={(e) => setRail(e.target.value)}>
            {rails.map((r) => (
              <option key={r.name} value={r.name}>
                {railName(r.name)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Payout method
          <select value={method} onChange={(e) => setMethod(e.target.value as 'LOCAL' | 'SWIFT')}>
            <option value="LOCAL">Local</option>
            <option value="SWIFT">SWIFT</option>
          </select>
        </label>
        <label className="field">
          Reason
          <input required value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      <h3 className="form-section">Payee</h3>
      <PayeeFields payee={payee} onChange={setPayee} currency={currency} method={method} />
    </FormPanel>
  );
}

/** What the platform recorded about the business. */
export function EditMember({ row, onClose }: { row: MemberRow; onClose: () => void }) {
  const { tenantId } = useSession();
  const [form, setForm] = useState({
    name: row.name,
    legalName: row.legalName ?? '',
    country: row.country ?? '',
    contactEmail: row.contactEmail ?? '',
    reason: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  // Only what changed is sent; a field left empty that had nothing stays unset.
  const changed = Object.fromEntries(
    (['name', 'legalName', 'country', 'contactEmail'] as const)
      .map((k) => [k, form[k].trim()] as const)
      .filter(([k, v]) => v && v !== (row[k] ?? '')),
  );
  const save = useAction(tenantId, {
    run: () =>
      api(`/tenants/${tenantId}/members/${row.memberId}`, {
        method: 'PATCH',
        body: { ...changed, ...(form.reason.trim() ? { reason: form.reason.trim() } : {}) },
      }),
    done: 'Saved',
    onDone: onClose,
  });
  return (
    <form
      className="form-inline"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="field">
        Name
        <input required value={form.name} onChange={set('name')} />
      </label>
      <label className="field">
        Legal name
        <input value={form.legalName} onChange={set('legalName')} />
      </label>
      <label className="field">
        Country
        <input maxLength={2} pattern="[A-Za-z]{2}" value={form.country} onChange={set('country')} />
      </label>
      <label className="field">
        Contact email
        <input type="email" value={form.contactEmail} onChange={set('contactEmail')} />
      </label>
      <label className="field">
        Reason
        <input value={form.reason} onChange={set('reason')} />
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={save.isPending || !Object.keys(changed).length}
      >
        Save
      </button>
      <button type="button" className="btn ghost" onClick={onClose}>
        Cancel
      </button>
      {save.error && <span className="error">{save.error.message}</span>}
    </form>
  );
}

const currenciesFor = (row: MemberRow) => [
  ...new Set([row.homeCurrency, ...row.currencies.map((c) => c.currency), ...CURRENCIES]),
];

/** Money a rail delivered that novate never heard of, credited by hand. */
export function CreditMember({ row, onClose }: { row: MemberRow; onClose: () => void }) {
  const { tenantId, rails } = useSession();
  const [form, setForm] = useState({
    rail: row.depositAccounts[0]?.rail ?? rails[0]?.name ?? '',
    currency: row.homeCurrency,
    amount: '',
    externalRef: '',
    reason: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const minor = parseMinor(form.amount, form.currency);
  const credit = useAction(tenantId, {
    run: () =>
      api<Pending | { status: 'credited' }>(`/tenants/${tenantId}/deposits`, {
        body: {
          memberId: row.memberId,
          rail: form.rail,
          currency: form.currency,
          amount: String(minor),
          externalRef: form.externalRef.trim(),
          reason: form.reason.trim(),
        },
      }),
    done: (r) => (isPending(r) ? 'Sent for approval' : `Credited to ${row.name}`),
    onDone: onClose,
  });
  return (
    <FormPanel
      title="Credit member"
      error={credit.error}
      busy={credit.isPending}
      submit={credit.isPending ? 'Crediting…' : 'Credit'}
      disabled={minor === null || minor <= 0n || !form.reason.trim()}
      onSubmit={() => credit.mutate()}
      onClose={onClose}
    >
      <div className="form-grid">
        <label className="field">
          Rail
          <select required value={form.rail} onChange={set('rail')}>
            {rails.map((r) => (
              <option key={r.name} value={r.name}>
                {railName(r.name)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Currency
          <select value={form.currency} onChange={set('currency')}>
            {currenciesFor(row).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Amount
          <input inputMode="decimal" required value={form.amount} onChange={set('amount')} />
        </label>
        <label className="field">
          External reference
          <input required value={form.externalRef} onChange={set('externalRef')} />
        </label>
        <label className="field">
          Reason
          <input required value={form.reason} onChange={set('reason')} />
        </label>
      </div>
    </FormPanel>
  );
}

/** A member's money into the default fund, or back out to its wallet. */
export function MoveDefaultFund({
  direction,
  currencies,
  onClose,
}: {
  direction: 'contribute' | 'withdraw';
  currencies: string[];
  onClose: () => void;
}) {
  const { tenantId, members } = useSession();
  const [form, setForm] = useState({
    memberId: '',
    currency: currencies[0] ?? '',
    amount: '',
    reason: '',
  });
  // One key per attempt, so a double click cannot move the money twice.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const minor = form.currency ? parseMinor(form.amount, form.currency) : null;
  const move = useAction(tenantId, {
    run: () =>
      api(
        `/tenants/${tenantId}/default-fund/${direction === 'contribute' ? 'contributions' : 'withdrawals'}`,
        {
          body: {
            memberId: form.memberId,
            currency: form.currency,
            amount: String(minor),
            idempotencyKey: key,
            reason: form.reason.trim(),
          },
        },
      ),
    done: direction === 'contribute' ? 'Put in the default fund' : 'Taken out of the default fund',
    onDone: onClose,
    onError: () => setKey(crypto.randomUUID()),
  });
  return (
    <form
      className="form-inline"
      onSubmit={(e) => {
        e.preventDefault();
        move.mutate();
      }}
    >
      <label className="field">
        Member
        <select required value={form.memberId} onChange={set('memberId')}>
          <option value="">Choose a member</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Currency
        <select value={form.currency} onChange={set('currency')}>
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Amount
        <input inputMode="decimal" required value={form.amount} onChange={set('amount')} />
      </label>
      <label className="field">
        Reason
        <input required value={form.reason} onChange={set('reason')} />
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={
          move.isPending || !form.memberId || minor === null || minor <= 0n || !form.reason.trim()
        }
      >
        {direction === 'contribute' ? 'Put in' : 'Take out'}
      </button>
      <button type="button" className="btn ghost" onClick={onClose}>
        Cancel
      </button>
      {move.error && <span className="error">{move.error.message}</span>}
    </form>
  );
}
