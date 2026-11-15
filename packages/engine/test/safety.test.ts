import { randomUUID } from 'node:crypto';
import { type DecisionAgent, type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  caseRecords,
  dealDetail,
  decideCase,
  setMemberRailRefs,
  submitDeal,
  submitFact,
  withinRateLimit,
} from '../src/index.ts';
import {
  boot,
  brain,
  eur,
  gbp,
  makeWorld,
  notified,
  shutdown,
  waitFor,
  waitForCase,
} from './harness.ts';

const rail = new MockRail();
beforeAll(() => boot(rail));
afterAll(() => shutdown());

const scripted = (...answers: object[]): DecisionAgent => {
  let i = 0;
  return {
    name: 'scripted',
    async decide() {
      return { action: answers[Math.min(i++, answers.length - 1)] as never, rationale: 'test' };
    },
  };
};

const freezeEverything: ProgramSpecInput = {
  ...presetInputs.tradeAssurance,
  checks: [{ id: 'all', when: 'true', action: 'freeze', reason: 'Frozen for review' }],
};

async function funded(programs?: Record<string, ProgramSpecInput>, limits = {}) {
  const w = await makeWorld(rail, programs, limits);
  await w.fund(w.retailer, 'EUR', eur('50000'));
  await w.fund(w.brand, 'GBP', gbp('50000'));
  return w;
}

describe('evidence', () => {
  it('nobody can submit a waiver through the fact endpoint', async () => {
    const w = await funded();
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    await expect(
      submitFact(d.id, w.platform, { kind: 'waiver', type: 'x', data: { code: 'a' } }),
    ).rejects.toThrow(/may not assert/);
  });

  it('rejects impossible inspection results and malformed amounts at the door', async () => {
    const w = await funded();
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    await expect(
      submitFact(d.id, w.inspector, { kind: 'inspection', type: 'x', data: { passRate: 2 } }),
    ).rejects.toThrow();
    await expect(
      submitFact(d.id, w.inspector, {
        kind: 'inspection',
        type: 'x',
        data: { inspected: 1, passed: 5 },
      }),
    ).rejects.toThrow(/exceed/);
    await expect(
      submitFact(d.id, w.asMember(w.brand), {
        kind: 'document',
        type: 'commercial_invoice',
        data: { fields: { amount: 1.5 } },
      }),
    ).rejects.toThrow();
  });

  it('a seller cannot type in what its own documents say', async () => {
    const w = await funded();
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    await expect(
      submitFact(d.id, w.asMember(w.brand), {
        kind: 'document',
        type: 'commercial_invoice',
        data: { fields: { amount: Number(eur('150')), currency: 'EUR', quantity: 10 } },
      }),
    ).rejects.toThrow(/may not assert/);
  });

  it('records the source from the credential, not the request', async () => {
    const w = await funded();
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    const f = await submitFact(d.id, w.inspector, {
      kind: 'inspection',
      type: 'x',
      data: { passRate: 1 },
    });
    expect(f.source).toBe('inspector:inspector-test');
  });

  it('hides another tenant’s deal', async () => {
    const a = await funded();
    const b = await funded();
    const d = await a.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    await expect(
      submitFact(d.id, b.inspector, { kind: 'inspection', type: 'x', data: { passRate: 1 } }),
    ).rejects.toThrow(/not found/);
  });
});

describe('consent', () => {
  const deal = {
    buyer: 'retailer',
    seller: 'brand',
    quantity: 10,
    price: '15',
    key: 'both-sides',
  } as const;

  it('does nothing until the other side submits the same deal', async () => {
    const w = await funded();
    const first = await w.deal({ ...deal, as: w.asMember(w.brand) });
    expect(first.awaitingSide).toBe('buyer');
    await new Promise((r) => setTimeout(r, 300));
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('50000'));

    const second = await w.deal({ ...deal, as: w.asMember(w.retailer) });
    expect(second.awaitingSide).toBeNull();
    await waitFor(first.id, ['awaiting_conditions']);
  });

  it('refuses a confirmation with different terms', async () => {
    const w = await funded();
    await w.deal({ ...deal, as: w.asMember(w.brand) });
    await expect(w.deal({ ...deal, price: '1', as: w.asMember(w.retailer) })).rejects.toThrow(
      /different terms/,
    );
  });

  it('a side cannot confirm its own deal by submitting twice', async () => {
    const w = await funded();
    await w.deal({ ...deal, as: w.asMember(w.brand) });
    const again = await w.deal({ ...deal, as: w.asMember(w.brand) });
    expect(again.awaitingSide).toBe('buyer');
  });

  it('refuses an agent that does not act for the member named', async () => {
    const w = await funded();
    await expect(
      submitDeal(w.platform, {
        idempotencyKey: 'wrong-agent',
        programKey: 'trade-assurance',
        buyerMemberId: w.retailer,
        sellerMemberId: w.brand,
        buyerAgentId: w.supplierAgent,
        terms: {
          category: 'homeware',
          currency: 'EUR',
          lines: [{ description: 'x', quantity: 1, unitPrice: 100 }],
        } as never,
      }),
    ).rejects.toThrow(/Agent not found/);
  });
});

