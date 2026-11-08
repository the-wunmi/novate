import { serve } from '@hono/node-server';
import { runMigrations } from '@novate/db/migrate';
import { launchEngine } from '@novate/engine';
import { createApp } from './app.ts';

await runMigrations();
const engine = await launchEngine({ logLevel: 'info' });
const port = Number(process.env.PORT ?? 4000);
const server = serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`novate api listening on http://localhost:${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    server.close();
    await engine.shutdown();
    process.exit(0);
  });
}
