import pg from 'pg';

/**
 * Empty databases for one package's test run. Tests create thousands of tenants, and a server on
 * the same database does work for every one, so only tests that drive a running server share it.
 */
export async function freshTestDatabases(suite: string): Promise<Record<string, string>> {
  process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname);
  if (process.env.NOVATE_LIVE === '1') return {};
  const base = process.env.DATABASE_URL as string;
  const urlOf = (name: string) => {
    const url = new URL(base);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const app = `novate_test_${suite}`;
  const system = `${app}_dbos`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    for (const name of [app, system]) {
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.query(`create database ${name}`);
    }
  } finally {
    await admin.end();
  }
  return { DATABASE_URL: urlOf(app), DBOS_SYSTEM_DATABASE_URL: urlOf(system) };
}
