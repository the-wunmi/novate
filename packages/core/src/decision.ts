import type { ControlActor } from './principal.ts';

export type DeciderType = 'rule' | 'model' | 'person';

/** Who decided a case. For a person, also the credential and the name they gave. */
export interface Decider {
  type: DeciderType;
  id: string;
  actor?: ControlActor;
}

/** A typed action as stored: JSON, so its amounts are strings until parsed with `Action` again. */
export type StoredAction = { type: string } & Record<string, unknown>;

/** What closed a case: the action taken and who took it. */
export interface CaseDecision {
  action: StoredAction;
  decider: Decider;
}

/** What a decision record keeps about how the proposal was made, beyond the decider's type and id. */
export interface RecordMetadata {
  /** The model that really answered, which can differ from the one asked. */
  model?: string;
  fellBack?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** The binding hash the model was shown. */
  bindingHash?: string;
  /** The instructions a model was given: their version and a hash of the exact text. */
  promptVersion?: string;
  promptHash?: string;
  /** A person's credential and the name they gave. */
  actor?: ControlActor;
  /** Set when a second person approved the decision. */
  approvalId?: string;
  approvedBy?: ControlActor;
  /** Why the model gave no answer. */
  failure?: string;
}
