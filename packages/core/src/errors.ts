import type { z } from 'zod';

export type DomainErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid'
  /** The body could not be read as JSON at all. */
  | 'malformed'
  | 'insufficient_funds'
  /** Settlement is stopped for the tenant, or the member is not active. */
  | 'settlement_held'
  /** The rail the money would go over has reconciliation differences nobody has closed. */
  | 'rail_held'
  /** The member owes the house in this currency, or has a margin call open. */
  | 'debt_outstanding'
  /** No payout destination is on record for the member. */
  | 'no_payout_account'
  | 'unauthorised_agent'
  /** A credential asked for something outside what it may see or do. */
  | 'forbidden'
  /** Only a signed-in person may do this, never a key on its own. */
  | 'person_required'
  /** A sign-in failed. Every reason gets this one answer, so it tells an attacker nothing. */
  | 'invalid_credentials'
  /** The password was right, but the account needs a current two-step code. */
  | 'mfa_required'
  /** An export would be larger than one response may be: ask for a shorter range. */
  | 'too_large'
  /** A rail turned the request down for a reason trying again will not change. */
  | 'rail_refused'
  | 'policy_error';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Every input from outside passes through here, so a bad one is always the same kind of error. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError('invalid', describeIssues(parsed.error.issues), parsed.error.issues);
  }
  return parsed.data;
}

/** The first few problems, each named by its field, so a person or an agent can fix them. */
function describeIssues(issues: z.ZodError['issues']): string {
  const named = issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.map(String).join('.')}: ${i.message}` : i.message));
  const more = issues.length > 3 ? ` (and ${issues.length - 3} more)` : '';
  return `Invalid input: ${named.join('; ')}${more}`;
}
