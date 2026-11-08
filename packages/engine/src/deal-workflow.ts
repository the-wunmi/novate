import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  applyBps,
  DealLine,
  DealTerms,
  DomainError,
  dealAmount,
  dealQuantity,
  sha256,
} from '@novate/core';
import { approvals, dealFacts, deals, obligations, type Tx } from '@novate/db';
import { Accounts } from '@novate/ledger';
import {
  type ConditionContext,
  type ConditionResult,
  durationMs,
  evaluateCondition,
  ProgramSpec,
  type ResolvedPolicy,
  releaseAmount,
  resolvePolicy,
} from '@novate/policy';
import type { SignalReading } from '@novate/signals';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { checkAuthority } from './authority.ts';
import { deps, tx } from './deps.ts';
import {
  type DealRow,
  getDeal,
  getMember,
  getProgram,
  listFacts,
  record,
  setStatus,
} from './repo.ts';

export const Topics = {
  approval: 'approval',
  fact: 'fact',
  funds: 'funds',
  settled: 'settled',
} as const;

export const FreezeDecision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('reprice'), lines: z.array(DealLine).min(1) }),
]);
export const BlockedDecision = z.discriminatedUnion('action', [
  /** Accept the listed findings (all open ones when omitted). */
  z.object({ action: z.literal('waive'), codes: z.array(z.string()).optional() }),
  /** Keep waiting for corrected evidence. */
  z.object({ action: z.literal('hold') }),
  z.object({ action: z.literal('release') }),
  z.object({ action: z.literal('refund') }),
]);
export const Decision = z.union([FreezeDecision, BlockedDecision]);
export type Decision = z.infer<typeof Decision>;

export interface ApprovalMessage {
  approvalId: string;
  decision: Decision;
  decidedBy: string;
}

export interface PolicySnapshot {
  programId: string;
  programVersion: number;
  resolved: ResolvedPolicy;
  signals: Record<string, SignalReading>;
  authorisedAt: string;
}

const snapshotOf = (deal: DealRow) => deal.policySnapshot as unknown as PolicySnapshot;

/**
 * The life of one deal, from submission to settlement. Durable: every step is checkpointed in
 * Postgres, so a crash at any point resumes exactly where it stopped. What happens at each stage
 * is decided by the deal's resolved policy, never hard-coded here.
 */
