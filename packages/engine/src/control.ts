import { type ControlActor, DomainError, type Principal, parseInput } from '@novate/core';
import { controlEvents, type Tx } from '@novate/db';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { deps } from './deps.ts';
import { newestFirst, pageOf } from './page.ts';
import { type PopulationInput, populationOf, type Window, within } from './population.ts';

export type ControlType = (typeof controlEvents.$inferInsert)['type'];

/** The house acting on its own, such as reconciliation stopping settlement. */
export const SYSTEM: ControlActor = { kind: 'system', via: 'system' };

/** A signed-in person is recorded by user id, a key by key id, and `via` says which it was. */
export const actorOf = (p: Principal): ControlActor => ({
  kind: p.kind,
  ...(p.userId
    ? { userId: p.userId, via: 'session' as const }
    : { keyId: p.id, via: 'key' as const }),
  ...(p.name ? { name: p.name } : {}),
  ...(p.operator ? { operator: p.operator } : {}),
});

/** The holder of the operator key, which belongs to no tenant. */
export const operatorActor = (operator?: string): ControlActor => ({
  kind: 'operator',
  via: 'key',
  ...(operator ? { operator } : {}),
});

/**
 * The signed-in user behind an action that moves or hides money. A key on its own, or a name typed
 * into `X-Operator`, cannot say which person acted, and two people cannot be told apart by one key.
 */
export function personOf(principal: Principal, what = 'do this'): string {
  if (!principal.userId) {
    throw new DomainError('person_required', `Sign in as yourself to ${what}`);
  }
  return principal.userId;
}

/** Keep a record of a control action, in the same transaction as the action itself. */
export async function recordControl(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  event: { type: ControlType; reason?: string | null; payload?: Record<string, unknown> },
): Promise<string> {
  const [row] = await db
    .insert(controlEvents)
    .values({
      tenantId,
      actor,
      type: event.type,
      reason: event.reason ?? null,
      payload: event.payload ?? {},
    })
    .returning({ id: controlEvents.id });
  return row?.id as string;
}

/** A reason a person must give for a control action. */
export const Reason = z.string().trim().min(1).max(500);

/** The input of a control action that takes nothing but its reason. */
export const ReasonInput = z.object({ reason: Reason });

/** Only these types of control action; one or many. */
const ControlTypes = z
  .union([z.enum(controlEvents.type.enumValues), z.array(z.enum(controlEvents.type.enumValues))])
  .optional()
  .transform((t) => (t === undefined ? undefined : [t].flat()));

/** Control actions, newest first, within a window an auditor chooses, of the types asked for. */
export const controlEventFeed = async (
  tenantId: string,
  input?: PopulationInput & { type?: string | string[] },
) => {
  const { type, ...window } = input ?? {};
  const types = parseInput(ControlTypes, type?.length ? type : undefined);
  return controlEventsIn(tenantId, populationOf(window, 200), types);
};

/** Control actions in a window already decided, such as an export's. */
export async function controlEventsIn(tenantId: string, w: Window, types?: ControlType[]) {
  const rows = await deps()
    .db.select()
    .from(controlEvents)
    .where(
      and(
        eq(controlEvents.tenantId, tenantId),
        ...within(controlEvents.createdAt, controlEvents.id, tenantId, w),
        types ? inArray(controlEvents.type, types) : undefined,
      ),
    )
    .orderBy(...newestFirst(controlEvents.createdAt, controlEvents.id))
    .limit(w.limit + 1);
  return pageOf(rows, w.limit, (r) => r.id);
}
