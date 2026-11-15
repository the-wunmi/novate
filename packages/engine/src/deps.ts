import { DBOS, Error as DBOSErrors } from '@dbos-inc/dbos-sdk';
import type { DrizzleDataSource } from '@dbos-inc/drizzle-datasource';
import { type DocumentContent, DomainError } from '@novate/core';
import type { Db, Tx } from '@novate/db';
import type { Ledger, TransferInput } from '@novate/ledger';
import type { DecisionAgent } from '@novate/policy';
import type { RailRegistry } from '@novate/rails';
import type { SignalRegistry } from '@novate/signals';
import type { DeliveredNotification } from './notifications.ts';

/** Gets a notification to wherever it needs to go. Throw to have the delivery tried again. */
export interface Notifier {
  deliver(notification: DeliveredNotification): Promise<void>;
}

export interface ReplayCandidate {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  instructions?: string;
}

/** Turns a raw document into evidence. Implemented by a model in `@novate/agents`. */
export interface DocumentReader {
  read(input: {
    documentType: string;
    dealCurrency: string;
    description: string;
    content: DocumentContent;
  }): Promise<{
    fields: Record<string, unknown>;
    issues: { code: string; message: string }[];
    extraction: Record<string, unknown>;
  }>;
}

export interface EngineDeps {
  ds: DrizzleDataSource<Db>;
  /** Plain handle for reads outside DBOS transactions (signal providers, queries). */
  db: Db;
  ledger: Ledger;
  signals: SignalRegistry;
  rails: RailRegistry;
  /** Absent means model-backed deciders are skipped and cases move on to the next decider. */
  decisionAgent?: DecisionAgent;
  documentReader?: DocumentReader;
  notifier: Notifier;
  /** Builds a decider to compare with the live one. Used only by shadow replays. */
  candidateAgent?: (candidate: ReplayCandidate) => DecisionAgent;
  /** Which tenant owns each rail account. Rails with no owner are never reconciled on a schedule. */
  railOwners: Record<string, string>;
  fxSampleRail?: string;
  /**
   * Scales every pause the engine times itself: retries, polls and settle windows. 1 in production.
   * Tests shrink it so a retry costs milliseconds and still runs the same path.
   */
  pace: number;
}

let current: EngineDeps | undefined;

export function setDeps(deps: EngineDeps): void {
  current = deps;
}

/** A pause of `ms` at the engine's pace. */
export const paced = (ms: number): number => ms * deps().pace;

export function deps(): EngineDeps {
  if (!current) throw new Error('Engine not launched — call launchEngine() first');
  return current;
}

/**
 * Run `fn` in an app-database transaction. Inside a workflow this is a DBOS transaction step:
 * its result is recorded in the same Postgres transaction, so it runs exactly once.
 */
export function tx<T>(name: string, fn: (db: Tx) => Promise<T>): Promise<T> {
  const { ds } = deps();
  return ds.runTransaction(() => fn(ds.client as unknown as Tx), {
    name,
    isolationLevel: 'read committed',
  });
}

/** A call to a rail or other network dependency, retried by DBOS and checkpointed once it returns. */
export async function networkStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  // A refusal is an answer, not an outage: it is recorded once and never retried.
  const out = await DBOS.runStep(
    async (): Promise<{ ok: T } | { refused: { code: DomainError['code']; message: string } }> => {
      try {
        return { ok: await fn() };
      } catch (err) {
        if (err instanceof DomainError)
          return { refused: { code: err.code, message: err.message } };
        throw err;
      }
    },
    { name, retriesAllowed: true, maxAttempts: 5, intervalSeconds: paced(1_000) / 1_000 },
  );
  if ('refused' in out) throw new DomainError(out.refused.code, out.refused.message);
  return out.ok;
}

/**
 * DBOS uses errors for cancellation and recovery, and workflows must let those through. A step
 * that ran out of retries is the exception: that is an ordinary failure the workflow should handle.
 */
export function isWorkflowControl(err: unknown): boolean {
  return (
    err instanceof DBOSErrors.DBOSError && !(err instanceof DBOSErrors.DBOSMaxStepRetriesError)
  );
}

/** Poll something a rail reported as in flight, with growing pauses, up to a limit. */
export async function pollWhileSubmitted<R extends { status: string; externalRef: string }>(
  name: string,
  first: R,
  maxPolls: number,
  fetch: (externalRef: string) => Promise<R>,
): Promise<R> {
  let result = first;
  for (let i = 0; result.status === 'submitted' && i < maxPolls; i++) {
    await DBOS.sleep(paced(Math.min(60_000, 500 * 2 ** i)));
    const { externalRef } = result;
    result = await networkStep(name, () => fetch(externalRef));
  }
  return result;
}

/** Post inside a savepoint. False means an account was short; the transaction stays usable. */
export async function tryPost(
  db: Tx,
  tenantId: string,
  transfers: TransferInput[],
): Promise<boolean> {
  try {
    await db.transaction((sp) => deps().ledger.post(sp, tenantId, transfers));
    return true;
  } catch (err) {
    if (err instanceof DomainError && err.code === 'insufficient_funds') return false;
    throw err;
  }
}
