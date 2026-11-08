import { DBOS } from '@dbos-inc/dbos-sdk';
import { DrizzleDataSource } from '@dbos-inc/drizzle-datasource';
import { createDb, createPool, type Db, schema } from '@novate/db';
import { PostgresLedger } from '@novate/ledger';
import { MockRail, RailRegistry } from '@novate/rails';
import { SignalRegistry, StaticSignalProvider } from '@novate/signals';
import { setDeps } from './deps.ts';
import { HistorySignalProvider } from './history.ts';

// Importing registers the workflows with DBOS before launch.
import './deal-workflow.ts';
import './cycle-workflow.ts';

export interface LaunchOptions {
  databaseUrl?: string;
  systemDatabaseUrl?: string;
  appName?: string;
  rails?: RailRegistry;
  signals?: SignalRegistry;
  logLevel?: string;
}

/** Default FX volatility table until a live provider is configured. */
const FX_VOL_30D: Record<string, number> = {
  EUR: 0.06,
  GBP: 0.07,
  USD: 0.05,
  JPY: 0.09,
  NGN: 0.25,
};

export async function launchEngine(opts: LaunchOptions = {}) {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const systemDatabaseUrl = opts.systemDatabaseUrl ?? process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!databaseUrl || !systemDatabaseUrl)
    throw new Error('DATABASE_URL and DBOS_SYSTEM_DATABASE_URL are required');

  const pool = createPool(databaseUrl);
  const db = createDb(pool);
  const ds = new DrizzleDataSource<Db>('app', { connectionString: databaseUrl }, schema);

  const signals = opts.signals ?? new SignalRegistry();
  if (!signals.has('history')) signals.register(new HistorySignalProvider(() => db));
  if (!signals.has('fx')) {
    signals.register(
      new StaticSignalProvider('fx', (s) => ({ vol30d: FX_VOL_30D[s.currency] ?? 0.15 }), {
        vol30d: 0.15,
      }),
    );
  }

  const rails = opts.rails ?? new RailRegistry().register(new MockRail());
  setDeps({ ds, db, ledger: new PostgresLedger(), signals, rails });

  DBOS.setConfig({
    name: opts.appName ?? 'novate',
    systemDatabaseUrl,
    logLevel: opts.logLevel ?? 'warn',
  });
  await DBOS.launch();

  return {
    db,
    rails,
    signals,
    async shutdown() {
      await DBOS.shutdown();
      await pool.end();
    },
  };
}
