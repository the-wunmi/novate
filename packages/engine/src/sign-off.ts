import { DomainError, type Principal, parseInput, sha256 } from '@novate/core';
import { controlEvents, reconRuns } from '@novate/db';
import { railLabel } from '@novate/rails';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { businessDay } from './calendar.ts';
import { actorOf, personOf, Reason, recordControl } from './control.ts';
import { deps, tx } from './deps.ts';
import { newestFirst } from './page.ts';
import { openBreakRows } from './recon-breaks.ts';
import { comparisonOf, countedBreaks, differences } from './reconciliation.ts';
import { lockTenantFor } from './repo.ts';
import { tenantSettings } from './settings.ts';

export const SignOffBooks = z
  .object({
    /** Required while any difference is open: what the signer knows about it. */
    note: z.string().trim().min(1).max(500).optional(),
    /** Sign off a day that is already signed off, replacing that sign-off. Needs a reason. */
    supersede: z.boolean().default(false),
    reason: Reason.optional(),
  })
  .refine((s) => !s.supersede || s.reason, {
    message: 'Superseding a sign-off needs a reason',
    path: ['reason'],
  });

/**
 * A person's end-of-day sign-off of the books, as they stood: when each owned rail was last
 * checked, what each side held in each currency at that check, a hash of that snapshot, and how
 * many differences are open. Refused if any owned rail has not been checked that day, without a
 * note while differences are open, and a second time for the same day unless it supersedes the
 * first with a reason.
 */
export async function signOffBooks(
  tenantId: string,
  principal: Principal,
  input?: z.input<typeof SignOffBooks>,
) {
  const { note, supersede, reason } = parseInput(SignOffBooks, input ?? {});
  personOf(principal, 'sign off the books');
  const owned = Object.entries(deps().railOwners).flatMap(([rail, owner]) =>
    owner === tenantId ? [rail] : [],
  );
  return tx('books_sign_off', async (db) => {
    const { timeZone } = await tenantSettings(db, tenantId);
    const { date, start: dayStart } = businessDay(new Date(), timeZone);
    // One sign-off per day: two people signing at once must not both succeed.
    await lockTenantFor(db, tenantId, 'sign_off');
    const rails = [];
    for (const rail of owned) {
      const [last] = await db
        .select({
          id: reconRuns.id,
          at: reconRuns.createdAt,
          status: reconRuns.status,
          summary: reconRuns.summary,
        })
        .from(reconRuns)
        .where(
          and(
            eq(reconRuns.tenantId, tenantId),
            eq(reconRuns.rail, rail),
            ne(reconRuns.status, 'opening'),
          ),
        )
        .orderBy(...newestFirst(reconRuns.createdAt, reconRuns.id))
        .limit(1);
      rails.push({
        rail,
        lastCheckAt: last?.at ?? null,
        status: last?.status ?? null,
        runId: last?.id ?? null,
        positions: last ? comparisonOf(last.summary).positions : [],
      });
    }
    const unchecked = rails.filter((r) => !r.lastCheckAt || r.lastCheckAt < dayStart);
    if (unchecked.length) {
      throw new DomainError(
        'conflict',
        `No check ran on ${date} (${timeZone}) for ${unchecked.map((r) => railLabel(r.rail)).join(', ')}`,
      );
    }
    const openBreakCount = countedBreaks(await openBreakRows(db, tenantId)).length;
    if (openBreakCount && !note) {
      throw new DomainError(
        'invalid',
        `${differences(openBreakCount)} still open: add a note saying what is known about ${openBreakCount === 1 ? 'it' : 'them'}`,
        { openBreaks: openBreakCount },
      );
    }
    const earlier = (
      await db
        .select({
          id: controlEvents.id,
          payload: controlEvents.payload,
          at: controlEvents.createdAt,
        })
        .from(controlEvents)
        .where(
          and(
            eq(controlEvents.tenantId, tenantId),
            eq(controlEvents.type, 'books_signed_off'),
            sql`${controlEvents.payload}->>'date' = ${date}`,
          ),
        )
        .orderBy(...newestFirst(controlEvents.createdAt, controlEvents.id))
        .limit(1)
    )[0];
    if (earlier && !supersede) {
      throw new DomainError(
        'conflict',
        `The books for ${date} were already signed off: send supersede with a reason to replace that sign-off`,
        { signOffId: earlier.id, at: earlier.at },
      );
    }
    const snapshot = rails.map((r) => ({ rail: r.rail, runId: r.runId, positions: r.positions }));
    const payload = {
      date,
      timeZone,
      rails,
      openBreaks: openBreakCount,
      snapshotHash: sha256(snapshot),
      ...(supersede && earlier ? { supersedes: { id: earlier.id, reason } } : {}),
    };
    const id = await recordControl(db, tenantId, actorOf(principal), {
      type: 'books_signed_off',
      reason: note ?? null,
      payload,
    });
    return { id, ...payload };
  });
}