async function dealLifecycle(dealId: string): Promise<string> {
  const start = await DBOS.now();

  // 1 ── Authority
  const authority = await tx('authority', async (db) => {
    const deal = await getDeal(db, dealId);
    return checkAuthority(db, deal, new Date(start));
  });
  if (authority.length) {
    await tx('reject', (db) =>
      setStatus(
        db,
        dealId,
        'rejected',
        { type: 'authority_failed', payload: { authority } },
        authority.join('; '),
      ),
    );
    return 'rejected';
  }

  // 2 ── Signals and policy (signals are external calls: checkpointed as a step)
  const subject = await tx('subject', async (db) => signalSubject(db, await getDeal(db, dealId)));
  const signals = await DBOS.runStep(() => deps().signals.resolve(subject.names, subject.subject), {
    name: 'signals',
  });
  const resolved = await tx('resolve', (db) =>
    resolveAndSnapshot(db, dealId, signals, new Date(start)),
  );
  if (resolved.authorityFailures.length) {
    await tx('reject', (db) =>
      setStatus(
        db,
        dealId,
        'rejected',
        { type: 'authority_failed', payload: { rules: resolved.authorityFailures } },
        resolved.authorityFailures.join('; '),
      ),
    );
    return 'rejected';
  }

  // 3 ── Mistake checks
  const rejects = resolved.checks.filter((c) => c.action === 'reject');
  if (rejects.length) {
    await tx('reject', (db) =>
      setStatus(
        db,
        dealId,
        'rejected',
        { type: 'check_rejected', payload: { checks: rejects } },
        rejects.map((c) => c.reason).join('; '),
      ),
    );
    return 'rejected';
  }
  const freezes = resolved.checks.filter((c) => c.action === 'freeze');
  if (freezes.length) {
    const decision = await awaitApproval(
      dealId,
      'frozen',
      freezes.map((c) => c.reason).join('; '),
      { checks: freezes },
      resolved.policy.approvals.timeout,
    );
    const action =
      decision?.action ??
      (resolved.policy.approvals.onTimeout === 'proceed' ? 'confirm' : 'cancel');
    if (action === 'cancel') {
      await tx('cancel', (db) =>
        setStatus(
          db,
          dealId,
          'cancelled',
          { type: 'cancelled', payload: { by: decision ? 'approver' : 'timeout' } },
          'cancelled at review',
        ),
      );
      return 'cancelled';
    }
    if (decision?.action === 'reprice')
      await tx('reprice', (db) => reprice(db, dealId, decision.lines));
  }

  // 4 ── Funding and margin
  await tx('obligation', (db) => openObligation(db, dealId));
  const funded = await lockWithWait(dealId, 'escrow', resolved.fundingBps, resolved.policy.funding);
  const margined =
    funded && (await lockWithWait(dealId, 'margin', resolved.marginBps, resolved.policy.margin));
  if (!funded || !margined) {
    await tx('unwind', (db) =>
      unwind(
        db,
        dealId,
        'cancelled',
        funded ? 'seller margin not posted in time' : 'buyer funding not received in time',
      ),
    );
    return 'cancelled';
  }

  // 5 ── Release conditions
  const release = resolved.policy.release;
  await tx('awaiting', (db) =>
    setStatus(db, dealId, 'awaiting_conditions', { type: 'awaiting_conditions' }, null),
  );
  const deadline = start + durationMs(release.timeout);
  let forceRelease = false;
  let lastEscalated = '';
  while (true) {
    const now = await DBOS.now();
    const { result, factCount } = await tx('evaluate', (db) => evaluateDeal(db, dealId, now));
    if (result.state === 'satisfied') break;
    // Only ask a person again when the evidence or the findings have changed.
    const fingerprint = `${factCount}:${result.findings.map((f) => f.code).join(',')}:${now >= deadline}`;

    if (now >= deadline) {
      if (release.onTimeout === 'release') {
        forceRelease = true;
        break;
      }
      if (release.onTimeout === 'refund') {
        await tx('unwind', (db) =>
          unwind(db, dealId, 'refunded', 'release conditions not met in time'),
        );
        return 'refunded';
      }
    }

    const escalate =
      (result.state === 'blocked' && release.onBlocked === 'escalate') ||
      (now >= deadline && release.onTimeout === 'escalate');
    if (escalate && fingerprint !== lastEscalated) {
      lastEscalated = fingerprint;
      const reason =
        now >= deadline
          ? 'Release conditions timed out'
          : result.findings.map((f) => f.message).join('; ');
      const decision = await awaitApproval(
        dealId,
        'held',
        reason,
        { findings: result.findings, trace: result.trace },
        resolved.policy.approvals.timeout,
      );
      if (!decision || decision.action === 'hold') {
        await tx('awaiting', (db) =>
          setStatus(db, dealId, 'awaiting_conditions', { type: 'held_for_evidence' }, reason),
        );
        await DBOS.recv(Topics.fact, {
          deadlineEpochMS: Math.min(
            deadline,
            (await DBOS.now()) + durationMs(release.recheckEvery),
          ),
        });
        continue;
      }
      if (decision.action === 'refund') {
        await tx('unwind', (db) => unwind(db, dealId, 'refunded', 'refunded by approver'));
        return 'refunded';
      }
      if (decision.action === 'release') {
        forceRelease = true;
        break;
      }
      if (decision.action === 'waive') {
        const codes =
          decision.codes ?? result.findings.filter((f) => f.waivable).map((f) => f.code);
        await tx('waive', (db) => waive(db, dealId, codes));
        await tx('awaiting', (db) =>
          setStatus(
            db,
            dealId,
            'awaiting_conditions',
            { type: 'waived', payload: { codes } },
            null,
          ),
        );
        continue;
      }
    }

    const wakeAt = Math.min(
      Math.max(deadline, now + 1_000),
      now + durationMs(release.recheckEvery),
    );
    await DBOS.recv(Topics.fact, { deadlineEpochMS: wakeAt });
  }

  // 6 ── Release into the next clearing cycle
  const released = await tx('release', (db) => releaseFunds(db, dealId, forceRelease));
  if (released === 0n) {
    await tx('unwind', (db) => unwind(db, dealId, 'refunded', 'nothing to release'));
    return 'refunded';
  }

  // 7 ── Wait for the cycle that settles this obligation, then return the seller's margin
  while (true) {
    const msg = await DBOS.recv<{ cycleId: string }>(Topics.settled, { timeoutSeconds: 86_400 });
    if (msg) {
      await tx('settled', (db) => completeDeal(db, dealId, msg.cycleId));
      return 'settled';
    }
  }
}

