import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { DomainError } from '@novate/core';
import { deals, marginCalls, members, tenants } from '@novate/db';
import { type ProgramSpecInput, presetInputs } from '@novate/policy';
import { MockRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  approveRequest,
  changePayee,
  dealEventFeed,
  ingestRailEvent,
  type launchEngine,
  listApprovals,
  memberMargin,
  memberStatement,
  monitorWorkflow,
  notify,
  provisionMember,
  requestWithdrawal,
  setAgentStatus,
  stopSettlement,
  suspendMember,
  unattributedDepositsOf,
  withdrawalDetail,
} from '../src/index.ts';
import { record } from '../src/repo.ts';
import {
  assignRailRefs,
  boot,
  brain,
  eur,
  gbp,
  makeWorld,
  netProgram,
  notified,
  notifierOutage,
  provisionEurMember,
  reconcile,
  sent,
  shutdown,
  waitFor,
} from './harness.ts';

const rail = new MockRail();
const failing = new Set<string>();
const flaky = new MockRail({ name: 'flaky', failPayoutsFor: failing });
const orphans = new MockRail({ name: 'orphans' });
let engine: Awaited<ReturnType<typeof launchEngine>>;
beforeAll(async () => {
  engine = await boot(rail, [flaky, orphans]);
});
afterAll(() => shutdown());

type World = Awaited<ReturnType<typeof makeWorld>>;
const net = netProgram();
const ccp: ProgramSpecInput = {
  ...presetInputs.centralCounterparty,
  signals: ['history'],
  settlement: { rail: 'mock', netting: 'multilateral', fundingWindow: '1s' },
};
const withdraw = (
  w: World,
  memberId: string,
  amount: bigint,
  onRail = 'mock',
  key = randomUUID(),
) =>
  sent(
    requestWithdrawal(w.tenantId, w.asMember(memberId), memberId, {
      currency: 'EUR',
      amount,
      rail: onRail,
      idempotencyKey: key,
    }),
  );
const monitor = async (tenantId: string) =>
  (await DBOS.startWorkflow(monitorWorkflow)(tenantId)).getResult();
const settled = (w: World, memberId: string, id: string) =>
  expect
    .poll(async () => (await withdrawalDetail(w.tenantId, memberId, id)).at(-1)?.status, {
      timeout: 20_000,
    })
    .toBe('confirmed');

describe('withdrawals', () => {
  it('pays a member out once, however many times it is asked', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const key = randomUUID();
    const { id } = await withdraw(w, w.retailer, eur('60'), 'mock', key);
    expect((await withdraw(w, w.retailer, eur('60'), 'mock', key)).id).toBe(id);
    await settled(w, w.retailer, id);
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('40'));
    expect(rail.log.filter((p) => p.req.member.id === w.retailer)).toHaveLength(1);
  });

  it('refuses more than the wallet holds', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.retailer, 'EUR', eur('10'));
    await expect(withdraw(w, w.retailer, eur('11'))).rejects.toThrow('not enough');
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('10'));
  });

  it('refuses a suspended member', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.retailer, 'EUR', eur('10'));
    await suspendMember(w.tenantId, w.platform, w.retailer, { reason: 'test' });
    await expect(withdraw(w, w.retailer, eur('5'))).rejects.toThrow('suspended');
  });

  it('returns the money to the wallet if the rail fails', async () => {
    const w = await makeWorld(flaky as never, { net: { ...net, settlement: { rail: 'flaky' } } });
    brain.current = {
      name: 'stub',
      decide: async () => ({ action: { type: 'escalate', note: 'no' }, rationale: 'r' }),
    };
    await w.fund(w.retailer, 'EUR', eur('30'));
    failing.add(w.retailer);
    const { id } = await withdraw(w, w.retailer, eur('30'), 'flaky');
    await expect.poll(() => w.available(w.retailer, 'EUR'), { timeout: 20_000 }).toBe(eur('30'));
    expect((await withdrawalDetail(w.tenantId, w.retailer, id))[0]?.status).toBe('failed');
  });
});

