import { toMajor } from '@novate/core';
import { dealEvents } from '@novate/db';
import { MockRail } from '@novate/rails';
import { asc, eq } from 'drizzle-orm';
import { type Engine, runCycle } from '../src/index.ts';
import {
  boot,
  brain,
  eur,
  frozenBigOrder,
  gbp,
  makeWorld,
  personDecides,
  shutdown,
  waitFor,
} from './harness.ts';

/**
 * `pnpm demo`: the mug scenario from start to finish, on the in-memory rail. No money moves and no
 * model is called. The numbers, ledger, workflows and checks are the real ones.
 */
const say = (text: string) => console.log(`\n${text}`);
const money = (minor: bigint, currency: string) => `${currency} ${toMajor(minor, currency)}`;

const rail = new MockRail();
const engine: Engine = await boot(rail, [], { logLevel: 'error' });

async function timeline(dealId: string) {
  const events = await engine.db
    .select({ type: dealEvents.type })
    .from(dealEvents)
    .where(eq(dealEvents.dealId, dealId))
    .orderBy(asc(dealEvents.seq));
  console.log(`  ${events.map((e) => e.type).join(' > ')}`);
}

try {
  brain.current = undefined;
  const w = await makeWorld(rail, undefined, { EUR: { monthlyLimit: eur('20000') } });
  await w.fund(w.brand, 'GBP', gbp('15000'));
  await w.fund(w.retailer, 'EUR', eur('9000'));
  await w.fund(w.supplier, 'EUR', eur('1000'));

  say(
    'A homeware brand buys 1,000 mugs from a Portuguese supplier and sells 600 to a Dutch retailer.',
  );
  const buy = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 1_000, price: '14' });
  const sell = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 600, price: '15' });
  await waitFor(buy.id, ['awaiting_conditions']);
  await waitFor(sell.id, ['awaiting_conditions']);
  console.log('  Both agents were within their mandates. Funds and seller margin are locked.');

  say('Goods ship a day late, inside tolerance. Inspection finds 8% chipped.');
  await w.pass(buy.id, {
    amount: eur('14000'),
    quantity: 1_000,
    shipped: '2026-11-03',
    pass: { inspected: 1_000, passed: 920 },
  });
  const released = await waitFor(buy.id, ['eligible']);
  console.log(`  The evidence supports paying ${money(released.releaseAmount as bigint, 'EUR')}.`);
  await w.pass(sell.id, { amount: eur('9000'), quantity: 600 });
  await waitFor(sell.id, ['eligible']);

  say('The clearing cycle nets everyone against the house.');
  const cycle = await runCycle(w.tenantId);
  await waitFor(buy.id, ['settled']);
  await waitFor(sell.id, ['settled']);
  const bought = rail.conversions.map((c) => money(c.buyAmount, 'EUR')).join(', ');
  console.log(`  Status: ${cycle.status}.`);
  console.log(
    `  Without netting the house would buy ${money(cycle.fx?.boughtGross.EUR ?? 0n, 'EUR')}. It bought ${bought}.`,
  );
  await timeline(buy.id);

  say('An agent then orders ten times its usual size, and the deal freezes before money moves.');
  const { big, case: open } = await frozenBigOrder(w);
  console.log(`  Frozen: ${open.reason}`);
  // With a model configured the risk agent takes this case. Here a person does.
  await personDecides(w, open.id, {
    bindingHash: open.bindingHash,
    rationale: 'Checked against the evidence',
    action: { type: 'cancel' },
  });
  await waitFor(big.id, ['cancelled']);
  await timeline(big.id);
  say('Nothing moved for the bad order. The decision is bound to exactly what the decider saw.');
} finally {
  await shutdown();
}
