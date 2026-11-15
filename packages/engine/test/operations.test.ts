import { DBOS } from '@dbos-inc/dbos-sdk';
import { agents as agentsTable } from '@novate/db';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dealDetail,
  type launchEngine,
  monitorWorkflow,
  openCases,
  resumeSettlement,
  runCycle,
  submitFact,
  tenantStatus,
} from '../src/index.ts';
import {
  boot,
  brain,
  controlEventsOf,
  eur,
  gbp,
  makeWorld,
  netProgram,
  personDecides,
  reconcile,
  shutdown,
  waitFor,
} from './harness.ts';

const rail = new MockRail();
let engine: Awaited<ReturnType<typeof launchEngine>>;
beforeAll(async () => {
  engine = await boot(rail);
});
afterAll(() => shutdown());

async function waitForReconCase(tenantId: string, runId: string) {
  let found: Awaited<ReturnType<typeof openCases>>[number] | undefined;
  await expect
    .poll(async () => {
      found = (await openCases(tenantId)).find((c) => c.subjectId === runId);
      return found;
    })
    .toBeDefined();
  return found as NonNullable<typeof found>;
}

const net = netProgram({ settlement: { rail: 'mock', fundingWindow: '2s' } });

describe('reconciliation', () => {
  it('stays clean through a normal cycle, then halts settlement on a real difference', async () => {
    brain.current = undefined;
    const w = await makeWorld(rail, { net });
    await w.fund(w.brand, 'EUR', eur('140'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '14',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await submitFact(d.id, w.asMember(w.brand), { kind: 'acceptance', type: 'b', data: {} });
    await waitFor(d.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(d.id, ['settled']);

    const clean = await reconcile(w.tenantId, 'mock');
    expect(clean.breaks).toEqual([]);

    rail.corrupt('EUR', 500n);
    const broken = await reconcile(w.tenantId, 'mock');
    expect(broken.breaks[0]?.kind).toBe('balance_mismatch');
    expect(broken.halted).toBe(true);

    const d2 = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 1,
      price: '14',
    });
    await waitFor(d2.id, ['awaiting_conditions']);
    await submitFact(d2.id, w.asMember(w.brand), { kind: 'acceptance', type: 'b', data: {} });
    await waitFor(d2.id, ['eligible']);
    expect((await runCycle(w.tenantId)).status).toBe('halted');

    rail.corrupt('EUR', -500n);
    // Fixing the rail is not enough: a person has to answer for the difference first.
    await expect(resumeSettlement(w.tenantId, w.person, { reason: 'rail fixed' })).rejects.toThrow(
      /1 unresolved break on Mock; case .* is waiting for a person/,
    );
    const recon = await waitForReconCase(w.tenantId, broken.runId);
    await personDecides(w, recon.id, {
      bindingHash: recon.bindingHash,
      action: { type: 'acknowledge', note: 'Test corruption, since reversed' },
      rationale: 'The rail balance was corrupted on purpose and put back',
    });
    await expect.poll(async () => (await tenantStatus(w.tenantId)).settlementHaltedAt).toBeNull();
    await w.fund(w.brand, 'EUR', eur('14'));
    expect((await runCycle(w.tenantId)).status).toBe('settled');
  });
});

describe('open-position monitor', () => {
  const lateSellerRisk: ProgramSpecInput = {
    ...presetInputs.tradeAssurance,
    overrides: [],
    margin: {
      mode: 'scored',
      baseBps: 500,
      maxBps: 2_000,
      adjustments: [
        { when: 'signals.fx.vol30d >= 0.0 && signals.watch.bad', addBps: 500, reason: 'bad' },
      ],
    },
    signals: ['history', 'fx', 'watch'],
    decisions: {
      ceiling: { EUR: 5_000_000 },
      rules: [
        {
          id: 'follow',
          case: 'margin_review',
          when: 'true',
          action: { type: 'resize_margin', bps: '$targetBps' },
          reason: 'follow the score',
        },
        {
          id: 'block',
          case: 'agent_review',
          when: 'true',
          action: { type: 'suspend_agent', agentId: '$agentId' },
          reason: 'stop',
        },
      ],
    },
  };

  it('tops up margin when risk rises, and suspends an agent whose seller cannot pay', async () => {
    brain.current = undefined;
    const { StaticSignalProvider } = await import('@novate/signals');
    let bad = false;
    if (!engine.signals.has('watch')) {
      engine.signals.register(new StaticSignalProvider('watch', () => ({ bad })));
    }
    const w = await makeWorld(rail, { t: lateSellerRisk });
    await w.fund(w.retailer, 'EUR', eur('2000'));
    await w.fund(w.brand, 'GBP', gbp('1000'));
    const d = await w.deal({
      program: 't',
      buyer: 'retailer',
      seller: 'brand',
      quantity: 100,
      price: '15',
    });
    await waitFor(d.id, ['awaiting_conditions']);

    bad = true;
    const first = await DBOS.startWorkflow(monitorWorkflow)(w.tenantId);
    const summary = await first.getResult();
    expect(summary.marginResized).toBe(1);
    expect(
      (await dealDetail(d.id, w.platform)).events.some((e) => e.type === 'margin_resized'),
    ).toBe(true);

    // A second seller, with an empty wallet after posting margin, cannot meet a call.
    const w2 = await makeWorld(rail, { t: lateSellerRisk });
    bad = false;
    await w2.fund(w2.retailer, 'EUR', eur('1500'));
    await w2.fund(w2.brand, 'GBP', 60_000n);
    const d2 = await w2.deal({
      program: 't',
      buyer: 'retailer',
      seller: 'brand',
      quantity: 100,
      price: '15',
    });
    await waitFor(d2.id, ['awaiting_conditions']);
    bad = true;
    const left = await w2.available(w2.brand, 'GBP');
    await drain(w2, left);
    const second = await (await DBOS.startWorkflow(monitorWorkflow)(w2.tenantId)).getResult();
    expect(second.marginCalls).toBe(1);
    expect(second.agentsSuspended).toBe(1);
    const [row] = await engine.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, w2.brandSeller));
    expect(row?.status).toBe('blocked');
    const [suspended] = await controlEventsOf(w2.tenantId, 'agent_suspended');
    expect(suspended?.actor).toEqual({ kind: 'system', via: 'system' });
    expect(suspended?.payload).toMatchObject({
      agentId: w2.brandSeller,
      caseId: expect.any(String),
      decidedBy: expect.any(String),
    });
  });
});

