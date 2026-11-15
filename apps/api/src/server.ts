import { serve } from '@hono/node-server';
import { ClaudeDecisionAgent, ClaudeDocumentReader, ClaudeModelClient } from '@novate/agents';
import { grantAppRole } from '@novate/db/least-privilege';
import { runMigrations } from '@novate/db/migrate';
import { DEFAULT_FIRST_USERS, launchEngine, PostgresMetalAttempts } from '@novate/engine';
import { AirwallexRail, createMetalClient, MetalRail, MockRail, RailRegistry } from '@novate/rails';
import { createApp } from './app.ts';
import { authFromEnv, databasesFromEnv } from './env.ts';
import { webhookNotifier } from './notifier.ts';
import { metalGateway } from './x402.ts';

const { METAL_RPC_URL, METAL_PRIVATE_KEY, METAL_TOKEN_ADDRESS } = process.env;
const metal =
  METAL_RPC_URL && METAL_PRIVATE_KEY
    ? createMetalClient({
        rpcUrl: METAL_RPC_URL,
        privateKey: METAL_PRIVATE_KEY as `0x${string}`,
        tokenAddress: METAL_TOKEN_ADDRESS || undefined,
      })
    : undefined;

function railsFromEnv(): RailRegistry {
  const rails = new RailRegistry();
  // The mock settles with no money behind it, so it exists only when asked for by name.
  if (process.env.NOVATE_ALLOW_MOCK_RAIL === 'true') rails.register(new MockRail());
  const {
    AIRWALLEX_CLIENT_ID,
    AIRWALLEX_API_KEY,
    AIRWALLEX_WEBHOOK_SECRET,
    AIRWALLEX_BASE_URL,
    AIRWALLEX_CUSTODY,
  } = process.env;
  if (AIRWALLEX_CLIENT_ID && AIRWALLEX_API_KEY) {
    rails.register(
      new AirwallexRail({
        clientId: AIRWALLEX_CLIENT_ID,
        apiKey: AIRWALLEX_API_KEY,
        webhookSecret: AIRWALLEX_WEBHOOK_SECRET || undefined,
        baseUrl: AIRWALLEX_BASE_URL,
        custody: AIRWALLEX_CUSTODY === 'connected' ? 'connected' : 'pooled',
        skip3ds: process.env.AIRWALLEX_SKIP_3DS === 'true',
      }),
    );
  }
  if (metal) rails.register(new MetalRail(metal, new PostgresMetalAttempts()));
  return rails;
}

const { NOVATE_ALERT_WEBHOOK_URL, NOVATE_ALERT_WEBHOOK_SECRET } = process.env;
// In production the server connects as a role that cannot rewrite the audit trail, so the schema
// is changed through the owner's connection, and the role's grants are applied again after it.
const databases = databasesFromEnv();
const port = Number(process.env.PORT ?? 4000);
const ownerUrl = process.env.NOVATE_MIGRATION_DATABASE_URL;
await runMigrations(ownerUrl ?? databases.databaseUrl);
if (ownerUrl) {
  await grantAppRole(ownerUrl, decodeURIComponent(new URL(databases.databaseUrl).username));
}
const rails = railsFromEnv();
const model = process.env.ANTHROPIC_API_KEY ? new ClaudeModelClient() : undefined;
const engine = await launchEngine({
  ...databases,
  auth: authFromEnv(port),
  logLevel: 'info',
  rails,
  decisionAgent: model ? new ClaudeDecisionAgent(model) : undefined,
  candidateAgent: model
    ? ({ model: id, effort, instructions }) =>
        new ClaudeDecisionAgent(new ClaudeModelClient({ model: id, effort }), instructions)
    : undefined,
  documentReader: model ? new ClaudeDocumentReader(model) : undefined,
  fxSampleRail: rails.has('airwallex') ? 'airwallex' : undefined,
  // The mock holds no real money, so nothing is reconciled against it.
  ownedRails: rails
    .all()
    .map((r) => r.name)
    .filter((name) => name !== 'mock'),
  schedules: true,
  firstUsers: {
    house: process.env.NOVATE_ADMIN_EMAIL || DEFAULT_FIRST_USERS.house,
    platform: process.env.NOVATE_PLATFORM_ADMIN_EMAIL || DEFAULT_FIRST_USERS.platform,
  },
  notifier:
    NOVATE_ALERT_WEBHOOK_URL && NOVATE_ALERT_WEBHOOK_SECRET
      ? webhookNotifier(NOVATE_ALERT_WEBHOOK_URL, NOVATE_ALERT_WEBHOOK_SECRET)
      : undefined,
});
if (engine.firstRun) {
  const { operatorKey, platformKey, tenantId, invites } = engine.firstRun;
  const links = invites
    .map((i) => `  ${`${i.role} admin`.padEnd(15)}${i.email}\n                 ${i.inviteUrl}`)
    .join('\n');
  console.log(`
novate is set up. These keys and links are shown once, so save them now.

  Operator key   ${operatorKey}
  Default tenant ${tenantId}
  Platform key   ${platformKey}

People sign in to the console with accounts. Each link below sets a password, once, within 72 hours:

${links}

Lost the operator key? Run: pnpm reset-operator-key
Nobody can sign in? Run: pnpm user:invite <email> house
`);
}
const server = serve(
  {
    fetch: createApp({ x402: metal ? metalGateway(metal.houseAddress, metal.reader) : undefined })
      .fetch,
    port,
  },
  (info) => {
    console.log(`novate api listening on http://localhost:${info.port}`);
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    server.close();
    await engine.shutdown();
    process.exit(0);
  });
}
