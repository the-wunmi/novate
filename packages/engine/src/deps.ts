import type { DrizzleDataSource } from '@dbos-inc/drizzle-datasource';
import type { Db, Tx } from '@novate/db';
import type { Ledger } from '@novate/ledger';
import type { RailRegistry } from '@novate/rails';
import type { SignalRegistry } from '@novate/signals';

export interface EngineDeps {
  ds: DrizzleDataSource<Db>;
  /** Plain handle for reads outside DBOS transactions (signal providers, queries). */
  db: Db;
  ledger: Ledger;
  signals: SignalRegistry;
  rails: RailRegistry;
}

let current: EngineDeps | undefined;

export function setDeps(deps: EngineDeps): void {
  current = deps;
}

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
