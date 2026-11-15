import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DepositDetails, depositDetailsOf } from '../src/refs.ts';

// A Global Account in the shape Airwallex documents for `POST /api/v1/global_accounts/create`.
const account = JSON.parse(
  readFileSync(new URL('./fixtures/global-account.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('deposit details of a Global Account', () => {
  it('reads the routing codes of each way it receives deposits, and nothing else', () => {
    const details = depositDetailsOf(account, 'GBP');
    expect(DepositDetails.parse(details)).toEqual({
      currency: 'GBP',
      accountName: 'Dutch retailer',
      accountNumber: '88888888',
      iban: 'GB81LHVB04032900176471',
      swiftCode: 'SXPYDEHH',
      routing: [
        { type: 'sort_code', value: '040329' },
        { type: 'swift', value: 'SXPYDEHH' },
      ],
      bankName: 'Saxo Payments A/S',
      countryCode: 'GB',
    });
  });

  it('takes the currency it was opened in when the account does not say', () => {
    expect(depositDetailsOf({}, 'EUR')).toMatchObject({ currency: 'EUR', routing: [] });
  });
});
