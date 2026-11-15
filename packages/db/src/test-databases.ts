import pg from 'pg';

/**
 * The Postgres that tests create their databases on: the one `pnpm db:up` starts. Tests never read
 * `.env`, so they cannot land on a dev database or reach a real rail by accident.
 */
export const testServerUrl =
  process.env.NOVATE_TEST_DATABASE_URL ?? 'postgres://novate:novate@localhost:5433/novate';

const urlOf = (name: string) => {
  const url = new URL(testServerUrl);
  url.pathname = `/${name}`;
  return url.toString();
};

const names = (suite: string, worker: number | string) => {
  const app = `novate_test_${suite}_${worker}`;
  return { app, system: `${app}_dbos` };
};

/**
 * Vitest workers per suite. Turbo runs the suites at the same time against one server, so together
 * they must fit within its `max_connections`, or a query fails with "too many clients" at random.
 */
export const testWorkers = { engine: 7, api: 4, ledger: 1 } as const;

/** What a test engine passes as `poolSize`: each of its three pools opens at most this many. */
export const testPoolSize = 4;

/** One worker at most: an engine's three pools, DBOS's listener, and a client or two a test opens. */
const connectionsPerWorker = 3 * testPoolSize + 1 + 2;
/** A dev server with default pools on the same Postgres while tests run. */
const devServerConnections = 3 * 10 + 1;

/** Fails at once, with the reason, when the server cannot hold every suite at its busiest. */
async function assertServerFits(admin: pg.Client) {
  const workers = Object.values(testWorkers).reduce((a, b) => a + b, 0);
  const needed = workers * connectionsPerWorker + devServerConnections;
  const { rows } = await admin.query<{ max_connections: string }>('show max_connections');
  const allowed = Number(rows[0]?.max_connections);
  if (allowed < needed)
    throw new Error(
      `The test Postgres allows ${allowed} connections, and the test suites with a dev server can use ${needed}. ` +
        'Run `pnpm db:up` to apply the max_connections in docker-compose.yml, or raise it on the server NOVATE_TEST_DATABASE_URL names.',
    );
}

/** Drop and recreate one app database and its DBOS database, and return where they are. */
export async function freshDatabasePair(app: string) {
  const system = `${app}_dbos`;
  const admin = new pg.Client({ connectionString: testServerUrl });
  await admin.connect();
  try {
    for (const name of [app, system]) {
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.query(`create database ${name}`);
    }
  } finally {
    await admin.end();
  }
  return { databaseUrl: urlOf(app), systemDatabaseUrl: urlOf(system) };
}

/**
 * Empty databases for one package's test run, a pair per vitest worker so test files run in
 * parallel. Tests create thousands of tenants, and a server on the same database does work for every
 * one, so tests never share a database with a server. Returns the env that tells `test-worker.ts`
 * which suite it belongs to.
 */
export async function freshTestDatabases(
  suite: string,
  workers: number,
): Promise<Record<string, string>> {
  const admin = new pg.Client({ connectionString: testServerUrl });
  await admin.connect();
  try {
    await assertServerFits(admin);
  } finally {
    await admin.end();
  }
  await Promise.all(
    Array.from({ length: workers }, (_, i) => freshDatabasePair(names(suite, i + 1).app)),
  );
  return { NOVATE_TEST_SUITE: suite };
}

/** This worker's own pair, as `launchEngine` takes them. */
export function workerDatabases(): { databaseUrl: string; systemDatabaseUrl: string } {
  const suite = process.env.NOVATE_TEST_SUITE;
  const worker = process.env.VITEST_POOL_ID;
  if (!suite || !worker) throw new Error('freshTestDatabases did not run for this suite');
  const { app, system } = names(suite, worker);
  return { databaseUrl: urlOf(app), systemDatabaseUrl: urlOf(system) };
}

/** Points this worker at its own pair. Runs as a vitest setup file, before a test file loads. */
export function useWorkerDatabases(): void {
  const { databaseUrl, systemDatabaseUrl } = workerDatabases();
  process.env.DATABASE_URL = databaseUrl;
  process.env.DBOS_SYSTEM_DATABASE_URL = systemDatabaseUrl;
}
