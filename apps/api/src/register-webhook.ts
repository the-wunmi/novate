import { readFileSync, writeFileSync } from 'node:fs';
import { AirwallexRail } from '@novate/rails';

// Points Airwallex at this server and saves the signing secret to .env without showing it.
// Usage: pnpm webhook:register https://your-public-host
const ENV_FILE = new URL('../../../.env', import.meta.url).pathname;
const [host] = process.argv.slice(2);
if (!host) throw new Error('Usage: pnpm webhook:register https://your-public-host');

const secret = await new AirwallexRail({
  clientId: process.env.AIRWALLEX_CLIENT_ID as string,
  apiKey: process.env.AIRWALLEX_API_KEY as string,
}).registerWebhook(`${host.replace(/\/$/, '')}/rails/airwallex/webhooks`);

const line = `AIRWALLEX_WEBHOOK_SECRET=${secret}`;
const env = readFileSync(ENV_FILE, 'utf8');
const pattern = /^AIRWALLEX_WEBHOOK_SECRET=.*$/m;
writeFileSync(
  ENV_FILE,
  pattern.test(env) ? env.replace(pattern, () => line) : `${env.trimEnd()}\n${line}\n`,
);
console.log('Registered. The signing secret is in .env. Restart the server to use it.');
