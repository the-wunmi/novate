import { DomainError, type Principal, parseInput, TenantSettings } from '@novate/core';
import { controlEvents, type Tx, tenants } from '@novate/db';
import { MEMBER_ACCOUNT_KINDS } from '@novate/ledger';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { issueKey } from './api-keys.ts';
import { actorOf, operatorActor, ReasonInput } from './control.ts';
import { deps, tx } from './deps.ts';
import { newestFirst } from './page.ts';
import { heldRails } from './recon-breaks.ts';
import { haltSettlement } from './repo.ts';

export const CreateTenant = z.object({ name: z.string().min(1) });

/** Create a tenant and its platform credential. The key is returned once. */
export async function createTenant(input: z.input<typeof CreateTenant>) {
  const values = parseInput(CreateTenant, input);
  const tenant = await tx('create_tenant', async (db) => {
    const [row] = await db.insert(tenants).values(values).returning();
    return row as typeof tenants.$inferSelect;
  });
  const { key } = await issueKey(tenant.id, operatorActor(), {
    name: 'platform',
    principal: 'platform',
  });
  return { tenant, apiKey: key };
}

export function balances(tenantId: string, memberId: string) {
  return deps().ledger.balances(deps().db, tenantId, { memberId, kinds: MEMBER_ACCOUNT_KINDS });
}

export async function tenantStatus(tenantId: string) {
  const [row] = await deps().db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new DomainError('not_found', 'Tenant not found');
  const [stop] = row.settlementHaltedAt
    ? await deps()
        .db.select({ actor: controlEvents.actor })
        .from(controlEvents)
        .where(
          and(eq(controlEvents.tenantId, tenantId), eq(controlEvents.type, 'settlement_stopped')),
        )
        .orderBy(...newestFirst(controlEvents.createdAt, controlEvents.id))
        .limit(1)
    : [];
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    settlementHaltedAt: row.settlementHaltedAt,
    settlementHaltReason: row.settlementHaltReason,
    /** Who made the stop in force, from the control log. */
    settlementHaltedBy: stop?.actor ?? null,
    settings: TenantSettings.parse(row.settings),
    /** Rails with open reconciliation differences. Nothing settles on them, stopped or not. */
    heldRails: await heldRails(deps().db as unknown as Tx, tenantId),
  };
}

/** The manual stop. Settlement stays stopped until someone resumes it. */
export async function stopSettlement(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof ReasonInput>,
): Promise<void> {
  const { reason } = parseInput(ReasonInput, input);
  await tx('stop_settlement', (db) => haltSettlement(db, tenantId, actorOf(principal), reason));
}

export async function checkDatabase(): Promise<void> {
  await deps().db.execute(sql`select 1`);
}