export const dealWorkflow = DBOS.registerWorkflow(dealLifecycle, { name: 'dealLifecycle' });

// ── Steps ──────────────────────────────────────────────────────────────────

async function signalSubject(db: Tx, deal: DealRow) {
  const program = ProgramSpec.parse((await getProgram(db, deal.programId)).spec);
  const terms = DealTerms.parse(deal.terms);
  return {
    names: program.signals,
    subject: {
      tenantId: deal.tenantId,
      dealId: deal.id,
      buyerMemberId: deal.buyerMemberId,
      sellerMemberId: deal.sellerMemberId,
      buyerAgentId: deal.buyerAgentId ?? undefined,
      currency: deal.currency,
      amount: deal.amount,
      category: terms.category,
      attributes: terms.attributes,
    },
  };
}

async function resolveAndSnapshot(
  db: Tx,
  dealId: string,
  signals: Record<string, SignalReading>,
  now: Date,
): Promise<ResolvedPolicy> {
  const deal = await getDeal(db, dealId);
  const programRow = await getProgram(db, deal.programId);
  const program = ProgramSpec.parse(programRow.spec);
  const terms = DealTerms.parse(deal.terms);
  const buyer = await getMember(db, deal.buyerMemberId);
  const seller = await getMember(db, deal.sellerMemberId);
  const party = (m: typeof buyer) => ({
    id: m.id,
    name: m.name,
    homeCurrency: m.homeCurrency,
    attributes: m.attributes,
  });

  const resolved = resolvePolicy(program, {
    deal: {
      amount: deal.amount,
      currency: deal.currency,
      quantity: deal.quantity,
      category: terms.category,
      unitPrice: deal.amount / BigInt(deal.quantity),
      shipmentDate: terms.shipmentDate,
      attributes: terms.attributes,
    },
    buyer: party(buyer),
    seller: party(seller),
    signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, v.values])),
  });

  const snapshot: PolicySnapshot = {
    programId: programRow.id,
    programVersion: programRow.version,
    resolved,
    signals,
    authorisedAt: now.toISOString(),
  };
  await db
    .update(deals)
    .set({ policySnapshot: snapshot as unknown as Record<string, unknown> })
    .where(eq(deals.id, dealId));
  await setStatus(db, dealId, 'authorised', {
    type: 'policy_resolved',
    payload: {
      program: `${programRow.key}@v${programRow.version}`,
      fundingBps: resolved.fundingBps,
      marginBps: resolved.marginBps,
      overrides: resolved.overridesApplied,
      checks: resolved.checks,
    },
  });
  return resolved;
}

