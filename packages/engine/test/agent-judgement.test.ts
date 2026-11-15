import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { cycles, decisionCases, decisionOutcomes } from '@novate/db';
import { type CaseView, type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  decisionFeed,
  decisionTrail,
  type launchEngine,
  monitorWorkflow,
  openCases,
  runCycle,
  settleDueGroups,
  shadowRunDetail,
  startShadowRun,
  submitFact,
  trackRecords,
} from '../src/index.ts';
import { boot, brain, eur, makeWorld, notified, shutdown, waitFor } from './harness.ts';

const rail = new MockRail();
let engine: Awaited<ReturnType<typeof launchEngine>>;
beforeAll(async () => {
  engine = await boot(rail);
});
afterAll(() => shutdown());

type World = Awaited<ReturnType<typeof makeWorld>>;
const net: ProgramSpecInput = {
  ...presetInputs.netSettlement,
  overrides: [],
  signals: ['history'],
  settlement: { rail: 'mock' },
};
const monitor = async (tenantId: string) =>
  (await DBOS.startWorkflow(monitorWorkflow)(tenantId)).getResult();
const accept = (w: World, dealId: string, memberId: string) =>
  submitFact(dealId, w.asMember(memberId), { kind: 'acceptance', type: 'buyer', data: {} });
const buy = (w: World, price: string, program = 'p') =>
  w.deal({ program, buyer: 'retailer', seller: 'supplier', quantity: 10, price });

function answering(answer: (view: CaseView, prior: string[]) => Record<string, unknown>) {
  const asked: CaseView[] = [];
  brain.current = {
    name: 'stub',
    async decide(view, prior) {
      asked.push(view);
      return { action: answer(view, prior), rationale: 'because' };
    },
  };
  return asked;
}

async function settle(w: World, dealId: string) {
  await accept(w, dealId, w.retailer);
  await waitFor(dealId, ['eligible']);
  await runCycle(w.tenantId);
  await waitFor(dealId, ['settled']);
}

describe('seller reserves', () => {
  const reserve: ProgramSpecInput = {
    ...net,
    margin: {
      mode: 'scored',
      baseBps: 500,
      minBps: 100,
      adjustments: [
        { when: 'signals.history.seller.completedDeals >= 1.0', addBps: -300, reason: 'clean' },
      ],
    },
  };
  const opened = async () => {
    const w = await makeWorld(rail, { p: reserve });
    await w.fund(w.supplier, 'EUR', eur('100'));
    await w.fund(w.retailer, 'EUR', eur('2000'));
    const first = await buy(w, '10');
    const open = await buy(w, '100');
    await waitFor(first.id, ['awaiting_conditions']);
    await waitFor(open.id, ['awaiting_conditions']);
    await settle(w, first.id);
    return { w, open };
  };

  it('gives money back when a seller has earned a lower reserve', async () => {
    const { w } = await opened();
    const before = await w.available(w.supplier, 'EUR');
    answering((v) => ({
      type: 'resize_margin',
      bps: (v.shown.evidence as { targetBps: number }).targetBps,
    }));
    expect((await monitor(w.tenantId)).marginResized).toBe(1);
    // 3% of a EUR 1,000 deal comes back: EUR 50 posted, EUR 20 still needed.
    expect((await w.available(w.supplier, 'EUR')) - before).toBe(eur('30'));
  });

  it('refuses an agent lowering it further than the numbers support', async () => {
    const { w } = await opened();
    const before = await w.available(w.supplier, 'EUR');
    const asked = answering(() => ({ type: 'resize_margin', bps: 0 }));
    await monitor(w.tenantId);
    expect(asked).toHaveLength(2);
    expect(await w.available(w.supplier, 'EUR')).toBe(before);
  });
});

