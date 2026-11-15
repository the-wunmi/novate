import type { CaseView } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submitFact } from '../src/index.ts';
import { boot, brain, eur, makeWorld, netProgram, shutdown, waitFor } from './harness.ts';

/**
 * The evaluation set in `packages/agents/eval` builds cases by hand. These tests pin down that the
 * gateway really shows a model what those cases assume it can see.
 */
const rail = new MockRail();
beforeAll(async () => {
  await boot(rail);
});
afterAll(() => shutdown());

const net = netProgram({ signals: ['history'] });

function capturing(type: string, extra: Record<string, unknown> = {}) {
  const seen: CaseView[] = [];
  brain.current = {
    name: 'capture',
    async decide(view) {
      seen.push(view);
      return { action: { type, ...extra }, rationale: 'captured' };
    },
  };
  return seen;
}

describe('what a model is shown', () => {
  it('shows the parties record on a frozen deal', async () => {
    const seen = capturing('cancel');
    const w = await makeWorld(rail, {
      p: {
        ...net,
        checks: [{ id: 'always', when: 'true', action: 'freeze', reason: 'looks wrong' }],
      },
    });
    const d = await w.deal({
      program: 'p',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(d.id, ['cancelled']);
    const evidence = seen[0]?.shown.evidence as { signals: { history: { seller: unknown } } };
    expect(evidence.signals.history.seller).toMatchObject({ completedDeals: 0 });
  });

  it('shows what each document and inspection said, but not how it was read', async () => {
    const seen = capturing('escalate', { note: 'captured' });
    const w = await makeWorld(rail, {
      p: {
        ...net,
        release: {
          condition: {
            all: [
              { type: 'documents', require: ['commercial_invoice'] },
              { type: 'inspection', minPassRate: 0.9 },
            ],
          },
          onBlocked: 'escalate',
        },
      },
    });
    const d = await w.deal({
      program: 'p',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await submitFact(d.id, w.platform, {
      kind: 'document',
      type: 'commercial_invoice',
      data: {
        fields: { amount: Number(eur('99')), currency: 'EUR', quantity: 5 },
        extraction: { reader: 'secret-detail' },
      },
    });
    await submitFact(d.id, w.inspector, {
      kind: 'inspection',
      type: 'third_party',
      data: { passRate: 0.5 },
    });
    await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const facts = seen.at(-1)?.shown.facts as { kind: string; data: Record<string, unknown> }[];
    const doc = facts.find((f) => f.kind === 'document');
    expect(doc?.data.fields).toMatchObject({ currency: 'EUR', quantity: 5 });
    expect(doc?.data.extraction).toBeUndefined();
    expect(facts.find((f) => f.kind === 'inspection')?.data).toEqual({ passRate: 0.5 });
  });
});
