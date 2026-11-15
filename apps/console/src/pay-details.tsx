// How to pay a member in and where it is paid: what its treasurer looks up, and what support reads
// back to it.
import type { Exposure } from './types.ts';
import { Copy, railName, words } from './ui.tsx';

type Accounts = Pick<Exposure['members'][number], 'depositAccounts' | 'payoutAccount'>;

export function PayInPayOut({ accounts }: { accounts: Accounts }) {
  return (
    <table>
      <tbody>
        {accounts.depositAccounts.map((d) => (
          <tr key={d.reference}>
            <td className="title-cell">
              Pay in {d.details?.currency}
              <small>{railName(d.rail)}</small>
            </td>
            <td>
              {d.details ? (
                <span className="refs">
                  {[
                    d.details.accountName && ['Name', d.details.accountName],
                    d.details.bankName && ['Bank', d.details.bankName],
                    d.details.iban && ['IBAN', d.details.iban],
                    d.details.accountNumber && ['Account', d.details.accountNumber],
                    d.details.swiftCode && ['BIC', d.details.swiftCode],
                    ...d.details.routing.map((r) => [words(r.type), r.value]),
                  ]
                    .filter(Boolean)
                    .map((pair) => {
                      const [label, value] = pair as [string, string];
                      return (
                        <span key={label}>
                          <span className="muted">{label}</span>{' '}
                          <span className="mono">{value}</span> <Copy text={value} />
                        </span>
                      );
                    })}
                </span>
              ) : (
                <span className="refs">
                  <span>
                    <span className="mono">{d.reference}</span> <Copy text={d.reference} />
                  </span>
                </span>
              )}
            </td>
          </tr>
        ))}
        <tr>
          <td className="title-cell">Pay out</td>
          <td>
            {accounts.payoutAccount ? (
              <>
                {accounts.payoutAccount.label}
                <span className="muted">
                  {' '}
                  by {railName(accounts.payoutAccount.rail)}
                  {accounts.payoutAccount.currency ? ` in ${accounts.payoutAccount.currency}` : ''}
                </span>
              </>
            ) : (
              <span className="muted">No payout account on record yet</span>
            )}
          </td>
        </tr>
      </tbody>
    </table>
  );
}