describe('earned limits', () => {
  const freezing = (decisions: ProgramSpecInput['decisions']): ProgramSpecInput => ({
    ...net,
    checks: [{ id: 'always', when: 'true', action: 'freeze', reason: 'looks wrong' }],
    decisions,
  });
  const earning = freezing({
    ceiling: { EUR: 40_000 },
    autonomy: { mode: 'earned', minJudged: 30 },
  });

  it('keeps a new agent to its starting share, and sends the rest to a person', async () => {
    const w = await makeWorld(rail, { p: earning });
    const asked = answering(() => ({ type: 'cancel' }));
    const big = await buy(w, '30');
    await expect
      .poll(async () => (await openCases(w.tenantId)).length, { timeout: 15_000 })
      .toBe(1);
    expect(asked).toHaveLength(0);
    await expect
      .poll(() => notified.some((n) => n.type === 'case_needs_person' && n.kind === 'frozen'))
      .toBe(true);

    const small = await buy(w, '5');
    await waitFor(small.id, ['cancelled']);
    expect(asked).toHaveLength(1);
    expect((await openCases(w.tenantId))[0]?.dealId).toBe(big.id);
  });

  it('lets the agent decide more once its record has earned it', async () => {
    const w = await makeWorld(rail, { p: earning });
    answering(() => ({ type: 'cancel' }));
    const first = await buy(w, '5');
    await waitFor(first.id, ['cancelled']);
    const [c] = await engine.db
      .select()
      .from(decisionCases)
      .where(eq(decisionCases.dealId, first.id));
    const row = c as typeof decisionCases.$inferSelect;
    for (let i = 0; i < 150; i++) {
      const { id: _id, ...copy } = row;
      const [made] = await engine.db.insert(decisionCases).values(copy).returning();
      await engine.db.insert(decisionOutcomes).values({
        caseId: made?.id as string,
        tenantId: w.tenantId,
        kind: 'frozen',
        actionType: 'confirm',
        verdict: 'good',
        signals: {},
        programKey: 'p',
        amount: eur('300'),
        currency: 'EUR',
        pair: `pair-${i}`,
      });
    }
    const asked = answering(() => ({ type: 'cancel' }));
    const big = await buy(w, '30');
    await waitFor(big.id, ['cancelled']);
    expect(asked).toHaveLength(1);
    expect((await trackRecords(w.tenantId))[0]).toMatchObject({ kind: 'frozen', good: 150 });
  });
});