async function drain(w: Awaited<ReturnType<typeof makeWorld>>, amount: bigint) {
  if (amount === 0n) return;
  const { ledgerSpend } = await import('./spend.ts');
  await ledgerSpend(w.tenantId, w.brand, 'GBP', amount);
}

describe('agent reinstatement and margin calls', () => {
  it('reviews a suspended agent and can reinstate it', async () => {
    const program: ProgramSpecInput = {
      ...net,
      decisions: {
        ceiling: { EUR: 5_000_000 },
        rules: [
          {
            id: 'back',
            case: 'agent_review',
            when: 'true',
            action: { type: 'reinstate_agent', agentId: '$agentId' },
            reason: 'clean since suspension',
          },
        ],
      },
    };
    const w = await makeWorld(rail, { net: program });
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '1',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await engine.db
      .update(agentsTable)
      .set({ status: 'blocked' })
      .where(eq(agentsTable.id, w.retailerAgent));

    const summary = await (await DBOS.startWorkflow(monitorWorkflow)(w.tenantId)).getResult();
    expect(summary.agentsReinstated).toBe(1);
    const [row] = await engine.db
      .select()
      .from(agentsTable)
      .where(eq(agentsTable.id, w.retailerAgent));
    expect(row?.status).toBe('active');
  });
});
