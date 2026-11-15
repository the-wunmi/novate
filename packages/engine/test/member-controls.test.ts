import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Principal } from '@novate/core';
import { approvalDecisions, cycles, marginCalls } from '@novate/db';
import { MockRail } from '@novate/rails';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deps } from '../src/deps.ts';
import {
  approveRequest,
  dealDetail,
  dealsCsv,
  decideCase,
  listAgents,
  listApprovals,
  listDeals,
  memberAccount,
  memberSettlement,
  memberWithdrawals,
  monitorWorkflow,
  rejectRequest,
  requestWithdrawal,
  runCycle,
  setMemberControls,
  submitDocument,
  submitFact,
  withdrawalDetail,
} from '../src/index.ts';
import {
  acceptedDeal,
  boot,
  controlEventsOf,
  eur,
  gbp,
  makeWorld,
  netProgram,
  personDecides,
  shutdown,
  type World,
  waitFor,
  waitForCase,
} from './harness.ts';

const rail = new MockRail();
let reads = 0;
beforeAll(() =>
  boot(rail, [], {
    documentReader: {
      read: async () => {
        reads += 1;
        return { fields: { note: 'Photo of broken mugs' }, issues: [], extraction: {} };
      },
    },
  }),
);
afterAll(() => shutdown());

/** One of a member's own people, signed in. */
const userOf = (w: World, memberId: string, name: string): Principal => ({
  ...w.asMember(memberId),
  id: `user-${name}`,
  userId: randomUUID(),
  name,
});

const withdraw = (w: World, as: Principal, amount: bigint, key = randomUUID()) =>
  requestWithdrawal(w.tenantId, as, w.retailer, {
    currency: 'EUR',
    amount,
    rail: rail.name,
    idempotencyKey: key,
  });

const paidOut = (w: World, id: string) =>
  expect
    .poll(async () => (await withdrawalDetail(w.tenantId, w.retailer, id)).at(-1)?.status, {
      timeout: 20_000,
    })
    .toBe('confirmed');