describe('decision records', () => {
  const freeze: ProgramSpecInput = {
    ...net,
    checks: [{ id: 'always', when: 'true', action: 'freeze', reason: 'looks wrong' }],
    decisions: { ceiling: { EUR: 10_000_000 } },
  };
  const decided = async () => {
    const w = await makeWorld(rail, { p: freeze });
    await w.fund(w.retailer, 'EUR', eur('100'));
    answering((_v, prior) => (prior.length ? { type: 'confirm' } : { type: 'waive' }));
    const d = await buy(w, '10');
    await waitFor(d.id, ['awaiting_conditions']);
    await settle(w, d.id);
    return { w, d };
  };

  it('tells the whole story of a decision, refusals and money included', async () => {
    const { w } = await decided();
    await monitor(w.tenantId);
    const [entry] = await decisionFeed(w.tenantId);
    expect(entry).toMatchObject({ kind: 'frozen', verdict: 'good' });
    const trail = await decisionTrail(w.tenantId, entry?.id as string);
    expect(trail.untampered).toBe(true);
    expect(trail.steps.map((s) => [s.action.type, s.accepted])).toEqual([
      ['waive', false],
      ['confirm', true],
    ]);
    expect(trail.steps[0]?.refusedBecause[0]).toContain('not allowed');
    expect(trail.events.map((e) => e.type)).toContain('settled');
    expect(trail.outcome?.verdict).toBe('good');
  });

  it('keeps another tenant out of a decision', async () => {
    const { w } = await decided();
    const [entry] = await decisionFeed(w.tenantId);
    await expect(decisionTrail(randomUUID(), entry?.id as string)).rejects.toThrow('not found');
  });

  const finished = async (tenantId: string, id: string) => {
    await expect
      .poll(async () => (await shadowRunDetail(tenantId, id)).run.status, { timeout: 20_000 })
      .toBe('done');
    return shadowRunDetail(tenantId, id);
  };

  it('shows what tighter limits would have changed, without calling a model', async () => {
    const { w } = await decided();
    await monitor(w.tenantId);
    const asked = answering(() => ({ type: 'cancel' }));
    const { id } = await startShadowRun(w.tenantId, {
      candidate: { decisions: { ceiling: { EUR: 1 } } },
    });
    const { run, results } = await finished(w.tenantId, id);
    expect(asked).toHaveLength(0);
    expect(run.summary).toMatchObject({ replayed: 1, toPerson: 1, wouldHaveChanged: 1 });
    expect(results[0]).toMatchObject({ recorded: 'confirm', candidate: 'to_person' });
  });

  it('replays a candidate model and leaves the original decision alone', async () => {
    const { w, d } = await decided();
    await monitor(w.tenantId);
    deps().candidateAgent = () => ({
      name: 'candidate',
      decide: async () => ({ action: { type: 'cancel' }, rationale: 'different view' }),
    });
    try {
      const { id } = await startShadowRun(w.tenantId, { candidate: { model: 'claude-candidate' } });
      const { results } = await finished(w.tenantId, id);
      expect(results[0]).toMatchObject({
        recorded: 'confirm',
        candidate: 'cancel',
        verdict: 'good',
      });
      await waitFor(d.id, ['settled']);
    } finally {
      deps().candidateAgent = undefined;
    }
  });

  it('refuses a replay that changes nothing', async () => {
    await expect(startShadowRun(randomUUID(), { candidate: {} })).rejects.toThrow();
  });
});

describe('treasury agent', () => {
  const scheduled: ProgramSpecInput = {
    ...net,
    settlement: { rail: 'mock', timing: { mode: 'cycle', every: '1m' }, fundingWindow: '1s' },
    treasury: { mode: 'agent', maxDeferrals: 2 },
    decisions: { ceiling: { EUR: 10_000_000 } },
  };
  const eligible = async (w: World) => {
    const d = await buy(w, '10');
    await waitFor(d.id, ['awaiting_conditions']);
    await accept(w, d.id, w.retailer);
    await waitFor(d.id, ['eligible']);
    return d;
  };
  const held = async (w: World, n: number) =>
    expect
      .poll(
        async () =>
          (
            await engine.db
              .select()
              .from(cycles)
              .where(and(eq(cycles.tenantId, w.tenantId), eq(cycles.status, 'deferred')))
          ).length,
        { timeout: 15_000 },
      )
      .toBe(n);
  const tick = (w: World, minutes: number) =>
    settleDueGroups(w.tenantId, new Date(Date.now() + minutes * 60_000));

  it('runs without asking when everyone can pay and rates are calm', async () => {
    const w = await makeWorld(rail, { p: scheduled });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const asked = answering(() => ({ type: 'choose_plan', planId: 'defer_cycle' }));
    const d = await eligible(w);
    await tick(w, 2);
    await waitFor(d.id, ['settled']);
    expect(asked).toHaveLength(0);
  });

  it('can hold a cycle for an unfunded member, but only so many times', async () => {
    const w = await makeWorld(rail, { p: scheduled });
    const asked = answering(() => ({ type: 'choose_plan', planId: 'defer_cycle' }));
    const d = await eligible(w);

    await tick(w, 2);
    await held(w, 1);
    expect(asked[0]?.kind).toBe('treasury_review');
    expect(asked[0]?.shown.evidence).toMatchObject({ deferralsLeft: 2 });
    await tick(w, 4);
    await held(w, 2);

    // Out of holds: it settles whatever the agent would prefer.
    await tick(w, 6);
    await waitFor(d.id, ['settled']);
    expect(asked).toHaveLength(2);
  });
});
