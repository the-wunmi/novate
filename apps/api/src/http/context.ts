import { DomainError, type Principal, parseInput, toJson } from '@novate/core';
import type * as engine from '@novate/engine';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

export type Env = {
  Variables: {
    /** Set by the route's guard. Open routes have none. */
    principal: Principal;
    /** Set when a person signed in with a session cookie rather than a key. */
    session?: { token: string; user: engine.UserRow };
  };
};
export type Ctx = Context<Env>;
export type App = Hono<Env>;

/** JSON with bigint amounts as strings of minor units. */
export const json = (value: unknown, status: ContentfulStatusCode = 200) =>
  new Response(toJson(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The request body, validated by the engine function it is handed to. No body is `undefined`. */
export async function input<T>(c: Ctx): Promise<T> {
  const body = await c.req.text();
  if (!body.trim()) return undefined as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new DomainError('malformed', 'The body is not valid JSON');
  }
}

/** Neutral on purpose: a member's key is told no without being told what the route is for. */
export const denied = () => new DomainError('forbidden', "This key can't see that");

/** The caller's tenant. Paths naming any other tenant never reach a handler. */
export const tenantOf = (c: Ctx) => c.get('principal').tenantId;

const MemberPath = z.object({ memberId: z.string().uuid() });

export const memberIdOf = (c: Ctx) => parseInput(MemberPath, c.req.param()).memberId;

/** A person's name for the record, from `X-Operator`. It is who said they acted, not a credential. */
export function operatorOf(c: Ctx): string | undefined {
  const given = c.req.header('x-operator')?.trim();
  if (!given) return undefined;
  if (given.length > 120)
    throw new DomainError('invalid', 'X-Operator is longer than 120 characters');
  return given;
}

/**
 * A population as CSV, named for what it is and when it was taken. Every export is the whole of its
 * range (one too large is refused with 413), and says so in headers: `X-Novate-Rows` (data rows,
 * header excluded), `X-Novate-From` and `X-Novate-To` (the range, from inclusive, to exclusive), and
 * `X-Novate-Range-Defaulted: true` when no `from` was given and the last 31 days were used.
 */
export const csv = (out: engine.CsvExport, name: string) =>
  new Response(out.body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'x-novate-rows': String(out.rows),
      'x-novate-from': out.from.toISOString(),
      'x-novate-to': out.to.toISOString(),
      ...(out.defaulted ? { 'x-novate-range-defaulted': 'true' } : {}),
      'access-control-expose-headers':
        'x-novate-rows, x-novate-from, x-novate-to, x-novate-range-defaulted',
    },
  });