describe('what a member and a platform can see', () => {
  it('gives a statement of every movement', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const { id } = await withdraw(w, w.retailer, eur('40'));
    await settled(w, w.retailer, id);
    const { lines, closingBalance } = await memberStatement(w.tenantId, w.retailer);
    expect(closingBalance).toEqual([{ currency: 'EUR', amount: eur('60'), available: eur('60') }]);
    expect(lines.map((l) => [l.kind, l.amount])).toEqual(
      expect.arrayContaining([
        ['deposit', eur('100')],
        ['withdrawal', -eur('40')],
      ]),
    );
  });

  it('feeds deal events in order and resumes from a cursor', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.brand, 'EUR', eur('50'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    await expect
      .poll(async () => (await dealEventFeed(w.tenantId, 0n)).events.length, { timeout: 15_000 })
      .toBeGreaterThan(1);
    const { events, next } = await dealEventFeed(w.tenantId, 0n);
    expect(events.every((e) => e.dealId === d.id)).toBe(true);
    // The deal is still moving, so more may follow, but never anything already read.
    const later = await dealEventFeed(w.tenantId, next);
    expect(later.events.every((e) => e.seq > next)).toBe(true);
  });

  it('never moves the cursor past an event a slower transaction has yet to commit', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.brand, 'EUR', eur('50'));
    const d = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(d.id, ['awaiting_conditions']);
    const { db } = deps();
    const drained = async (after: bigint) => {
      let cursor = after;
      const seen: { seq: bigint; type: string; payload: Record<string, unknown> }[] = [];
      for (;;) {
        const page = await dealEventFeed(w.tenantId, cursor);
        if (!page.events.length) return { seen, cursor };
        seen.push(...page.events);
        cursor = page.next;
      }
    };
    await expect.poll(async () => (await drained(0n)).seen.length).toBeGreaterThan(1);
    const start = (await drained(0n)).cursor;

    // The slow transaction takes the lower seq; a quick one takes a higher seq and commits first.
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let written = () => {};
    const slowWrote = new Promise<void>((r) => {
      written = r;
    });
    const slow = db.transaction(async (t) => {
      await record(t, d.id, 'fact_added', { probe: 'slow' });
      written();
      await held;
    });
    await slowWrote;
    await db.transaction((t) => record(t, d.id, 'fact_added', { probe: 'quick' }));

    const before = await drained(start);
    expect(before.seen.map((e) => e.payload.probe)).not.toContain('quick');

    release();
    await slow;
    // The deal's workflow keeps writing; while one of its transactions is open the feed withholds
    // everything after it, so read on as a consumer would.
    const probes: unknown[] = [];
    let cursor = before.cursor;
    await expect
      .poll(async () => {
        const page = await drained(cursor);
        cursor = page.cursor;
        probes.push(...page.seen.map((e) => e.payload.probe));
        return probes;
      })
      .toEqual(expect.arrayContaining(['slow', 'quick']));
    expect(probes.indexOf('slow')).toBeLessThan(probes.indexOf('quick'));
  });
});

describe('manual stops', () => {
  it('refuses new deals from an agent that has been switched off', async () => {
    const w = await makeWorld(rail, { net });
    await setAgentStatus(w.tenantId, w.platform, w.retailerAgent, 'blocked');
    const d = await w.deal({
      program: 'net',
      buyer: 'retailer',
      seller: 'supplier',
      quantity: 1,
      price: '1',
    });
    await waitFor(d.id, ['rejected']);
  });

  it('can stop all settlement for a tenant', async () => {
    const w = await makeWorld(rail, { net });
    await stopSettlement(w.tenantId, w.platform, { reason: 'operator stop' });
    const [t] = await engine.db.select().from(tenants).where(eq(tenants.id, w.tenantId));
    expect(t?.settlementHaltReason).toBe('operator stop');
  });
});

