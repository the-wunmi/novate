import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  type ControlActor,
  Currency,
  DomainError,
  MinorAmount,
  type Principal,
  parseInput,
} from '@novate/core';
import { members, type Tx } from '@novate/db';
import { isIdentityRefKey, RefKeys } from '@novate/rails';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, personOf, Reason, ReasonInput, recordControl } from './control.ts';
import { railRefusal } from './deal-policy.ts';
import { deps, networkStep, tx } from './deps.ts';
import {
  APPROVAL_TTL_MS,
  type PendingApproval,
  registerApprovalExecutor,
  requestApproval,
} from './four-eyes.ts';
import { MemberFacts } from './onboarding.ts';
import { type MemberRow, memberInTenant } from './repo.ts';
import { stableUuid } from './settlement-group.ts';

export const CreateMember = z.object({
  name: z.string().min(1),
  homeCurrency: Currency,
  attributes: z.record(z.string(), z.unknown()).optional(),
  ...MemberFacts.partial().shape,
});

/** Add a member, recording who added it. */
export async function createMember(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof CreateMember>,
) {
  const values = parseInput(CreateMember, input);
  return tx('create_member', async (db) => {
    const [row] = await db
      .insert(members)
      .values({ ...values, tenantId })
      .returning();
    const member = row as MemberRow;
    await recordControl(db, tenantId, actorOf(principal), {
      type: 'member_added',
      payload: {
        memberId: member.id,
        name: member.name,
        homeCurrency: member.homeCurrency,
        attributes: member.attributes,
        legalName: member.legalName,
        country: member.country,
        contactEmail: member.contactEmail,
      },
    });
    return member;
  });
}

export const SetMemberRailRefs = z.object({
  refs: z.record(z.string(), z.string().min(1)),
  reason: Reason,
});

/** A change of where a member is paid, as a second person is asked to approve it. */
const RailRefsAsked = z.object({
  memberId: z.string().uuid(),
  refs: z.record(z.string(), z.string().min(1)),
  /** What each changed identifier held when the change was asked for. */
  before: z.record(z.string(), z.string().nullable()),
});

/**
 * Change a member's identifiers on a rail, such as its Global Account and beneficiary. These decide
 * whose account is debited or credited, so a signed-in person asks and a second one approves
 * (`rail_refs` in four eyes), always, with a reason; the old and new values are kept.
 */
export async function setMemberRailRefs(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof SetMemberRailRefs>,
): Promise<PendingApproval | { status: 'unchanged' }> {
  const { refs, reason } = parseInput(SetMemberRailRefs, input);
  personOf(principal, 'change where a member is paid');
  return tx('request_member_rail_refs', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    await assertRefsFree(db, member.id, refs);
    const changed = changedRefs(member, refs);
    if (!changed.length) return { status: 'unchanged' as const };
    return requestApproval(db, tenantId, principal, {
      kind: 'rail_refs',
      payload: {
        memberId: member.id,
        refs: Object.fromEntries(changed.map((k) => [k, refs[k]])),
        before: Object.fromEntries(changed.map((k) => [k, member.railRefs[k] ?? null])),
      },
      amount: null,
      currency: null,
      reason,
    });
  });
}

/**
 * A second person applies a change of payee. Refused if any identifier it changes moved since it
 * was asked for, because then the approver would not be approving what they saw.
 */
registerApprovalExecutor('rail_refs', {
  approvers: ['house'],
  ttlMs: APPROVAL_TTL_MS,
  async run(db, request, approvedBy) {
    const asked = parseInput(RailRefsAsked, request.payload);
    const member = await memberInTenant(db, request.tenantId, asked.memberId);
    const moved = Object.keys(asked.before).filter(
      (k) => (member.railRefs[k] ?? null) !== asked.before[k],
    );
    if (moved.length) {
      throw new DomainError(
        'conflict',
        `${moved.join(', ')} changed since this request: make a new request`,
      );
    }
    await writeRailRefs(db, request.tenantId, request.actor, member, asked.refs, request.reason, {
      approvalId: request.id,
      approvedBy,
    });
  },
});

const changedRefs = (member: MemberRow, values: Record<string, string>) =>
  Object.keys(values).filter((k) => member.railRefs[k] !== values[k]);

/** An identifier that says whose money it is may belong to one member only. */
async function assertRefsFree(db: Tx, memberId: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!isIdentityRefKey(key)) continue;
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${key}:${value}`}))`);
    const [holder] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(sql`${members.railRefs}->>${key} = ${value}`, ne(members.id, memberId)));
    if (holder) throw new DomainError('conflict', `${key} is already assigned`);
  }
}

