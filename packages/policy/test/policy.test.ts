import { describe, expect, it } from 'vitest';
import {
  type ConditionContext,
  deepMerge,
  evaluateCondition,
  type Fact,
  findingsReason,
  ProgramSpec,
  presets,
  type RuleContext,
  releaseAmount,
  resolvePolicy,
} from '../src/index.ts';

const history = (
  o: Partial<Record<'buyerAgent' | 'buyer' | 'seller', Record<string, number>>> = {},
) => ({
  buyerAgent: { dealCount: 0, medianQuantity: 0, medianAmount: 0, ...o.buyerAgent },
  buyer: { completedDeals: 0, counterparties: 0, defaults: 0, ...o.buyer },
  seller: {
    completedDeals: 0,
    onTimeRate: 1,
    defectRate: 0,
    pricedDeals: 0,
    medianUnitPrice: 0,
    ...o.seller,
  },
});

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  deal: {
    amount: 1_400_000n,
    currency: 'EUR',
    quantity: 1_000,
    category: 'homeware',
    unitPrice: 1_400n,
    attributes: {},
  },
  buyer: { id: 'b', name: 'Brand', homeCurrency: 'GBP', attributes: {} },
  seller: { id: 's', name: 'Supplier', homeCurrency: 'EUR', attributes: {} },
  signals: { history: history(), fx: { vol30d: 0.05 } },
  ...over,
});

