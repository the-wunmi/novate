import { userInfo } from 'node:os';
import { USER_ROLES } from '@novate/core';
import { createDb, createPool } from '@novate/db';
import { configureAuth, defaultTenantId, inviteOrReinvite } from '@novate/engine';
import { z } from 'zod';
import { authFromEnv } from './env.ts';

/**
 * `pnpm user:invite <email> <role> [memberId] [--tenant=<id>] [--name=<name>]`: the way back in
 * when nobody can sign in. Run on the machine holding the database, never over the API. Invites
 * someone unknown, re-invites someone who never accepted, and resets anyone else (sessions ended,
 * password and two-step sign-in cleared) before issuing their link. The tenant defaults to the
 * installation's default tenant.
 */
const args = process.argv.slice(2);
const flag = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;
const [email, roleArg, memberId] = args.filter((a) => !a.startsWith('--'));
const role = z.enum(USER_ROLES).safeParse(roleArg);
if (!email || !role.success) {
  console.error(
    `Usage: pnpm user:invite <email> <${USER_ROLES.join('|')}> [memberId] [--tenant=<id>]`,
  );
  process.exit(1);
}

configureAuth(authFromEnv(process.env.PORT ?? 4000));
const pool = createPool(process.env.NOVATE_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
try {
  const db = createDb(pool);
  const tenantId = flag('tenant') ?? (await defaultTenantId(db));
  const manager = { kind: 'operator' as const, operator: `cli:${userInfo().username}` };
  const out = await db.transaction((t) =>
    inviteOrReinvite(t, tenantId, manager, {
      email,
      name: flag('name') ?? email.split('@')[0] ?? email,
      role: role.data,
      memberId,
    }),
  );
  console.log(
    `\n${out.user.email} (${out.user.role}). This link works once, for 72 hours:\n\n  ${out.inviteUrl}\n`,
  );
} finally {
  await pool.end();
}