async function writeRailRefs(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  member: MemberRow,
  values: Record<string, string>,
  reason: string,
  approval?: { approvalId: string; approvedBy: ControlActor },
): Promise<void> {
  await assertRefsFree(db, member.id, values);
  const changed = changedRefs(member, values);
  if (!changed.length) return;
  await db
    .update(members)
    .set({ railRefs: { ...member.railRefs, ...values }, railRefsChangedAt: sql`now()` })
    .where(eq(members.id, member.id));
  await recordControl(db, tenantId, actor, {
    type: 'rail_refs_changed',
    reason,
    payload: {
      memberId: member.id,
      before: Object.fromEntries(changed.map((k) => [k, member.railRefs[k] ?? null])),
      after: Object.fromEntries(changed.map((k) => [k, values[k]])),
      ...approval,
    },
  });
}

/** Let a suspended member settle again. Its deferred obligations join the next cycle. */
export async function reinstateMember(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof ReasonInput>,
): Promise<void> {
  const { reason } = parseInput(ReasonInput, input);
  await tx('reinstate_member', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    await db.update(members).set({ status: 'active' }).where(eq(members.id, member.id));
    await recordControl(db, tenantId, actorOf(principal), {
      type: 'member_reinstated',
      reason,
      payload: { memberId: member.id, from: member.status },
    });
  });
}

export const ProvisionMember = z.object({
  rail: z.string().min(1),
  countryCode: z.string().length(2),
  currency: Currency,
  /** Where the member is paid, in pooled custody. */
  beneficiary: z.record(z.string(), z.unknown()).optional(),
  /** The rail's own account-opening details, in connected custody. */
  connectedAccount: z.record(z.string(), z.unknown()).optional(),
  transferMethods: z.array(z.enum(['LOCAL', 'SWIFT'])).min(1),
  /** Same key, same attempt. A failed attempt is retried under a new key. */
  idempotencyKey: z.string().min(1),
});

/**
 * Open a member's accounts on a rail and record them, once. The caller chooses the payee details,
 * so a member that already has accounts on the rail changes them only through `setMemberRailRefs`.
 */
export async function provisionMember(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof ProvisionMember>,
): Promise<void> {
  const { rail: railName, idempotencyKey, ...details } = parseInput(ProvisionMember, input);
  const refusal = railRefusal(tenantId, railName);
  if (refusal) throw new DomainError('invalid', refusal);
  const rail = deps().rails.get(railName);
  if (!rail.provision)
    throw new DomainError('invalid', `Rail ${railName} cannot provision members`);
  const member = await memberInTenant(deps().db, tenantId, memberId);
  const id = stableUuid(`provision:${tenantId}:${memberId}:${idempotencyKey}`);
  if (!(await DBOS.getWorkflowStatus(id))) assertNotProvisioned(member, railName);
  await DBOS.startWorkflow(provisionWorkflow, { workflowID: id })(
    tenantId,
    actorOf(principal),
    member,
    railName,
    details,
  );
  await DBOS.retrieveWorkflow(id).getResult();
}

function assertNotProvisioned(member: MemberRow, railName: string) {
  const held = [RefKeys.depositAccount, RefKeys.beneficiary, RefKeys.account]
    .map((key) => key(railName))
    .filter((key) => member.railRefs[key]);
  if (held.length) {
    throw new DomainError(
      'conflict',
      `${member.name} already has ${held.join(', ')}: change them as a payee change`,
    );
  }
}

type ProvisionDetails = Omit<z.output<typeof ProvisionMember>, 'rail' | 'idempotencyKey'>;

/** Accounts created on a rail are recorded even if the process dies between the two. */
async function runProvision(
  tenantId: string,
  actor: ControlActor,
  member: MemberRow,
  railName: string,
  details: ProvisionDetails,
): Promise<void> {
  const rail = deps().rails.get(railName);
  const refs = await networkStep('rail_provision', async () =>
    (rail.provision as NonNullable<typeof rail.provision>)({
      ...details,
      requestId: member.id,
      nickName: member.name,
    }),
  );
  await tx('provisioned_rail_refs', async (db) => {
    await db.execute(sql`SELECT 1 FROM ${members} WHERE ${members.id} = ${member.id} FOR UPDATE`);
    const current = await memberInTenant(db, tenantId, member.id);
    assertNotProvisioned(current, railName);
    await writeRailRefs(db, tenantId, actor, current, refs, `Provisioned on ${railName}`);
  });
}

