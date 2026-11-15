import { DomainError, type Json, type Principal, parseInput } from '@novate/core';
import { deals, programs } from '@novate/db';
import { ProgramSpec } from '@novate/policy';
import { and, asc, count, desc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { actorOf, recordControl } from './control.ts';
import { railRefusal } from './deal-policy.ts';
import { deps, tx } from './deps.ts';

export const PublishProgram = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  spec: ProgramSpec,
  /** Why this version exists, kept with it and in the record of control actions. */
  note: z.string().min(1).max(500).optional(),
});

/** Publish a new immutable version of a program. Deals keep the version they were accepted under. */
export async function publishProgram(
  tenantId: string,
  principal: Principal,
  input: z.input<typeof PublishProgram>,
) {
  const { key, spec, note } = parseInput(PublishProgram, input);
  const actor = actorOf(principal);
  const refusal = railRefusal(tenantId, spec.settlement.rail);
  if (refusal) throw new DomainError('invalid', refusal);
  return tx('publish_program', async (db) => {
    const [current] = await db
      .select({ version: max(programs.version) })
      .from(programs)
      .where(and(eq(programs.tenantId, tenantId), eq(programs.key, key)));
    const [row] = await db
      .insert(programs)
      .values({
        tenantId,
        key,
        version: (current?.version ?? 0) + 1,
        spec: spec as unknown as Record<string, unknown>,
        createdBy: actor,
        note: note ?? null,
      })
      .returning();
    const published = row as typeof programs.$inferSelect;
    await recordControl(db, tenantId, actor, {
      type: 'program_published',
      reason: note,
      payload: { programKey: key, version: published.version, programId: published.id },
    });
    return published;
  });
}

export async function latestProgram(tenantId: string, key: string) {
  const [row] = await deps()
    .db.select()
    .from(programs)
    .where(and(eq(programs.tenantId, tenantId), eq(programs.key, key)))
    .orderBy(desc(programs.version))
    .limit(1);
  if (!row) throw new DomainError('not_found', `Program ${key} not found`);
  return programView(row);
}

/** A program as published. Its spec was stored already parsed, so this is the type it has. */
const programView = (row: typeof programs.$inferSelect) => ({
  ...row,
  spec: row.spec as Json<ProgramSpec>,
});

/** Every version of every program, newest first, with how many deals each one governs. */
export async function listPrograms(tenantId: string) {
  const { db } = deps();
  const [rows, usage] = await Promise.all([
    db
      .select()
      .from(programs)
      .where(eq(programs.tenantId, tenantId))
      .orderBy(asc(programs.key), desc(programs.version)),
    db
      .select({ programId: deals.programId, deals: count() })
      .from(deals)
      .where(eq(deals.tenantId, tenantId))
      .groupBy(deals.programId),
  ]);
  return rows.map((r) => ({
    ...programView(r),
    deals: usage.find((u) => u.programId === r.id)?.deals ?? 0,
  }));
}
