import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { payWithAiri } from './airi-buyer.ts';

const run = promisify(execFile);
const FIVE_MINUTES_AND_A_BIT = 330_000;

const dealId = process.argv[2];
const { NOVATE_API_URL, NOVATE_BUYER_KEY, AIRI_PAYMENT_METHOD_ID, AIRI_CARD_NAME } = process.env;
if (!dealId || !NOVATE_BUYER_KEY) {
  console.error('Usage: NOVATE_BUYER_KEY=... pnpm pay:airi <dealId>');
  process.exit(1);
}

const paid = await payWithAiri({
  dealId,
  apiUrl: NOVATE_API_URL ?? 'http://localhost:4000',
  apiKey: NOVATE_BUYER_KEY,
  cardName: AIRI_CARD_NAME ?? 'Novate Buyer',
  paymentMethodId: AIRI_PAYMENT_METHOD_ID,
  async cli(args) {
    const { stdout } = await run('airi-cli', [...args, '-o', 'json'], {
      timeout: FIVE_MINUTES_AND_A_BIT,
    });
    return stdout.trim() ? JSON.parse(stdout) : {};
  },
  async chooseCard(methods) {
    if (!process.stdin.isTTY)
      throw new Error('Set AIRI_PAYMENT_METHOD_ID to say which card to use');
    methods.forEach((method, i) => {
      console.log(`${i + 1}. ${JSON.stringify(method)}`);
    });
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question('Which card? ');
    prompt.close();
    const chosen = methods[Number(answer) - 1];
    if (!chosen) throw new Error(`No card number ${answer}`);
    return chosen.paymentMethodId;
  },
  askApproval(url, summary) {
    // On its own line: a link broken across two lines fails on Airi's approval page.
    console.log(`\nApprove ${summary} with your passkey:\n\n${url}\n`);
  },
});
console.log(JSON.stringify(paid, null, 2));
