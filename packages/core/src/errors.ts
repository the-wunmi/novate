export type DomainErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'insufficient_funds'
  | 'unauthorised_agent'
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
