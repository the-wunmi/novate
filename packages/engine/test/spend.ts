import { randomUUID } from 'node:crypto';
import { Accounts } from '@novate/ledger';
import { deps, tx } from '../src/deps.ts';

/** Empty a member's wallet directly, to set up a seller who cannot meet a margin call. */
export async function ledgerSpend(
  tenantId: string,
  memberId: string,
  currency: string,
  amount: bigint,
) {
  await tx('test_spend', (db) =>
    deps().ledger.post(db, tenantId, [
      {
        key: `test:spend:${randomUUID()}`,
        debit: Accounts.memberAvailable(memberId, currency),
        credit: Accounts.memberAvailable('fees', currency),
        amount,
        kind: 'test',
      },
    ]),
  );
}