describe("a member's own four eyes on withdrawals", () => {
  it('holds a withdrawal past its threshold for a second of its users, once', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const ann = userOf(w, w.retailer, 'Ann');
    const bob = userOf(w, w.retailer, 'Bob');
    const carol = userOf(w, w.supplier, 'Carol');

    // Only the member's own people set it, and a key is not a person.
    await expect(
      setMemberControls(w.tenantId, w.asMember(w.retailer), w.retailer, {
        withdrawalFourEyesAbove: { EUR: eur('10') },
        reason: 'policy',
      }),
    ).rejects.toMatchObject({ code: 'person_required' });
    await expect(
      setMemberControls(w.tenantId, carol, w.retailer, {
        withdrawalFourEyesAbove: { EUR: eur('10') },
        reason: 'policy',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      setMemberControls(w.tenantId, w.house, w.retailer, {
        withdrawalFourEyesAbove: {},
        reason: 'policy',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // Tightening applies at once.
    expect(
      await setMemberControls(w.tenantId, ann, w.retailer, {
        withdrawalFourEyesAbove: { EUR: eur('10') },
        reason: 'treasury policy',
      }),
    ).toEqual({ status: 'changed' });
    expect((await memberAccount(w.tenantId, w.retailer)).withdrawalFourEyesAbove).toEqual({
      EUR: String(eur('10')),
    });

    // At or below the threshold it goes straight out.
    const small = await withdraw(w, ann, eur('10'));
    expect('id' in small).toBe(true);

    // Above it, it waits, and asking again with the same key finds the same request.
    const key = randomUUID();
    const held = await withdraw(w, ann, eur('50'), key);
    expect(held).toMatchObject({ status: 'pending_approval', kind: 'member_withdrawal' });
    expect(await withdraw(w, ann, eur('50'), key)).toMatchObject({
      approvalId: (held as { approvalId: string }).approvalId,
    });
    const approvalId = (held as { approvalId: string }).approvalId;
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('90'));
    expect((await listApprovals(w.tenantId, w.retailer)).rows.map((r) => r.approvalId)).toEqual([
      approvalId,
    ]);
    expect((await listApprovals(w.tenantId, w.supplier)).rows).toEqual([]);
    // A key cannot ask past the threshold: that needs a person.
    await expect(withdraw(w, w.asMember(w.retailer), eur('50'))).rejects.toMatchObject({
      code: 'person_required',
    });

    // Not the requester, not the house, not another member's people.
    await expect(approveRequest(w.tenantId, ann, approvalId)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(approveRequest(w.tenantId, w.checker, approvalId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(approveRequest(w.tenantId, carol, approvalId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await approveRequest(w.tenantId, bob, approvalId);
    const [opened] = await controlEventsOf(w.tenantId, 'withdrawal_requested').then((events) =>
      events.filter((e) => e.payload.amount === String(eur('50'))),
    );
    const id = String(opened?.payload.withdrawalId);
    await paidOut(w, id);
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('40'));
    // Sent as the person who asked for it.
    const [cycle] = await deps().db.select().from(cycles).where(eq(cycles.id, id));
    expect(cycle?.requestedBy).toMatchObject({ userId: ann.userId });
    await expect(approveRequest(w.tenantId, bob, approvalId)).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('refuses, and moves nothing, when the money went before the approval came', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('60'));
    const ann = userOf(w, w.retailer, 'Ann');
    const bob = userOf(w, w.retailer, 'Bob');
    await setMemberControls(w.tenantId, ann, w.retailer, {
      withdrawalFourEyesAbove: { EUR: eur('10') },
      reason: 'policy',
    });
    await expect(withdraw(w, ann, eur('70'))).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    const first = (await withdraw(w, ann, eur('50'))) as { approvalId: string };
    const second = (await withdraw(w, ann, eur('50'))) as { approvalId: string };
    await approveRequest(w.tenantId, bob, first.approvalId);
    await expect.poll(() => w.available(w.retailer, 'EUR'), { timeout: 20_000 }).toBe(eur('10'));
    await expect(approveRequest(w.tenantId, bob, second.approvalId)).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    // Nothing was recorded: the request is still open, to be rejected or approved once funded.
    expect(
      (await listApprovals(w.tenantId, w.retailer)).rows.map((r) => [r.approvalId, r.status]),
    ).toEqual([[second.approvalId, 'pending']]);
    expect(await controlEventsOf(w.tenantId, 'approval_approved')).toHaveLength(1);
    await w.fund(w.retailer, 'EUR', eur('40'));
    await approveRequest(w.tenantId, bob, second.approvalId);
    await expect.poll(() => w.available(w.retailer, 'EUR'), { timeout: 20_000 }).toBe(0n);
    const refused = (await controlEventsOf(w.tenantId, 'withdrawal_requested')).filter(
      (e) => e.payload.status === 'refused',
    );
    expect(refused).toHaveLength(0);
  });

  it('sends an approved withdrawal that was never started, and refuses a rejected one', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const ann = userOf(w, w.retailer, 'Ann');
    const bob = userOf(w, w.retailer, 'Bob');
    await setMemberControls(w.tenantId, ann, w.retailer, {
      withdrawalFourEyesAbove: { EUR: eur('10') },
      reason: 'policy',
    });
    // The approval commits and the process dies before the withdrawal starts.
    const approvedOnly = async (approvalId: string, createdAt = new Date()) => {
      await deps()
        .db.insert(approvalDecisions)
        .values({
          requestId: approvalId,
          tenantId: w.tenantId,
          decision: 'approved',
          actor: { kind: 'member', userId: bob.userId, via: 'session' },
          createdAt,
        });
    };

    // Asking again with the same key sends it.
    const retried = randomUUID();
    const one = (await withdraw(w, ann, eur('20'), retried)) as { approvalId: string };
    await approvedOnly(one.approvalId);
    const sent = await withdraw(w, ann, eur('20'), retried);
    expect(sent).toEqual({ id: one.approvalId });
    await paidOut(w, one.approvalId);

    // Nobody asks again: the monitor sends it.
    const two = (await withdraw(w, ann, eur('30'))) as { approvalId: string };
    await approvedOnly(two.approvalId, new Date(Date.now() - 120_000));
    await (await DBOS.startWorkflow(monitorWorkflow)(w.tenantId)).getResult();
    await paidOut(w, two.approvalId);
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('50'));
    const [cycle] = await deps().db.select().from(cycles).where(eq(cycles.id, two.approvalId));
    expect(cycle?.requestedBy).toMatchObject({ userId: ann.userId });

    // A rejected request is not asked again by repeating the key.
    const rejectedKey = randomUUID();
    const three = (await withdraw(w, ann, eur('20'), rejectedKey)) as { approvalId: string };
    await rejectRequest(w.tenantId, bob, three.approvalId, { reason: 'not now' });
    await expect(withdraw(w, ann, eur('20'), rejectedKey)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(await w.available(w.retailer, 'EUR')).toBe(eur('50'));
  });

  it('holds raising or removing a threshold for a second user', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const ann = userOf(w, w.retailer, 'Ann');
    const bob = userOf(w, w.retailer, 'Bob');
    await setMemberControls(w.tenantId, ann, w.retailer, {
      withdrawalFourEyesAbove: { EUR: eur('10'), USD: '1000' },
      reason: 'policy',
    });
    const raised = await setMemberControls(w.tenantId, ann, w.retailer, {
      withdrawalFourEyesAbove: { EUR: eur('1000') },
      reason: 'too many approvals',
    });
    expect(raised).toMatchObject({ status: 'pending_approval', kind: 'member_controls' });
    expect((await memberAccount(w.tenantId, w.retailer)).withdrawalFourEyesAbove).toEqual({
      EUR: String(eur('10')),
      USD: '1000',
    });
    const approvalId = (raised as { approvalId: string }).approvalId;
    await approveRequest(w.tenantId, bob, approvalId);
    expect((await memberAccount(w.tenantId, w.retailer)).withdrawalFourEyesAbove).toEqual({
      EUR: String(eur('1000')),
    });
    const [changed] = (await controlEventsOf(w.tenantId, 'member_controls_changed')).slice(-1);
    expect(changed).toMatchObject({
      reason: 'too many approvals',
      actor: { userId: ann.userId },
      payload: { memberId: w.retailer, approvalId, approvedBy: { userId: bob.userId } },
    });

    // A request approved after the controls moved would not be what the approver saw.
    const again = (await setMemberControls(w.tenantId, ann, w.retailer, {
      withdrawalFourEyesAbove: {},
      reason: 'off',
    })) as { approvalId: string };
    await setMemberControls(w.tenantId, bob, w.retailer, {
      withdrawalFourEyesAbove: { EUR: eur('5') },
      reason: 'tighter',
    });
    await expect(approveRequest(w.tenantId, bob, again.approvalId)).rejects.toMatchObject({
      code: 'conflict',
    });
    await rejectRequest(w.tenantId, ann, again.approvalId, { reason: 'withdrawn' });
  });
});

describe('claims by either side', () => {
  /** A deal released at 80% after a late shipment, then settled. */
  async function partlyReleased(w: World) {
    await w.fund(w.retailer, 'EUR', eur('1500'));
    await w.fund(w.brand, 'GBP', gbp('500'));
    const deal = await w.deal({ buyer: 'retailer', seller: 'brand', quantity: 100, price: '15' });
    await waitFor(deal.id, ['awaiting_conditions']);
    // Either side may dispute while the deal is open, each for its own reasons.
    await expect(
      submitFact(deal.id, w.asMember(w.brand), {
        kind: 'dispute',
        type: 'dispute',
        data: { category: 'quality', reason: 'not ours to say' },
      }),
    ).rejects.toThrow('not_paid, short_paid, other');
    await w.pass(deal.id, { amount: eur('1500'), quantity: 100, shipped: '2026-11-09' });
    await waitFor(deal.id, ['held']);
    const c = await waitForCase(w.tenantId, { dealId: deal.id });
    await personDecides(w, c.id, {
      bindingHash: c.bindingHash,
      rationale: 'Late, so 80%',
      action: { type: 'release_partial', bps: 8_000 },
    });
    await waitFor(deal.id, ['eligible']);
    await runCycle(w.tenantId);
    await waitFor(deal.id, ['settled']);
    return deal.id;
  }

  it("pays a seller paid short what was held back, from the buyer's wallet", async () => {
    const w = await makeWorld(rail);
    const dealId = await partlyReleased(w);
    const brandBefore = await w.available(w.brand, 'EUR');
    const retailerBefore = await w.available(w.retailer, 'EUR');
    expect(retailerBefore).toBe(eur('300'));

    await expect(
      submitFact(dealId, w.asMember(w.brand), {
        kind: 'dispute',
        type: 'claim',
        data: { category: 'short_paid', reason: 'all delivered', amount: String(eur('400')) },
      }),
    ).rejects.toThrow('more than was held back');
    // Neither side may type in a trade document; evidence for a claim waits for one to be open.
    await expect(
      submitDocument(dealId, w.asMember(w.retailer), {
        type: 'commercial_invoice',
        content: { kind: 'text', text: 'invoice' },
      }),
    ).rejects.toThrow('may not assert');
    const readsBefore = reads;
    await expect(
      submitDocument(dealId, w.asMember(w.retailer), {
        type: 'claim_evidence',
        content: { kind: 'text', text: 'photo' },
      }),
    ).rejects.toThrow('No claim on this deal is open');
    // Refused before the reader is paid for.
    expect(reads).toBe(readsBefore);

    await submitFact(dealId, w.asMember(w.brand), {
      kind: 'dispute',
      type: 'claim',
      data: { category: 'short_paid', reason: 'All 100 mugs arrived intact' },
    });
    const first = await waitForCase(w.tenantId, { dealId });
    expect(first.kind).toBe('exception');
    // The buyer's own claim would be lost as evidence in the seller's case, so it waits.
    await expect(
      submitFact(dealId, w.asMember(w.retailer), {
        kind: 'dispute',
        type: 'claim',
        data: { category: 'quality', reason: 'Some arrived chipped' },
      }),
    ).rejects.toThrow('A claim by the seller is open');
    // The buyer answers with evidence of its own, which the reviewers then see.
    await submitDocument(dealId, w.asMember(w.retailer), {
      type: 'claim_evidence',
      content: { kind: 'text', text: 'photo of the mugs' },
    });
    await expect
      .poll(async () => (await waitForCase(w.tenantId, { dealId })).id, { timeout: 15_000 })
      .not.toBe(first.id);
    const c = await waitForCase(w.tenantId, { dealId });
    expect(c.context).toMatchObject({ claimant: 'seller' });

    // A refund is the buyer's remedy, not a seller's.
    await expect(
      decideCase(c.id, w.person, {
        bindingHash: c.bindingHash,
        rationale: 'refund',
        action: { type: 'refund' },
      }),
    ).rejects.toThrow('refund is not allowed');
    await personDecides(w, c.id, {
      bindingHash: c.bindingHash,
      rationale: 'The buyer accepted every mug',
      action: { type: 'release_full' },
    });
    await expect
      .poll(() => w.available(w.brand, 'EUR'), { timeout: 15_000 })
      .toBe(brandBefore + eur('300'));
    expect(await w.available(w.retailer, 'EUR')).toBe(retailerBefore - eur('300'));
    const detail = (await dealDetail(dealId, w.asMember(w.brand))) as {
      deal: { releaseAmount: bigint; status: string };
      claims: { by: string; status: string; outcome: { amount?: bigint } | null }[];
    };
    expect(detail.deal).toMatchObject({ releaseAmount: eur('1500'), status: 'settled' });
    expect(detail.claims[0]).toMatchObject({
      by: 'seller',
      status: 'paid',
      outcome: { amount: eur('300') },
    });
    // Paid in full now, so a seller has nothing left to claim.
    await expect(
      submitFact(dealId, w.asMember(w.brand), {
        kind: 'dispute',
        type: 'claim',
        data: { category: 'short_paid', reason: 'again' },
      }),
    ).rejects.toThrow('paid in full');
  });
});

describe("what a member's treasurer sees", () => {
  it('names why withdrawals are held, and shows its margin calls', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    const dueAt = new Date(Date.now() + 3_600_000);
    await deps()
      .db.insert(marginCalls)
      .values({
        tenantId: w.tenantId,
        memberId: w.retailer,
        currency: 'EUR',
        amount: eur('25'),
        dueAt,
      });
    const account = await memberAccount(w.tenantId, w.retailer);
    expect(account.holds.withdrawals).toBe('margin_call');
    expect(account.marginCalls).toEqual([
      expect.objectContaining({ currency: 'EUR', amount: eur('25'), dueAt, extensions: 0 }),
    ]);
    expect((await memberAccount(w.tenantId, w.supplier)).holds.withdrawals).toBeNull();
  });

  it('says what the next cycle takes from it against what is free, and who struck each deal', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('100'));
    const dealId = await acceptedDeal(w, 'retailer', 'brand', '30');
    const [group] = (await memberSettlement(w.tenantId, w.retailer)).upcoming;
    expect(group?.funding).toEqual([expect.objectContaining({ currency: 'EUR', short: 0n })]);
    const deal = (await listDeals(w.tenantId, { memberId: w.retailer })).rows.find(
      (d) => d.id === dealId,
    );
    expect(deal).toMatchObject({
      buyerAgentName: 'Retailer agent',
      sellerAgentName: 'Brand seller',
    });
    expect((await listAgents(w.tenantId, new Date(), w.retailer))[0]?.keyLastUsedAt).toBeNull();
    // A member's export holds only the deals it is a party to.
    expect((await dealsCsv(w.tenantId, w.retailer)).body).toContain(dealId);
    expect((await dealsCsv(w.tenantId, w.supplier)).body).not.toContain(dealId);
  });

  it('dates a paid withdrawal by when the rail confirmed it', async () => {
    const w = await makeWorld(rail, { net: netProgram() });
    await w.fund(w.retailer, 'EUR', eur('20'));
    const out = (await withdraw(w, w.asMember(w.retailer), eur('5'))) as { id: string };
    await paidOut(w, out.id);
    const [row] = (await memberWithdrawals(w.tenantId, w.retailer)).rows;
    expect(row?.paidAt).toBeInstanceOf(Date);
  });
});