describe('rate limit', () => {
  it('counts requests per credential across processes', async () => {
    const key = `key-${randomUUID()}`;
    expect(await withinRateLimit(key, 2)).toBe(true);
    expect(await withinRateLimit(key, 2)).toBe(true);
    expect(await withinRateLimit(key, 2)).toBe(false);
  });
});

describe('rail identity', () => {
  it('refuses to give two members the same account', async () => {
    const w = await funded();
    const account = `acct_${w.tenantId}`;
    await setMemberRailRefs(w.tenantId, w.brand, { airwallex_account: account });
    await expect(
      setMemberRailRefs(w.tenantId, w.retailer, { airwallex_account: account }),
    ).rejects.toThrow(/already assigned/);
  });
});

describe('authority', () => {
  it('requires an agent on each side when the mandate is enforced', async () => {
    const w = await funded();
    const d = await submitDeal(w.platform, {
      idempotencyKey: 'no-agents',
      programKey: 'trade-assurance',
      buyerMemberId: w.retailer,
      sellerMemberId: w.brand,
      terms: {
        category: 'homeware',
        currency: 'EUR',
        lines: [{ description: 'x', quantity: 1, unitPrice: 100 }],
      } as never,
    });
    const done = await waitFor(d.id, ['rejected']);
    expect(done.statusReason).toMatch(/no buyer agent/);
  });

  it('concurrent deals cannot squeeze under a monthly limit', async () => {
    const w = await funded(undefined, { monthlyLimit: eur('2000') });
    await w.fund(w.brand, 'GBP', gbp('50000'));
    const deals = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        w.deal({
          buyer: 'brand',
          seller: 'supplier',
          quantity: 100,
          price: '10',
          key: `race-${i}`,
        }),
      ),
    );
    // Each is €1,000 against a €2,000 limit. The supplier posts no margin it lacks, so expect waits.
    await w.fund(w.supplier, 'EUR', eur('1000'));
    const settled = await Promise.all(
      deals.map((d) => waitFor(d.id, ['rejected', 'awaiting_conditions'])),
    );
    expect(settled.filter((d) => d.status === 'rejected')).toHaveLength(2);
  });
});