const provisionWorkflow = DBOS.registerWorkflow(runProvision, { name: 'provisionMember' });

export function listMembers(tenantId: string) {
  return deps().db.select().from(members).where(eq(members.tenantId, tenantId));
}

/** Stop a member settling. Its deals wait, as they do after a default, until it is reinstated. */
export async function suspendMember(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof ReasonInput>,
): Promise<void> {
  const { reason } = parseInput(ReasonInput, input);
  await tx('suspend_member', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    await db.update(members).set({ status: 'suspended' }).where(eq(members.id, member.id));
    await recordControl(db, tenantId, actorOf(principal), {
      type: 'member_suspended',
      reason,
      payload: { memberId: member.id, from: member.status },
    });
  });
}

export const SetMemberControls = z.object({
  /** Per currency, minor units: a withdrawal above this waits for a second user of the member. */
  withdrawalFourEyesAbove: z.record(
    Currency,
    MinorAmount.refine((v) => v >= 0n),
  ),
  reason: Reason,
});

const MemberControlsAsked = z.object({
  memberId: z.string().uuid(),
  before: z.record(z.string(), z.string()),
  after: z.record(z.string(), z.string()),
});

/** A threshold raised or removed lets more through without a second person. */
const loosens = (before: Record<string, string>, after: Record<string, string>) =>
  Object.entries(before).some(([c, v]) => after[c] === undefined || BigInt(after[c]) > BigInt(v));

/**
 * A member's own users set its withdrawal four eyes. Tightening applies at once; raising or removing
 * a threshold waits for a second user of the member, so one person cannot switch the control off
 * and then send the money alone.
 */
export async function setMemberControls(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof SetMemberControls>,
): Promise<PendingApproval | { status: 'changed' | 'unchanged' }> {
  const { withdrawalFourEyesAbove, reason } = parseInput(SetMemberControls, input);
  if (principal.kind !== 'member' || principal.memberId !== memberId) {
    throw new DomainError('forbidden', "Only the member's own users set its controls");
  }
  personOf(principal, "change the member's controls");
  const after = Object.fromEntries(
    Object.entries(withdrawalFourEyesAbove).map(([c, v]) => [c, v.toString()]),
  );
  return tx('set_member_controls', async (db) => {
    const member = await lockedMember(db, tenantId, memberId);
    const before = member.withdrawalFourEyesAbove;
    if (sameControls(before, after)) return { status: 'unchanged' as const };
    if (loosens(before, after)) {
      return requestApproval(db, tenantId, principal, {
        kind: 'member_controls',
        memberId,
        payload: { memberId, before, after },
        amount: null,
        currency: null,
        reason,
      });
    }
    await writeControls(db, tenantId, actorOf(principal), member, after, reason);
    return { status: 'changed' as const };
  });
}

const sameControls = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([c, v]) => b[c] === v);

async function lockedMember(db: Tx, tenantId: string, memberId: string) {
  await memberInTenant(db, tenantId, memberId);
  const [row] = await db.select().from(members).where(eq(members.id, memberId)).for('update');
  return row as MemberRow;
}

async function writeControls(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  member: MemberRow,
  after: Record<string, string>,
  reason: string,
  approval?: { approvalId: string; approvedBy: ControlActor },
) {
  await db.update(members).set({ withdrawalFourEyesAbove: after }).where(eq(members.id, member.id));
  await recordControl(db, tenantId, actor, {
    type: 'member_controls_changed',
    reason,
    payload: {
      memberId: member.id,
      withdrawalFourEyesAbove: { from: member.withdrawalFourEyesAbove, to: after },
      ...approval,
    },
  });
}

/** Refused if the controls moved since the request, so the approver approves what they saw. */
registerApprovalExecutor('member_controls', {
  approvers: ['member'],
  ttlMs: APPROVAL_TTL_MS,
  async run(db, request, approvedBy) {
    const asked = parseInput(MemberControlsAsked, request.payload);
    const member = await lockedMember(db, request.tenantId, asked.memberId);
    if (!sameControls(member.withdrawalFourEyesAbove, asked.before)) {
      throw new DomainError('conflict', 'The controls changed since this request: ask again');
    }
    await writeControls(db, request.tenantId, request.actor, member, asked.after, request.reason, {
      approvalId: request.id,
      approvedBy,
    });
  },
});
