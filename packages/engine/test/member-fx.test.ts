import { describe, expect, it } from 'vitest';
import { memberFxExchanges } from '../src/member-fx.ts';

const leg = (batchId: string, kind: string, currency: string, amount: bigint) => ({
  batchId,
  kind,
  currency,
  amount,
});

describe('member exchanges read from the ledger', () => {
  it('pairs each purchase with the sales posted in its batch', () => {
    const exchanges = memberFxExchanges([
      leg('a', 'fx_member_sell', 'GBP', 60n),
      leg('a', 'fx_member_sell', 'GBP', 40n),
      leg('a', 'fx_member_buy', 'EUR', 115n),
      // The same member selling a second currency for euros in the same cycle stays apart.
      leg('b', 'fx_member_sell', 'USD', 50n),
      leg('b', 'fx_member_buy', 'EUR', 46n),
    ]);
    expect(exchanges).toEqual([
      { batchId: 'a', sellCurrency: 'GBP', buyCurrency: 'EUR', sold: 100n, bought: 115n },
      { batchId: 'b', sellCurrency: 'USD', buyCurrency: 'EUR', sold: 50n, bought: 46n },
    ]);
  });
  it('leaves out a batch that holds only one side', () => {
    expect(memberFxExchanges([leg('a', 'fx_member_buy', 'EUR', 1n)])).toEqual([]);
  });
});