async function reprice(db: Tx, dealId: string, lines: z.infer<typeof DealLine>[]) {
  const deal = await getDeal(db, dealId);
  const terms = { ...(deal.terms as Record<string, unknown>), lines };
  const amount = dealAmount({ lines });
  await db
    .update(deals)
    .set({
      terms: JSON.parse(
        JSON.stringify(terms, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ),
      amount,
      quantity: dealQuantity({ lines }),
    })
    .where(eq(deals.id, dealId));
  await record(db, dealId, 'repriced', { from: deal.amount, to: amount });
}

async function openObligation(db: Tx, dealId: string) {
  const deal = await getDeal(db, dealId);
  await db
    .insert(obligations)
    .values({
      tenantId: deal.tenantId,
      dealId,
      payerMemberId: deal.buyerMemberId,
      payeeMemberId: deal.sellerMemberId,
      currency: deal.currency,
      amount: deal.amount,
    })
    .onConflictDoNothing();
}

type Lockable = { mode: string; timeout?: string };

/** Lock `bps` of the deal amount from the buyer (escrow) or seller (margin), waiting for deposits. */
async function lockWithWait(
  dealId: string,
  kind: 'escrow' | 'margin',
  bps: number,
  cfg: Lockable,
): Promise<boolean> {
  if (bps === 0) return true;
  const deadline = (await DBOS.now()) + durationMs(cfg.timeout ?? '72h');
  let waiting = false;
  while (true) {
    const ok = await tx(`lock_${kind}`, (db) => lockFunds(db, dealId, kind, bps));
    if (ok) return true;
    if (!waiting) {
      await tx('awaiting_funding', (db) =>
        setStatus(
          db,
          dealId,
          'awaiting_funding',
          { type: 'awaiting_funding', payload: { kind } },
          `waiting for ${kind === 'escrow' ? 'buyer funds' : 'seller margin'}`,
        ),
      );
      waiting = true;
    }
    const now = await DBOS.now();
    if (now >= deadline) return false;
    await DBOS.recv(Topics.funds, { deadlineEpochMS: Math.min(deadline, now + 3_600_000) });
  }
}

async function lockFunds(
  db: Tx,
  dealId: string,
  kind: 'escrow' | 'margin',
  bps: number,
): Promise<boolean> {
  const deal = await getDeal(db, dealId);
  const amount = applyBps(deal.amount, bps);
  if (amount === 0n) return true;
  const memberId = kind === 'escrow' ? deal.buyerMemberId : deal.sellerMemberId;
  try {
    // Savepoint: an overdraft rejection must not abort the surrounding transaction.
    await db.transaction((sp) =>
      deps().ledger.post(sp, deal.tenantId, [
        {
          key: `deal:${dealId}:${kind}:lock`,
          debit: Accounts.memberAvailable(memberId, deal.currency),
          credit:
            kind === 'escrow'
              ? Accounts.dealEscrow(dealId, deal.currency)
              : Accounts.dealMargin(dealId, deal.currency),
          amount,
          kind: `${kind}_lock`,
          ref: dealId,
        },
      ]),
    );
  } catch (err) {
    if (err instanceof DomainError && err.code === 'insufficient_funds') return false;
    throw err;
  }
  await record(db, dealId, `${kind}_locked`, { amount, bps });
  return true;
}

async function conditionContext(db: Tx, deal: DealRow, now: number): Promise<ConditionContext> {
  const terms = DealTerms.parse(deal.terms);
  const snap = snapshotOf(deal);
  return {
    deal: {
      amount: deal.amount,
      currency: deal.currency,
      quantity: deal.quantity,
      shipmentDate: terms.shipmentDate,
      description: terms.lines.map((l) => l.description).join('; '),
      authorisedAt: snap.authorisedAt,
    },
    facts: await listFacts(db, deal.id),
    now: new Date(now),
    extra: {
      signals: Object.fromEntries(Object.entries(snap.signals).map(([k, v]) => [k, v.values])),
      attributes: terms.attributes,
    },
  };
}

async function evaluateDeal(
  db: Tx,
  dealId: string,
  now: number,
): Promise<{ result: ConditionResult; factCount: number }> {
  const deal = await getDeal(db, dealId);
  const ctx = await conditionContext(db, deal, now);
  const result = evaluateCondition(snapshotOf(deal).resolved.policy.release.condition, ctx);
  await record(db, dealId, 'conditions_evaluated', { state: result.state, trace: result.trace });
  return { result, factCount: ctx.facts.length };
}

async function waive(db: Tx, dealId: string, codes: string[]) {
  if (!codes.length) return;
  await db.insert(dealFacts).values(
    codes.map((code) => ({
      dealId,
      kind: 'waiver',
      type: 'approver',
      source: 'approval',
      data: { code },
    })),
  );
}

async function releaseFunds(db: Tx, dealId: string, forced: boolean): Promise<bigint> {
  const deal = await getDeal(db, dealId);
  const { ledger } = deps();
  const policy = snapshotOf(deal).resolved.policy;
  const ctx = await conditionContext(db, deal, Date.now());
  const amount = forced ? deal.amount : releaseAmount(policy.release.amount, ctx);

  const escrow = Accounts.dealEscrow(dealId, deal.currency);
  const held = await ledger.balance(db, deal.tenantId, escrow);
  if (held > amount) {
    await ledger.post(db, deal.tenantId, [
      {
        key: `deal:${dealId}:escrow:excess`,
        debit: escrow,
        credit: Accounts.memberAvailable(deal.buyerMemberId, deal.currency),
        amount: held - amount,
        kind: 'escrow_refund',
        ref: dealId,
      },
    ]);
  }

  const terms = DealTerms.parse(deal.terms);
  const late = ctx.facts.some(
    (f) =>
      f.kind === 'document' &&
      terms.shipmentDate &&
      typeof (f.data.fields as { shipmentDate?: string } | undefined)?.shipmentDate === 'string' &&
      (f.data.fields as { shipmentDate: string }).shipmentDate > terms.shipmentDate,
  );

  await db
    .update(obligations)
    .set(amount > 0n ? { amount, status: 'eligible' } : { status: 'cancelled' })
    .where(eq(obligations.dealId, dealId));
  await db.update(deals).set({ releaseAmount: amount }).where(eq(deals.id, dealId));
  await setStatus(
    db,
    dealId,
    'eligible',
    { type: 'released', payload: { amount, of: deal.amount, forced, late } },
    null,
  );
  return amount;
}

/** Return everything held for a deal to its owners and close it. */
async function unwind(db: Tx, dealId: string, status: 'cancelled' | 'refunded', reason: string) {
  const deal = await getDeal(db, dealId);
  const { ledger } = deps();
  const transfers = [];
  const escrow = Accounts.dealEscrow(dealId, deal.currency);
  const margin = Accounts.dealMargin(dealId, deal.currency);
  const held = await ledger.balance(db, deal.tenantId, escrow);
  const posted = await ledger.balance(db, deal.tenantId, margin);
  if (held > 0n) {
    transfers.push({
      key: `deal:${dealId}:escrow:unwind`,
      debit: escrow,
      credit: Accounts.memberAvailable(deal.buyerMemberId, deal.currency),
      amount: held,
      kind: 'escrow_refund',
      ref: dealId,
    });
  }
  if (posted > 0n) {
    transfers.push({
      key: `deal:${dealId}:margin:unwind`,
      debit: margin,
      credit: Accounts.memberAvailable(deal.sellerMemberId, deal.currency),
      amount: posted,
      kind: 'margin_release',
      ref: dealId,
    });
  }
  await ledger.post(db, deal.tenantId, transfers);
  await db.update(obligations).set({ status: 'cancelled' }).where(eq(obligations.dealId, dealId));
  await setStatus(
    db,
    dealId,
    status,
    { type: status, payload: { reason, escrowReturned: held, marginReturned: posted } },
    reason,
  );
}

async function completeDeal(db: Tx, dealId: string, cycleId: string) {
  const deal = await getDeal(db, dealId);
  const { ledger } = deps();
  const margin = Accounts.dealMargin(dealId, deal.currency);
  const posted = await ledger.balance(db, deal.tenantId, margin);
  if (posted > 0n) {
    await ledger.post(db, deal.tenantId, [
      {
        key: `deal:${dealId}:margin:release`,
        debit: margin,
        credit: Accounts.memberAvailable(deal.sellerMemberId, deal.currency),
        amount: posted,
        kind: 'margin_release',
        ref: dealId,
      },
    ]);
  }
  await setStatus(
    db,
    dealId,
    'settled',
    { type: 'settled', payload: { cycleId, marginReturned: posted } },
    null,
  );
}

async function awaitApproval(
  dealId: string,
  status: 'frozen' | 'held',
  reason: string,
  context: Record<string, unknown>,
  timeout: string,
): Promise<Decision | null> {
  const approvalId = await tx('approval_open', (db) =>
    openApproval(db, dealId, status, reason, context),
  );
  const deadline = (await DBOS.now()) + durationMs(timeout);
  while (true) {
    const msg = await DBOS.recv<ApprovalMessage>(Topics.approval, { deadlineEpochMS: deadline });
    if (!msg) {
      await tx('approval_expire', async (db) => {
        await db.update(approvals).set({ status: 'expired' }).where(eq(approvals.id, approvalId));
        await record(db, dealId, 'approval_expired', { approvalId });
      });
      return null;
    }
    if (msg.approvalId === approvalId) return msg.decision;
  }
}

async function openApproval(
  db: Tx,
  dealId: string,
  status: 'frozen' | 'held',
  reason: string,
  context: Record<string, unknown>,
) {
  const deal = await getDeal(db, dealId);
  const facts = await listFacts(db, dealId);
  const shown = {
    dealId,
    amount: deal.amount.toString(),
    currency: deal.currency,
    buyer: deal.buyerMemberId,
    seller: deal.sellerMemberId,
    terms: deal.terms,
    factIds: facts.map((f) => f.id),
    reason,
    ...JSON.parse(JSON.stringify(context, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
  };
  const [row] = await db
    .insert(approvals)
    .values({ dealId, reason, shown, bindingHash: sha256(shown) })
    .returning({ id: approvals.id });
  await setStatus(
    db,
    dealId,
    status,
    { type: 'approval_requested', payload: { approvalId: row?.id, reason } },
    reason,
  );
  return row?.id as string;
}
