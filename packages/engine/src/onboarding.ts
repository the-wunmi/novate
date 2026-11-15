import { DomainError, type Principal, parseInput } from '@novate/core';
import { controlEvents, members } from '@novate/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, Reason, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { isProvisioned } from './member-account.ts';
import { type MemberRow, memberInTenant } from './repo.ts';

/** What the platform learned about a business when it signed it up. */
export const MemberFacts = z.object({
  legalName: z.string().trim().min(1).max(200),
  /** ISO 3166-1 alpha-2, such as NL. */
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'A two-letter country code')
    .transform((c) => c.toUpperCase()),
  contactEmail: z
    .string()
    .trim()
    .max(320)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Not an email address'),
});

const FACTS = ['name', 'legalName', 'country', 'contactEmail'] as const;

export const UpdateMember = MemberFacts.partial()
  .extend({
    name: z.string().trim().min(1).max(200).optional(),
    reason: Reason.optional(),
  })
  .refine((u) => FACTS.some((k) => u[k] !== undefined), {
    message: 'Give at least one of name, legalName, country or contactEmail',
  });

/** Correct what the platform knows about a member. What changed, from and to, is recorded. */
export async function updateMember(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input: z.input<typeof UpdateMember>,
): Promise<MemberRow> {
  const { reason, ...facts } = parseInput(UpdateMember, input);
  parseInput(z.string().uuid(), memberId);
  return tx('update_member', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    const changed = FACTS.filter((k) => facts[k] !== undefined && facts[k] !== member[k]);
    if (!changed.length) return member;
    const set = Object.fromEntries(changed.map((k) => [k, facts[k]]));
    const [row] = await db.update(members).set(set).where(eq(members.id, member.id)).returning();
    await recordControl(db, tenantId, actorOf(principal), {
      type: 'member_updated',
      reason,
      payload: {
        memberId: member.id,
        before: Object.fromEntries(changed.map((k) => [k, member[k] ?? null])),
        after: set,
      },
    });
    return row as MemberRow;
  });
}

export const RequestProvision = z.object({
  /** What the house should know: which rail or currency, anything unusual about the business. */
  note: z.string().trim().min(1).max(1000).optional(),
});

/**
 * The platform asks the house to open a member's accounts. Only the house can, because accounts
 * decide whose money moves; this records the ask so it shows on the house's list until it is done.
 */
export async function requestProvision(
  tenantId: string,
  principal: Principal,
  memberId: string,
  input?: z.input<typeof RequestProvision>,
) {
  const { note } = parseInput(RequestProvision, input ?? {});
  parseInput(z.string().uuid(), memberId);
  return tx('provision_request', async (db) => {
    const member = await memberInTenant(db, tenantId, memberId);
    if (isProvisioned(tenantId, member)) {
      throw new DomainError('conflict', 'This member already has its accounts');
    }
    const id = await recordControl(db, tenantId, actorOf(principal), {
      type: 'provision_requested',
      reason: note,
      payload: { memberId: member.id, name: member.name },
    });
    return { id, memberId: member.id };
  });
}

/**
 * Members the platform has asked the house to open accounts for and that still have none, oldest
 * ask first, each with its latest ask and what the platform recorded about the business.
 */
export async function provisionRequests(tenantId: string) {
  const { db } = deps();
  const asks = await db
    .select()
    .from(controlEvents)
    .where(and(eq(controlEvents.tenantId, tenantId), eq(controlEvents.type, 'provision_requested')))
    .orderBy(desc(controlEvents.createdAt));
  const latest = new Map<string, (typeof asks)[number]>();
  const first = new Map<string, Date>();
  for (const a of asks) {
    const memberId = String(a.payload.memberId);
    if (!latest.has(memberId)) latest.set(memberId, a);
    first.set(memberId, a.createdAt);
  }
  const ids = [...latest.keys()];
  const rows = ids.length
    ? await db
        .select()
        .from(members)
        .where(and(eq(members.tenantId, tenantId), inArray(members.id, ids)))
    : [];
  return rows
    .filter((m) => !isProvisioned(tenantId, m))
    .map((m) => {
      const ask = latest.get(m.id) as (typeof asks)[number];
      return {
        id: ask.id,
        memberId: m.id,
        name: m.name,
        legalName: m.legalName,
        country: m.country,
        contactEmail: m.contactEmail,
        homeCurrency: m.homeCurrency,
        status: m.status,
        memberCreatedAt: m.createdAt,
        note: ask.reason,
        requestedBy: ask.actor,
        requestedAt: ask.createdAt,
        firstRequestedAt: first.get(m.id) ?? ask.createdAt,
      };
    })
    .sort((a, b) => a.firstRequestedAt.getTime() - b.firstRequestedAt.getTime());
}
