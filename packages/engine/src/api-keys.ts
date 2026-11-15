import {
  type ControlActor,
  DomainError,
  ISSUABLE_KEY_KINDS,
  type Principal,
  parseInput,
} from '@novate/core';
import { apiKeys, apiRateWindows, type Tx } from '@novate/db';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hashToken } from './auth-crypto.ts';
import { actorOf, operatorActor, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { newKey } from './instance-setup.ts';
import { agentInTenant, getAgent, memberInTenant } from './repo.ts';

type KeyValues = {
  name: string;
  principal: Principal['kind'];
  memberId?: string;
  agentId?: string;
};

export async function issueKey(
  tenantId: string,
  actor: ControlActor,
  values: KeyValues,
): Promise<{ id: string; key: string }> {
  const key = newKey();
  const id = await tx('issue_key', (db) => insertKey(db, tenantId, actor, values, key));
  return { id, key };
}

async function insertKey(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  values: KeyValues,
  key: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  if (values.memberId) await memberInTenant(db, tenantId, values.memberId);
  if (values.agentId) {
    const agent = await agentInTenant(db, tenantId, values.agentId);
    if (agent.memberId !== values.memberId) {
      throw new DomainError('not_found', 'Agent not found');
    }
  }
  const [row] = await db
    .insert(apiKeys)
    .values({ ...values, tenantId, keyHash: hashToken(key), createdBy: actor })
    .returning({ id: apiKeys.id });
  const id = row?.id as string;
  await recordControl(db, tenantId, actor, {
    type: 'key_issued',
    payload: { keyId: id, ...values, ...extra },
  });
  return id;
}

/** `platform` and `house` keys are not issued here: they carry operator-level power. */
export const CreateApiKey = z
  .object({
    name: z.string().min(1),
    principal: z.enum(ISSUABLE_KEY_KINDS),
    memberId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
  })
  .refine((k) => !['member', 'agent'].includes(k.principal) || k.memberId, {
    message: 'A member or agent key needs a member',
  })
  .refine((k) => k.principal !== 'agent' || k.agentId, {
    message: 'An agent key needs an agent',
  })
  // A reviewer tied to a party would be judging its own deals.
  .refine((k) => ['member', 'agent'].includes(k.principal) || (!k.memberId && !k.agentId), {
    message: 'Only member and agent keys belong to a member',
  });

/** Issue a credential. The plain key is returned once and only its hash is stored. */
export function createApiKey(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof CreateApiKey>,
) {
  return issueKey(tenantId, actorOf(principal), parseInput(CreateApiKey, input));
}

/** A house key can credit funds, so this is reachable only with the operator's credential. */
export const createHouseKey = (tenantId: string, operator?: string) =>
  issueKey(tenantId, operatorActor(operator), { name: 'house', principal: 'house' });

/** A platform key is only shown when issued, so a lost one is replaced. */
export const createPlatformKey = (tenantId: string, operator?: string) =>
  issueKey(tenantId, operatorActor(operator), { name: 'platform', principal: 'platform' });

export async function revokeApiKey(
  tenantId: string,
  principal: Principal,
  keyId: string,
): Promise<void> {
  parseInput(z.string().uuid(), keyId);
  await tx('revoke_key', async (db) => {
    const [key] = await db
      .select({ principal: apiKeys.principal })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)));
    if (!key) throw new DomainError('not_found', 'Key not found');
    // Operator-level keys may be cut off by the house, never by the platform they answer to.
    if (!(ISSUABLE_KEY_KINDS as readonly string[]).includes(key.principal)) {
      if (principal.kind !== 'house') {
        throw new DomainError('forbidden', 'Only the house revokes house and platform keys');
      }
    }
    await revokeKey(db, tenantId, actorOf(principal), keyId);
  });
}

async function revokeKey(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  keyId: string,
  extra: Record<string, unknown> = {},
) {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date(), revokedBy: actor })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId), isNull(apiKeys.revokedAt)))
    .returning({ name: apiKeys.name, principal: apiKeys.principal });
  if (!row) return false;
  await recordControl(db, tenantId, actor, {
    type: 'key_revoked',
    payload: { keyId, name: row.name, principal: row.principal, ...extra },
  });
  return true;
}

/**
 * Replace a key: a new one with the same name, kind, member and agent, and the old one revoked, in
 * one transaction, both recorded. The new key is returned once.
 */
export async function rotateApiKey(tenantId: string, principal: Principal, keyId: string) {
  parseInput(z.string().uuid(), keyId);
  const key = newKey();
  const actor = actorOf(principal);
  const id = await tx('rotate_key', async (db) => {
    const [old] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.tenantId, tenantId)))
      .for('update');
    if (!old) throw new DomainError('not_found', 'Key not found');
    if (old.revokedAt) throw new DomainError('conflict', 'This key is already revoked');
    if (!(ISSUABLE_KEY_KINDS as readonly string[]).includes(old.principal)) {
      throw new DomainError('forbidden', 'Only the operator key issues house and platform keys');
    }
    const values: KeyValues = {
      name: old.name,
      principal: old.principal,
      ...(old.memberId ? { memberId: old.memberId } : {}),
      ...(old.agentId ? { agentId: old.agentId } : {}),
    };
    const id = await insertKey(db, tenantId, actor, values, key, { rotatedFrom: old.id });
    await revokeKey(db, tenantId, actor, old.id, { rotatedTo: id });
    return id;
  });
  return { id, key, replaced: keyId };
}

/**
 * Every key the tenant has had, live and revoked, for an access review: who it speaks for, who
 * issued it, when it was last used, and who revoked it. Never the key or its hash.
 */
export async function listApiKeys(tenantId: string) {
  const { db } = deps();
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(asc(apiKeys.createdAt));
  return rows.map((k) => ({
    id: k.id,
    name: k.name,
    principal: k.principal,
    memberId: k.memberId,
    agentId: k.agentId,
    createdBy: k.createdBy,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    revokedBy: k.revokedBy,
    active: k.revokedAt === null,
  }));
}

/** `last_used_at` moves at most this often, so reads do not all write. */
const KEY_TOUCH_MS = 60_000;

export async function principalForKey(key: string): Promise<Principal | null> {
  const [row] = await deps()
    .db.select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashToken(key)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  // A suspended agent's credential stops working with it.
  if (row.agentId && (await getAgent(deps().db, row.agentId)).status !== 'active') return null;
  const now = new Date();
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= KEY_TOUCH_MS) {
    await deps()
      .db.update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.id, row.id),
          or(
            isNull(apiKeys.lastUsedAt),
            lt(apiKeys.lastUsedAt, new Date(now.getTime() - KEY_TOUCH_MS)),
          ),
        ),
      );
  }
  return {
    kind: row.principal,
    id: row.id,
    name: row.name,
    tenantId: row.tenantId,
    memberId: row.memberId ?? undefined,
    agentId: row.agentId ?? undefined,
  };
}

/** Count a request against its credential. False once it is over the limit for this minute. */
export async function withinRateLimit(keyId: string, perMinute: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const [row] = await deps()
    .db.insert(apiRateWindows)
    .values({ keyId, windowStart })
    .onConflictDoUpdate({
      target: [apiRateWindows.keyId, apiRateWindows.windowStart],
      set: { requests: sql`${apiRateWindows.requests} + 1` },
    })
    .returning({ requests: apiRateWindows.requests });
  return (row?.requests ?? 0) <= perMinute;
}