describe('resolvePolicy', () => {
  it('prefunds and charges base margin for an ordinary deal', () => {
    const r = resolvePolicy(presets.tradeAssurance, ctx());
    expect(r.fundingBps).toBe(10_000);
    expect(r.marginBps).toBe(500);
    expect(r.checks).toEqual([]);
  });

  it('freezes a quantity spike against the agent history', () => {
    const r = resolvePolicy(
      presets.tradeAssurance,
      ctx({
        deal: { ...ctx().deal, quantity: 10_000 },
        signals: {
          history: history({ buyerAgent: { dealCount: 1, medianQuantity: 1_000 } }),
          fx: { vol30d: 0.05 },
        },
      }),
    );
    expect(r.checks.map((c) => c.id)).toEqual(['quantity_spike']);
  });

  it('switches funding mode when an override fires on signals', () => {
    const r = resolvePolicy(
      presets.tradeAssurance,
      ctx({
        signals: {
          history: history({ buyer: { completedDeals: 12, counterparties: 4 } }),
          fx: { vol30d: 0.05 },
        },
      }),
    );
    expect(r.policy.funding).toEqual({
      mode: 'partial',
      bps: 2_000,
      timeout: '72h',
      currency: 'home',
      fxBufferBps: 300,
    });
    expect(r.fundingBps).toBe(2_000);
    expect(r.overridesApplied.map((o) => o.id)).toEqual(['trusted_buyer_partial']);
  });

  it('raises margin for an unreliable seller and clamps to bounds', () => {
    const r = resolvePolicy(
      presets.tradeAssurance,
      ctx({
        signals: {
          history: history({ seller: { completedDeals: 5, onTimeRate: 0.7 } }),
          fx: { vol30d: 0.05 },
        },
      }),
    );
    expect(r.marginBps).toBe(1_000);
    expect(r.marginTrace).toContain('+500bps the seller has missed deliveries');
  });

  it('rejects overrides that would produce an invalid policy', () => {
    const program = ProgramSpec.parse({
      ...presets.netSettlement,
      overrides: [{ id: 'bad', when: 'true', set: { funding: { mode: 'partial' } }, reason: 'x' }],
    });
    expect(() => resolvePolicy(program, ctx())).toThrow(/invalid policy/);
  });

  it('rejects invalid CEL at program validation time', () => {
    const r = ProgramSpec.safeParse({
      ...presets.netSettlement,
      checks: [{ id: 'x', when: 'deal.amount >', action: 'flag', reason: 'x' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('deepMerge', () => {
  it('replaces an object when its discriminator changes', () => {
    expect(
      deepMerge({ funding: { mode: 'partial', bps: 10 } }, { funding: { mode: 'prefunded' } }),
    ).toEqual({
      funding: { mode: 'prefunded' },
    });
  });
  it('supports dotted paths', () => {
    expect(deepMerge({ margin: { mode: 'fixed', bps: 100 } }, { 'margin.bps': 300 })).toEqual({
      margin: { mode: 'fixed', bps: 300 },
    });
  });
});

describe('release conditions (mug scenario)', () => {
  const condition = presets.tradeAssurance.release.condition;
  let n = 0;
  const fact = (kind: string, type: string, data: Record<string, unknown>): Fact => ({
    id: `f${++n}`,
    kind,
    type,
    source: 'test',
    data,
    createdAt: new Date().toISOString(),
  });
  const base = (facts: Fact[]): ConditionContext => ({
    deal: {
      amount: 1_400_000n,
      currency: 'EUR',
      quantity: 1_000,
      shipmentDate: '2026-11-02',
      authorisedAt: '2026-10-28T00:00:00Z',
    },
    facts,
    now: new Date('2026-11-10T00:00:00Z'),
  });
  const docs = (shipmentDate: string) => [
    fact('document', 'commercial_invoice', {
      fields: { amount: 1_400_000, currency: 'EUR', quantity: 1_000 },
    }),
    fact('document', 'packing_list', { fields: { quantity: 1_000 } }),
    fact('document', 'bill_of_lading', { fields: { shipmentDate } }),
  ];

  it('waits until every document and the inspection arrive', () => {
    expect(evaluateCondition(condition, base([])).state).toBe('pending');
    expect(evaluateCondition(condition, base(docs('2026-11-02'))).state).toBe('pending');
  });

  it('accepts a bill of lading one day late within the 3-day tolerance', () => {
    const facts = [
      ...docs('2026-11-03'),
      fact('inspection', 'third_party', { inspected: 1_000, passed: 920 }),
    ];
    const ctx = base(facts);
    expect(evaluateCondition(condition, ctx).state).toBe('satisfied');
    expect(releaseAmount(presets.tradeAssurance.release.amount, ctx)).toBe(1_288_000n);
  });

  it('blocks a late shipment beyond tolerance until it is waived', () => {
    const facts = [...docs('2026-11-08'), fact('inspection', 'third_party', { passRate: 1 })];
    const blocked = evaluateCondition(condition, base(facts));
    expect(blocked.state).toBe('blocked');
    expect(blocked.findings[0]?.code).toBe('bill_of_lading.shipment_late');
    facts.push(
      fact('waiver', 'buyer', {
        code: 'bill_of_lading.shipment_late',
        factId: blocked.findings[0]?.factId,
      }),
    );
    expect(evaluateCondition(condition, base(facts)).state).toBe('satisfied');
  });

  it('says what is wrong in words a person reads', () => {
    const facts = [
      fact('document', 'commercial_invoice', {
        fields: { amount: 1_620_000, currency: 'USD', quantity: 800 },
      }),
      fact('document', 'packing_list', { fields: { quantity: 1_000 } }),
      fact('document', 'bill_of_lading', { fields: { shipmentDate: '2026-11-06' } }),
      fact('inspection', 'third_party', { passRate: 0.41 }),
    ];
    const condition = {
      all: [
        {
          type: 'documents',
          require: ['commercial_invoice', 'packing_list', 'bill_of_lading'],
          match: {
            shipmentDateLateDays: 3,
            requireFields: { packing_list: ['quantity', 'grossWeight'] },
          },
        },
        { type: 'inspection', minPassRate: 0.8 },
      ],
    };
    const found = evaluateCondition(condition as never, base(facts)).findings;
    expect(Object.fromEntries(found.map((f) => [f.code, f.message]))).toEqual({
      'commercial_invoice.quantity_mismatch':
        'The commercial invoice quantity is 800, but the deal agreed 1000',
      'commercial_invoice.amount_mismatch':
        'The commercial invoice amount is 16200.00 EUR, but the deal agreed 14000.00 EUR',
      'commercial_invoice.currency_mismatch':
        'The commercial invoice is in USD, but the deal is in EUR',
      'packing_list.unreadable': 'The packing list has no gross weight',
      'bill_of_lading.shipment_late':
        'The bill of lading shows shipment 4 days after the agreed date, more than the 3 days allowed',
      'inspection.below_threshold':
        'The inspection passed 41.0% of the goods, below the 80.0% required',
    });
  });

  it('blocks when too many units fail inspection', () => {
    const facts = [...docs('2026-11-02'), fact('inspection', 'third_party', { passRate: 0.6 })];
    expect(evaluateCondition(condition, base(facts)).state).toBe('blocked');
  });

  it('any() releases on acceptance or elapsed time', () => {
    const c = presets.netSettlement.release.condition;
    expect(evaluateCondition(c, base([])).state).toBe('pending');
    expect(evaluateCondition(c, base([fact('acceptance', 'buyer', {})])).state).toBe('satisfied');
    expect(evaluateCondition(c, { ...base([]), now: new Date('2026-11-12T00:00:00Z') }).state).toBe(
      'satisfied',
    );
  });
});

describe('findings as a reason', () => {
  it('says each finding once, in sentences, with no doubled full stop', () => {
    expect(
      findingsReason([
        { message: 'The bill of lading has no shipment date' },
        { message: 'The bill of lading has no signature.' },
        { message: 'the bill of lading has no shipment date.' },
      ]),
    ).toBe('The bill of lading has no shipment date. The bill of lading has no signature');
  });
});
