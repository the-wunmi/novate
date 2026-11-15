import { Currency } from '@novate/core';
import { z } from 'zod';

/**
 * What provisioning records about a member's accounts on a rail, beside the ids that move money.
 * Rail refs are strings, so the details travel as JSON under their own key.
 */
const DEPOSIT_ACCOUNT = '_deposit_account';
const ACCOUNT = '_account';

export const RefKeys = {
  /** The account money from the member arrives in. Decides whose deposit it is. */
  depositAccount: (rail: string) => `${rail}${DEPOSIT_ACCOUNT}`,
  /** How to pay into that account, as `DepositDetails` in JSON. */
  depositDetails: (rail: string) => `${rail}_deposit_details`,
  /** Where the member is paid: a payee in pooled custody. */
  beneficiary: (rail: string) => `${rail}_beneficiary`,
  /** The member's own account on the rail: connected custody, or a wallet address. */
  account: (rail: string) => `${rail}${ACCOUNT}`,
  /** A masked description of where payouts go, such as "ABNANL2A ••••4300". */
  payoutLabel: (rail: string) => `${rail}_payout_label`,
  payoutCurrency: (rail: string) => `${rail}_payout_currency`,
} as const;

/**
 * Refs that decide whose money moves, on any rail. Two members holding the same one would let one
 * impersonate the other.
 */
export const isIdentityRefKey = (key: string) =>
  key.endsWith(DEPOSIT_ACCOUNT) || key.endsWith(ACCOUNT);

/** Bank details a payer needs to send money to a member's deposit account. None of it is secret. */
export const DepositDetails = z.strictObject({
  currency: Currency,
  accountName: z.string().nullable(),
  accountNumber: z.string().nullable(),
  iban: z.string().nullable(),
  swiftCode: z.string().nullable(),
  /** Sort code, ABA routing number, BSB and so on, as the rail names them. */
  routing: z.array(z.strictObject({ type: z.string(), value: z.string() })),
  bankName: z.string().nullable(),
  countryCode: z.string().nullable(),
});
export type DepositDetails = z.infer<typeof DepositDetails>;

/**
 * The refs a rail records when it opens a member's deposit account and payee: the ids, the deposit
 * details beside the account they describe, and a masked note of where payouts go.
 */
export function provisionRefs(
  rail: string,
  opened: {
    depositAccount: string;
    details: DepositDetails;
    beneficiary: string;
    payee: Record<string, unknown> | undefined;
  },
): Record<string, string> {
  return {
    [RefKeys.depositAccount(rail)]: opened.depositAccount,
    [RefKeys.depositDetails(rail)]: JSON.stringify(opened.details),
    ...payeeRefs(rail, opened.beneficiary, opened.payee),
  };
}

/** The refs of a payee a rail created: its id, and a masked note of where payouts go. */
export function payeeRefs(
  rail: string,
  beneficiary: string,
  payee: Record<string, unknown> | undefined,
): Record<string, string> {
  const label = payoutLabelOf(payee);
  const payoutCurrency = payoutCurrencyOf(payee);
  return {
    [RefKeys.beneficiary(rail)]: beneficiary,
    ...(label ? { [RefKeys.payoutLabel(rail)]: label } : {}),
    ...(payoutCurrency ? { [RefKeys.payoutCurrency(rail)]: payoutCurrency } : {}),
  };
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Shows only the last four characters of an account identifier. */
export function maskTail(value: string): string {
  const plain = value.replace(/\s+/g, '');
  return plain.length <= 4 ? plain : `••••${plain.slice(-4)}`;
}

/** A masked label for a payee's bank details: the bank, then the last four of the account. */
export function payoutLabelOf(beneficiary: Record<string, unknown> | undefined): string | null {
  const bank = (beneficiary?.bank_details ?? {}) as Record<string, unknown>;
  const account = text(bank.iban) ?? text(bank.account_number);
  const name = text(bank.bank_name) ?? text(bank.swift_code) ?? text(bank.bank_country_code);
  if (!account && !name) return null;
  return [name, account ? maskTail(account) : null].filter(Boolean).join(' ');
}

/** The payee's currency, where its bank details name one. */
export function payoutCurrencyOf(beneficiary: Record<string, unknown> | undefined): string | null {
  const bank = (beneficiary?.bank_details ?? {}) as Record<string, unknown>;
  return text(bank.account_currency);
}

/**
 * Deposit details from a Global Account as Airwallex returns it, opened in `currency`. Routing codes
 * come with each way the account can receive money, under `supported_features[].routing_codes`.
 */
export function depositDetailsOf(
  body: Record<string, unknown>,
  currency: Currency,
): DepositDetails {
  const routing: { type: string; value: string }[] = [];
  const features = Array.isArray(body.supported_features)
    ? (body.supported_features as Record<string, unknown>[])
    : [];
  for (const f of features) {
    if (f?.type !== 'DEPOSIT' || !Array.isArray(f.routing_codes)) continue;
    for (const r of f.routing_codes as Record<string, unknown>[]) {
      const type = text(r?.type);
      const value = text(r?.value);
      if (type && value && !routing.some((x) => x.type === type && x.value === value))
        routing.push({ type, value });
    }
  }
  const institution = (body.institution ?? {}) as Record<string, unknown>;
  return {
    currency: text(body.currency) ?? currency,
    accountName: text(body.account_name),
    accountNumber: text(body.account_number),
    iban: text(body.iban),
    swiftCode: text(body.swift_code),
    routing,
    bankName: text(institution.name),
    countryCode: text(body.country_code),
  };
}

/** Details as `provisionRefs` stored them. Throws if they are not. */
export const readDepositDetails = (stored: string): DepositDetails =>
  DepositDetails.parse(JSON.parse(stored));
