import { DBOS } from '@dbos-inc/dbos-sdk';
import { DrizzleDataSource } from '@dbos-inc/drizzle-datasource';
import { createDb, createPool, type Db, schema } from '@novate/db';
import { PostgresLedger } from '@novate/ledger';
import type { DecisionAgent } from '@novate/policy';
import type { RailRegistry } from '@novate/rails';
import { SignalRegistry } from '@novate/signals';
import { type DocumentReader, type EngineDeps, type Notifier, setDeps } from './deps.ts';
import { FxVolatilityProvider } from './fx-signal.ts';
import { HistorySignalProvider } from './history.ts';
import { setUpInstance } from './instance-setup.ts';
import { recordRailOpening } from './reconciliation.ts';

// Importing registers the workflows with DBOS before launch.
import './deal-workflow.ts';
import './cycle-workflow.ts';
import './rail-events.ts';
import './monitor.ts';
import './shadow.ts';
import { applyTickSchedules } from './scheduler.ts';

export interface LaunchOptions {
  databaseUrl?: string;
  systemDatabaseUrl?: string;
  appName?: string;
  rails: RailRegistry;
  signals?: SignalRegistry;
  logLevel?: string;
  decisionAgent?: DecisionAgent;
  documentReader?: DocumentReader;
  notifier?: Notifier;
  candidateAgent?: EngineDeps['candidateAgent'];
  railOwners?: Record<string, string>;
  /** Set up this installation if it is new, and have the default tenant own these rails. */
  ownedRails?: string[];
  /** The rail whose rates are sampled to measure volatility. */
  fxSampleRail?: string;
  /** Run settlement, reconciliation and monitoring on schedules. Off in tests. */
  schedules?: boolean;
}

const logNotifier: Notifier = {
  async deliver(notification) {
    console.warn('Notification:', JSON.stringify(notification));
  },
};

export type Engine = Awaited<ReturnType<typeof launchEngine>>;

export async function launchEngine(opts: LaunchOptions) {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const systemDatabaseUrl = opts.systemDatabaseUrl ?? process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!databaseUrl || !systemDatabaseUrl)
    throw new Error('DATABASE_URL and DBOS_SYSTEM_DATABASE_URL are required');

  const pool = createPool(databaseUrl);
  const db = createDb(pool);
  const ds = new DrizzleDataSource<Db>('app', { connectionString: databaseUrl }, schema);

  const signals = opts.signals ?? new SignalRegistry();
  if (!signals.has('history')) signals.register(new HistorySignalProvider(db));
  if (!signals.has('fx')) signals.register(new FxVolatilityProvider(db));

  const { rails } = opts;
  // Before launch: a recovered workflow must never run without knowing who owns a rail.
  const instance = opts.ownedRails ? await setUpInstance(db, opts.ownedRails) : undefined;
  setDeps({
    ds,
    db,
    ledger: new PostgresLedger(),
    signals,
    rails,
    decisionAgent: opts.decisionAgent,
    documentReader: opts.documentReader,
    notifier: opts.notifier ?? logNotifier,
    candidateAgent: opts.candidateAgent,
    railOwners: instance?.railOwners ?? opts.railOwners ?? {},
    fxSampleRail: opts.fxSampleRail,
  });

  DBOS.setConfig({
    name: opts.appName ?? 'novate',
    systemDatabaseUrl,
    logLevel: opts.logLevel ?? 'warn',
  });
  await DBOS.launch();
  // If a rail cannot answer, the next boot tries again. Until then reconciliation stops settlement.
  for (const [rail, tenantId] of Object.entries(instance?.railOwners ?? {})) {
    await recordRailOpening(tenantId, rail).catch((err) =>
      console.warn(`Could not record what ${rail} already holds: ${String(err)}`),
    );
  }
  if (opts.schedules) await applyTickSchedules();

  return {
    db,
    rails,
    signals,
    firstRun: instance?.firstRun,
    async shutdown() {
      await DBOS.shutdown();
      await pool.end();
    },
  };
}
