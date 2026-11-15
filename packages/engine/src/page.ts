import { decisionCases, decisionRecords } from '@novate/db';
import {
  type AnyColumn,
  desc,
  getTableColumns,
  getTableName,
  type SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

/*
 * Every list pages newest first on (created_at, id). The cursor a page returns as `next` is the id of
 * its last row, and the next page reads rows strictly after that row's own (created_at, id), which
 * Postgres compares at full precision. Rows written in one transaction share a created_at, so a
 * timestamp alone would skip or repeat them at a page boundary; the id breaks the tie.
 */

/** A page of rows, and the cursor to pass as `before` for the next one, or null at the end. */
export interface Page<T> {
  rows: T[];
  next: string | null;
}

/** The cursor of the uuid-keyed lists: the id of the previous page's last row. */
export const Cursor = z.string().uuid();

/** Newest first, ties broken by id, the order `keyset` pages through. */
export const newestFirst = (at: AnyColumn, id: AnyColumn | SQL) => [desc(at), desc(id)];

/**
 * Rows of `table` that belong to the tenant, inside a subselect from it. A cursor naming another
 * tenant's row then places nothing, so its time is never compared.
 */
export function ofTenant(table: Table, tenantId: string): SQL {
  if (table === decisionRecords) {
    return sql`exists (select 1 from ${decisionCases} where ${decisionCases.id} = ${decisionRecords.caseId} and ${decisionCases.tenantId} = ${tenantId})`;
  }
  const tenant = (getTableColumns(table) as Record<string, PgColumn | undefined>).tenantId;
  if (!tenant) throw new Error(`${getTableName(table)} has no tenant to page within`);
  return sql`${tenant} = ${tenantId}`;
}

/** Where the tenant's row `before` names sits in the order: its (created_at, id), from its own table. */
export const placeOf = (at: PgColumn, id: PgColumn, tenantId: string, before: string): SQL =>
  sql`(select ${at}, ${id} from ${sql.identifier(getTableName(at.table))} where ${id} = ${before} and ${ofTenant(at.table, tenantId)})`;

/** The rows strictly after `before` in `newestFirst` order. Nothing to add on the first page. */
export const keyset = (
  at: PgColumn,
  id: PgColumn,
  tenantId: string,
  before: string | undefined,
): SQL | undefined =>
  before === undefined ? undefined : sql`(${at}, ${id}) < ${placeOf(at, id, tenantId, before)}`;

/** The rows strictly newer than the row `id` names, in the same order. */
export const newerThan = (at: PgColumn, id: PgColumn, tenantId: string, row: string): SQL =>
  sql`(${at}, ${id}) > ${placeOf(at, id, tenantId, row)}`;

/**
 * Cut what a query read (one row past `limit`) to a page: the extra row only says another page
 * follows, and the cursor is the last row kept.
 */
export function pageOf<T>(rows: T[], limit: number, idOf: (row: T) => string): Page<T> {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return { rows: kept, next: rows.length > limit && last ? idOf(last) : null };
}