describe('decision gateway', () => {
  it('takes a model’s valid decision without involving a person', async () => {
    brain.current = scripted({ type: 'confirm' });
    const before = notified.length;
    const w = await funded({ 'trade-assurance': freezeEverything });
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    expect(notified.length).toBe(before);
  });

  it('refuses an action of the wrong type, records it, and lets the model correct itself', async () => {
    brain.current = scripted({ type: 'refund' }, { type: 'cancel' });
    const w = await funded({ 'trade-assurance': freezeEverything });
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['cancelled']);
    const { cases } = await dealDetail(d.id, w.platform);
    const records = await caseRecords(w.tenantId, cases[0]?.id as string);
    expect(records.map((r) => r.accepted)).toEqual([0, 1]);
    expect(records[0]?.violations[0]).toMatch(/not allowed/);
  });

  it('sends anything over the ceiling straight to a person', async () => {
    brain.current = scripted({ type: 'confirm' });
    const low: ProgramSpecInput = {
      ...freezeEverything,
      decisions: { ceiling: { EUR: 1000 } },
    };
    const w = await funded({ 'trade-assurance': low });
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    const c = await waitForCase(w.tenantId, d.id);
    await expect.poll(() => notified.some((n) => 'caseId' in n && n.caseId === c.id)).toBe(true);
    expect(await caseRecords(w.tenantId, c.id)).toHaveLength(0);
    await decideCase(c.id, w.platform, { bindingHash: c.bindingHash, action: { type: 'cancel' } });
    await waitFor(d.id, ['cancelled']);
  });

  it('falls through to a person when the model is down', async () => {
    brain.current = {
      name: 'down',
      async decide() {
        throw new Error('overloaded');
      },
    };
    const w = await funded({ 'trade-assurance': freezeEverything });
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    const c = await waitForCase(w.tenantId, d.id);
    await expect
      .poll(async () => notified.some((n) => 'caseId' in n && n.caseId === c.id), {
        timeout: 20_000,
      })
      .toBe(true);
    await decideCase(c.id, w.platform, { bindingHash: c.bindingHash, action: { type: 'cancel' } });
    await waitFor(d.id, ['cancelled']);
  });

  it('runs a rule fast path with no model at all', async () => {
    brain.current = undefined;
    const fast: ProgramSpecInput = {
      ...freezeEverything,
      decisions: {
        ceiling: { EUR: 5_000_000 },
        rules: [
          {
            id: 'ok',
            case: 'frozen',
            when: 'deal.amount < 500000',
            action: { type: 'confirm' },
            reason: 'small',
          },
        ],
      },
    };
    const w = await funded({ 'trade-assurance': fast });
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 10, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    const { cases } = await dealDetail(d.id, w.platform);
    expect((await caseRecords(w.tenantId, cases[0]?.id as string))[0]?.deciderType).toBe('rule');
  });

  it('a reprice runs authority again, so it cannot breach a limit', async () => {
    brain.current = undefined;
    const w = await makeWorld(
      rail,
      { 'trade-assurance': freezeEverything },
      { monthlyLimit: eur('1000') },
    );
    await w.fund(w.brand, 'GBP', gbp('50000'));
    await w.fund(w.supplier, 'EUR', eur('5000'));
    const d = await w.deal({ buyer: 'brand', seller: 'supplier', quantity: 10, price: '10' });
    const c = await waitForCase(w.tenantId, d.id);
    await decideCase(c.id, w.platform, {
      bindingHash: c.bindingHash,
      action: {
        type: 'reprice',
        lines: [{ description: 'Mug', quantity: 1000, unitPrice: eur('10').toString() }],
      },
    });
    const done = await waitFor(d.id, ['rejected']);
    expect(done.statusReason).toMatch(/monthly limit/);
  });

  it('a seller cannot waive its own late shipment', async () => {
    brain.current = undefined;
    const w = await funded();
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 100, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    await w.pass(d.id, { amount: eur('1500'), quantity: 100, shipped: '2026-11-20' });
    const c = await waitForCase(w.tenantId, d.id);
    await expect(
      decideCase(c.id, w.asMember(w.brand), {
        bindingHash: c.bindingHash,
        action: { type: 'waive' },
      }),
    ).rejects.toThrow(/Not allowed/);
    await decideCase(c.id, w.asMember(w.retailer), {
      bindingHash: c.bindingHash,
      action: { type: 'waive' },
    });
    await waitFor(d.id, ['eligible']);
  });

  it('new evidence invalidates a pending decision and reopens the case', async () => {
    brain.current = undefined;
    const w = await funded();
    const d = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 100, price: '15' });
    await waitFor(d.id, ['awaiting_conditions']);
    await w.pass(d.id, { amount: eur('1500'), quantity: 100, shipped: '2026-11-20' });
    const first = await waitForCase(w.tenantId, d.id);

    await submitFact(d.id, w.inspector, {
      kind: 'inspection',
      type: 'second',
      data: { passRate: 1 },
    });
    await expect(
      decideCase(first.id, w.platform, {
        bindingHash: first.bindingHash,
        action: { type: 'waive' },
      }),
    ).rejects.toThrow(/no longer matches|is stale/);

    await expect
      .poll(async () => (await waitForCase(w.tenantId, d.id)).id !== first.id, { timeout: 20_000 })
      .toBe(true);
    const second = await waitForCase(w.tenantId, d.id);
    await decideCase(second.id, w.platform, {
      bindingHash: second.bindingHash,
      action: { type: 'waive' },
    });
    await waitFor(d.id, ['eligible']);
  });
});