describe('margin calls under strain', () => {
  const short = async () => {
    rail.rates['EUR/GBP'] = 0.87;
    const w = await makeWorld(rail, { ccp });
    await w.fund(w.brand, 'GBP', gbp('60'));
    const d = await w.deal({
      program: 'ccp',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 10,
      price: '100',
    });
    await waitFor(d.id, ['awaiting_conditions', 'cancelled']);
    return { w, d };
  };
  const overdue = async (w: World) => {
    rail.rates['EUR/GBP'] = 1.4;
    await monitor(w.tenantId);
    const call = (await memberMargin(w.tenantId, w.brand)).openCall;
    expect(call).not.toBeNull();
    await engine.db
      .update(marginCalls)
      .set({ dueAt: new Date(Date.now() - 1_000) })
      .where(eq(marginCalls.id, call?.id as string));
    return call;
  };
  const answering = (type: string) => {
    brain.current = { name: 'stub', decide: async () => ({ action: { type }, rationale: 'r' }) };
  };

  it('does not let a margin default lift a suspension', async () => {
    const { w } = await short();
    await overdue(w);
    await suspendMember(w.tenantId, w.platform, w.brand, { reason: 'test' });
    answering('declare_default');
    expect((await monitor(w.tenantId)).portfolio.defaults).toBe(1);
    const [m] = await engine.db.select().from(members).where(eq(members.id, w.brand));
    expect(m?.status).toBe('suspended');
    rail.rates['EUR/GBP'] = 0.87;
  });

  it('keeps a member in good standing when nobody could decide, and says so', async () => {
    const { w } = await short();
    const call = await overdue(w);
    brain.current = {
      name: 'down',
      decide: async () => {
        throw new Error('overloaded');
      },
    };
    const summary = await monitor(w.tenantId);
    expect(summary.portfolio).toMatchObject({ extended: 1, defaults: 0 });
    const [m] = await engine.db.select().from(members).where(eq(members.id, w.brand));
    expect(m?.status).toBe('active');
    expect((await memberMargin(w.tenantId, w.brand)).openCall?.id).toBe(call?.id);
    rail.rates['EUR/GBP'] = 0.87;
  });
});

describe('notifications', () => {
  it('keeps trying a receiver that is down, with the same id', async () => {
    notifierOutage.remaining = 1;
    const reason = `outage-${randomUUID()}`;
    await notify({ type: 'settlement_stopped', tenantId: randomUUID(), reason });
    await expect
      .poll(() => notified.filter((n) => 'reason' in n && n.reason === reason).length, {
        timeout: 20_000,
      })
      .toBe(1);
    expect(notified.find((n) => 'reason' in n && n.reason === reason)?.id).toBeTruthy();
  });
});

