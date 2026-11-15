import { useState } from 'react';
import { api, useAction } from '../api.ts';
import { useSession } from '../session.tsx';
import type { Exposure, Rail } from '../types.ts';
import { Panel, railName } from '../ui.tsx';

type MemberRow = Exposure['members'][number];

/** Where Airwallex opens Global Accounts in each currency; any other is typed in. */
const ACCOUNT_COUNTRIES: Record<string, string[]> = {
  EUR: ['DK', 'EE', 'HK', 'DE', 'NL', 'FR'],
  GBP: ['GB'],
  USD: ['US', 'HK'],
  AUD: ['AU'],
};
export const CURRENCIES = ['EUR', 'GBP', 'USD', 'AUD', 'SGD', 'HKD', 'CNY', 'JPY'];
/** Without an IBAN, these countries route a local payment by a second number. */
const ROUTING: Record<string, { type: string; label: string }> = {
  GB: { type: 'sort_code', label: 'Sort code' },
  US: { type: 'aba', label: 'Routing number' },
  AU: { type: 'bsb', label: 'BSB' },
};

const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code: string) => {
  try {
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
};
const isIban = (s: string) => /^[A-Z]{2}\d{2}[A-Z0-9]{8,}$/.test(s);
const compact = (s: string) => s.replace(/\s+/g, '').toUpperCase();

/** The rails the house can open this member's accounts on: those taking a payee, not yet used. */
export function openableRails(rails: Rail[], row: MemberRow) {
  return rails.filter(
    (r) =>
      r.opensAccounts === 'beneficiary' &&
      !row.depositAccounts.some((a) => a.rail === r.name) &&
      row.payoutAccount?.rail !== r.name,
  );
}

/** Open a member's deposit account and payee on a rail, in pooled custody. */
type Method = 'LOCAL' | 'SWIFT';

/** Where a member is paid, as a house person types it. */
export type Payee = ReturnType<typeof payeeDefaults>;

export const payeeDefaults = (row: MemberRow, currency: string) => {
  const company = row.legalName ?? row.name;
  return {
    companyName: company,
    addressCountry: row.country ?? '',
    city: '',
    street: '',
    postcode: '',
    accountCurrency: currency,
    accountName: company,
    bankCountry: row.country ?? '',
    account: '',
    routing: '',
    swift: '',
  };
};

/** The bank account in a payee: an IBAN carries its own country and needs no routing number. */
function bankOf(p: Payee) {
  const account = compact(p.account);
  const iban = isIban(account);
  const bankCountry = iban ? account.slice(0, 2) : p.bankCountry.trim().toUpperCase();
  return { account, iban, bankCountry, routing: iban ? undefined : ROUTING[bankCountry] };
}

/** An Airwallex beneficiary for a company. */
export function beneficiaryOf(p: Payee) {
  const { account, iban, bankCountry, routing } = bankOf(p);
  return {
    entity_type: 'COMPANY',
    company_name: p.companyName.trim(),
    address: {
      country_code: p.addressCountry.trim().toUpperCase(),
      city: p.city.trim(),
      street_address: p.street.trim(),
      postcode: p.postcode.trim(),
    },
    bank_details: {
      account_currency: p.accountCurrency,
      account_name: p.accountName.trim(),
      bank_country_code: bankCountry,
      ...(iban ? { iban: account } : { account_number: account }),
      ...(routing && p.routing.trim()
        ? { account_routing_type1: routing.type, account_routing_value1: compact(p.routing) }
        : {}),
      ...(p.swift.trim() ? { swift_code: compact(p.swift) } : {}),
    },
  };
}

export function PayeeFields({
  payee,
  onChange,
  currency,
  method,
}: {
  payee: Payee;
  onChange: (p: Payee) => void;
  currency: string;
  method: Method;
}) {
  const set = (k: keyof Payee) => (e: { target: { value: string } }) =>
    onChange({ ...payee, [k]: e.target.value });
  const { iban, routing } = bankOf(payee);
  return (
    <div className="form-grid">
      <label className="field">
        Company name
        <input required value={payee.companyName} onChange={set('companyName')} />
      </label>
      <label className="field">
        Account name
        <input required value={payee.accountName} onChange={set('accountName')} />
      </label>
      <label className="field">
        Account currency
        <select value={payee.accountCurrency} onChange={set('accountCurrency')}>
          {[...new Set([currency, ...CURRENCIES])].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        IBAN or account number
        <input required value={payee.account} onChange={set('account')} />
      </label>
      {!iban && (
        <label className="field">
          Bank country
          <input
            required
            maxLength={2}
            pattern="[A-Za-z]{2}"
            value={payee.bankCountry}
            onChange={set('bankCountry')}
          />
        </label>
      )}
      {routing && (
        <label className="field">
          {routing.label}
          <input required value={payee.routing} onChange={set('routing')} />
        </label>
      )}
      <label className="field">
        SWIFT/BIC
        <input
          required={method === 'SWIFT'}
          pattern="[A-Za-z0-9 ]{8,13}"
          value={payee.swift}
          onChange={set('swift')}
        />
      </label>
      <label className="field">
        Street
        <input required value={payee.street} onChange={set('street')} />
      </label>
      <label className="field">
        City
        <input required value={payee.city} onChange={set('city')} />
      </label>
      <label className="field">
        Postcode
        <input required value={payee.postcode} onChange={set('postcode')} />
      </label>
      <label className="field">
        Country
        <input
          required
          maxLength={2}
          pattern="[A-Za-z]{2}"
          value={payee.addressCountry}
          onChange={set('addressCountry')}
        />
      </label>
    </div>
  );
}

export function OpenAccounts({
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
  const [form, setForm] = useState({
    rail: rails[0]?.name ?? '',
    currency: row.homeCurrency,
    country: ACCOUNT_COUNTRIES[row.homeCurrency]?.[0] ?? row.country ?? '',
    method: 'LOCAL' as Method,
  });
  const [payee, setPayee] = useState(() => payeeDefaults(row, row.homeCurrency));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  const countries = ACCOUNT_COUNTRIES[form.currency];

  const open = useAction(tenantId, {
    run: () =>
      api(`/tenants/${tenantId}/members/${row.memberId}/provision`, {
        body: {
          rail: form.rail,
          currency: form.currency,
          countryCode: form.country.trim().toUpperCase(),
          transferMethods: [form.method],
          idempotencyKey: key,
          beneficiary: beneficiaryOf(payee),
        },
      }),
    done: `Accounts opened for ${row.name}`,
    onDone: onClose,
    // The engine replays a failed attempt under the same key, so trying again needs a new one.
    onError: () => setKey(crypto.randomUUID()),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        open.mutate();
      }}
    >
      <Panel
        title="Open accounts"
        foot={
          <div className="actions">
            {open.error && <span className="error">{open.error.message}</span>}
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={open.isPending || !form.rail}>
              {open.isPending ? 'Opening…' : 'Open accounts'}
            </button>
          </div>
        }
      >
        <div className="panel-body">
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
              <select
                value={form.currency}
                onChange={(e) => {
                  const currency = e.target.value;
                  const list = ACCOUNT_COUNTRIES[currency];
                  setForm({
                    ...form,
                    currency,
                    country: list?.[0] ?? row.country ?? '',
                  });
                  setPayee({ ...payee, accountCurrency: currency });
                }}
              >
                {[...new Set([row.homeCurrency, ...CURRENCIES])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            {countries ? (
              <label className="field">
                Account country
                <select value={form.country} onChange={set('country')}>
                  {countries.map((c) => (
                    <option key={c} value={c}>
                      {countryName(c)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                Account country
                <input
                  required
                  maxLength={2}
                  pattern="[A-Za-z]{2}"
                  value={form.country}
                  onChange={set('country')}
                />
              </label>
            )}
            <label className="field">
              Payout method
              <select value={form.method} onChange={set('method')}>
                <option value="LOCAL">Local</option>
                <option value="SWIFT">SWIFT</option>
              </select>
            </label>
          </div>
          <h3 className="form-section">Payee</h3>
          <PayeeFields
            payee={payee}
            onChange={setPayee}
            currency={form.currency}
            method={form.method}
          />
        </div>
      </Panel>
    </form>
  );
}