describe('work that must survive a failure', () => {
  it('retries a rail event that fails instead of losing the money', async () => {
    const w = await makeWorld(rail, { net });
    const account = `ga-${randomUUID()}`;
    await assignRailRefs(w, w.retailer, { orphans_deposit_account: account });
    deps().railOwners.orphans = w.tenantId;
    const failOnce = vi.spyOn(deps().ledger, 'post').mockRejectedValueOnce(new Error('db blip'));
    try {
      await ingestRailEvent(
        'orphans',
        JSON.stringify({
          id: randomUUID(),
          type: 'deposit.settled',
          occurredAt: new Date().toISOString(),
          externalRef: `dep-${randomUUID()}`,
          depositAccountRef: account,
          currency: 'EUR',
          amount: String(eur('25')),
          raw: {},
        }),
        {},
      );
      await expect.poll(() => w.available(w.retailer, 'EUR'), { timeout: 20_000 }).toBe(eur('25'));
    } finally {
      failOnce.mockRestore();
      delete deps().railOwners.orphans;
    }
  });

  it('starts a deal that was saved but never got a workflow', async () => {
    const w = await makeWorld(rail, { net });
    await w.fund(w.brand, 'EUR', eur('50'));
    const original = await w.deal({
      program: 'net',
      buyer: 'brand',
      seller: 'supplier',
      quantity: 5,
      price: '10',
    });
    await waitFor(original.id, ['awaiting_conditions']);
    const [row] = await engine.db.select().from(deals).where(eq(deals.id, original.id));
    const { id: _id, ...copy } = row as typeof deals.$inferSelect;
    const [stranded] = await engine.db
      .insert(deals)
      .values({
        ...copy,
        status: 'submitted',
        policySnapshot: null,
        idempotencyKey: randomUUID(),
        createdAt: new Date(Date.now() - 120_000),
      })
      .returning();
    await monitor(w.tenantId);
    await waitFor(stranded?.id as string, ['awaiting_conditions']);
  });

  it('provisions once per attempt and records the accounts', async () => {
    const w = await makeWorld(rail, { net });
    deps().railOwners.orphans = w.tenantId;
    let calls = 0;
    const provisionable = orphans as unknown as {
      provision?: () => Promise<Record<string, string>>;
    };
    provisionable.provision = async () => {
      calls++;
      return { orphans_deposit_account: `ga-${w.retailer}` };
    };
    try {
      const input = {
        rail: 'orphans',
        countryCode: 'NL',
        currency: 'EUR',
        beneficiary: {},
        transferMethods: ['LOCAL'] as ('LOCAL' | 'SWIFT')[],
        idempotencyKey: randomUUID(),
      };
      await provisionMember(w.tenantId, w.house, w.retailer, input);
      await provisionMember(w.tenantId, w.house, w.retailer, input);
      expect(calls).toBe(1);
      const [m] = await engine.db.select().from(members).where(eq(members.id, w.retailer));
      expect(m?.railRefs.orphans_deposit_account).toBe(`ga-${w.retailer}`);
    } finally {
      delete provisionable.provision;
      delete deps().railOwners.orphans;
    }
  });
  it('takes a rail refusal as the answer, without retrying it', async () => {
    const w = await makeWorld(rail, { net });
    deps().railOwners.orphans = w.tenantId;
    let calls = 0;
    const provisionable = orphans as unknown as {
      provision?: () => Promise<Record<string, string>>;
    };
    provisionable.provision = async () => {
      calls++;
      throw new DomainError('rail_refused', 'No more EUR accounts in DE');
    };
    try {
      await expect(
        provisionMember(w.tenantId, w.house, w.retailer, {
          rail: 'orphans',
          countryCode: 'DE',
          currency: 'EUR',
          beneficiary: {},
          transferMethods: ['LOCAL'],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'rail_refused', message: 'No more EUR accounts in DE' });
      expect(calls).toBe(1);
    } finally {
      delete provisionable.provision;
      delete deps().railOwners.orphans;
    }
  });
});

describe('changing where a member is paid', () => {
  const payee = (key = randomUUID()) => ({
    rail: 'mock',
    transferMethods: ['LOCAL'] as ('LOCAL' | 'SWIFT')[],
    idempotencyKey: key,
    reason: 'Supplier changed bank',
    beneficiary: {
      bank_details: {
        account_currency: 'EUR',
        account_name: 'Dutch retailer',
        bank_name: 'ING',
        iban: 'NL69INGB0123456789',
      },
    },
  });
  const refsOf = async (memberId: string) =>
    (await engine.db.select().from(members).where(eq(members.id, memberId)))[0]?.railRefs;

  it('creates the payee on the rail and switches to it once a second person approves', async () => {
    const w = await makeWorld(rail, { net });
    await provisionEurMember(w, w.retailer);
    const before = await refsOf(w.retailer);
    const input = payee();
    const out = await changePayee(w.tenantId, w.house, w.retailer, input);
    expect(out).toMatchObject({ status: 'pending_approval', kind: 'rail_refs' });
    // The same attempt again is the same request, not a second payee.
    expect(await changePayee(w.tenantId, w.house, w.retailer, input)).toEqual(out);
    const held = await listApprovals(w.tenantId, null, { kind: 'rail_refs' });
    expect(held.rows).toHaveLength(1);
    expect(await refsOf(w.retailer)).toEqual(before);
    if (out.status !== 'pending_approval') throw new Error('not held');
    await approveRequest(w.tenantId, w.checker, out.approvalId);
    const after = await refsOf(w.retailer);
    expect(after?.mock_beneficiary).not.toBe(before?.mock_beneficiary);
    expect(after?.mock_payout_label).toBe('ING ••••6789');
    expect(after?.mock_deposit_account).toBe(before?.mock_deposit_account);
  });

  it('asks nothing when the rail refuses the payee, a key asks, or there is no payee yet', async () => {
    const w = await makeWorld(rail, { net });
    await expect(changePayee(w.tenantId, w.house, w.retailer, payee())).rejects.toMatchObject({
      code: 'conflict',
    });
    await provisionEurMember(w, w.retailer);
    const before = await refsOf(w.retailer);
    await expect(
      changePayee(w.tenantId, { ...w.house, userId: undefined }, w.retailer, payee()),
    ).rejects.toMatchObject({ code: 'person_required' });
    const refused = vi
      .spyOn(rail, 'addPayee')
      .mockRejectedValueOnce(new DomainError('rail_refused', 'Bank details refused'));
    try {
      await expect(changePayee(w.tenantId, w.house, w.retailer, payee())).rejects.toMatchObject({
        code: 'rail_refused',
      });
    } finally {
      refused.mockRestore();
    }
    expect((await listApprovals(w.tenantId, null, { kind: 'rail_refs' })).rows).toEqual([]);
    expect(await refsOf(w.retailer)).toEqual(before);
    // A new attempt after the refusal goes through.
    expect(await changePayee(w.tenantId, w.house, w.retailer, payee())).toMatchObject({
      status: 'pending_approval',
    });
  });
});

describe('deposit events out of order', () => {
  const event = (type: string, externalRef: string, account: string) =>
    ingestRailEvent(
      'orphans',
      JSON.stringify({
        id: randomUUID(),
        type,
        occurredAt: new Date().toISOString(),
        externalRef,
        depositAccountRef: account,
        currency: 'EUR',
        amount: String(eur('80')),
        raw: {},
      }),
      {},
    );

  it('nets to nothing for a member when the recall arrives first', async () => {
    const w = await makeWorld(rail, { net });
    const account = `ga-${randomUUID()}`;
    await assignRailRefs(w, w.retailer, { orphans_deposit_account: account });
    deps().railOwners.orphans = w.tenantId;
    try {
      const ref = `dep-${randomUUID()}`;
      await event('deposit.reversed', ref, account);
      await event('deposit.settled', ref, account);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await w.available(w.retailer, 'EUR')).toBe(0n);
      const [m] = await engine.db.select().from(members).where(eq(members.id, w.retailer));
      expect(m?.status).toBe('active');
    } finally {
      delete deps().railOwners.orphans;
    }
  });

  it('leaves nothing to assign when a recall overtakes an unmatched deposit', async () => {
    const w = await makeWorld(rail, { net });
    deps().railOwners.orphans = w.tenantId;
    try {
      const ref = `dep-${randomUUID()}`;
      await event('deposit.reversed', ref, 'ga-nobody');
      await event('deposit.settled', ref, 'ga-nobody');
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await unattributedDepositsOf(w.tenantId)).toHaveLength(0);
      await reconcile(w.tenantId, 'orphans');
    } finally {
      delete deps().railOwners.orphans;
    }
  });
});
