import { createDb, createPool, users } from '@novate/db';
import {
  defaultTenantId,
  hashPassword,
  operatorActor,
  tenantSettings,
  writeSettings,
} from '@novate/engine';

const DEMO_USERS = [
  { role: 'house', email: 'house@demo.local', name: 'Demo house', password: 'demo-house-password' },
  // A second house person, so what one asks for, such as a manual credit, can be approved.
  {
    role: 'house',
    email: 'checker@demo.local',
    name: 'Demo checker',
    password: 'demo-checker-password',
  },
  {
    role: 'platform',
    email: 'platform@demo.local',
    name: 'Demo platform',
    password: 'demo-platform-password',
  },
] as const;

/** Signs in to the member portal once the demo's brand has joined. */
const DEMO_MEMBER_USER = {
  role: 'member',
  member: 'Homeware brand',
  email: 'treasurer@homeware.demo',
  name: 'Homeware treasurer',
  password: 'demo-member-password',
} as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Sign-in accounts with known passwords in the installation's default tenant, for trying the
 * console on this machine. Refused unless the database is local, named in `allowed`, and the
 * process is not in production, so it cannot run against a real installation.
 */
export async function ensureDemoUsers(
  databaseUrl: string,
  allowed: readonly string[] = ['novate_demo'],
) {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    process.env.NODE_ENV === 'production' ||
    !LOCAL_HOSTS.has(url.hostname) ||
    !allowed.includes(name)
  ) {
    throw new Error(`Demo users are only made on a local ${allowed.join(' or ')} database`);
  }
  const pool = createPool(databaseUrl, 1);
  try {
    const db = createDb(pool);
    const tenantId = await defaultTenantId(db);
    return await db.transaction(async (t) => {
      const brand = await t.query.members.findFirst({
        where: (m, { and, eq }) =>
          and(eq(m.tenantId, tenantId), eq(m.name, DEMO_MEMBER_USER.member)),
        orderBy: (m, { asc }) => asc(m.createdAt),
      });
      const demos = [
        ...DEMO_USERS.map((u) => ({ ...u, memberId: null })),
        ...(brand ? [{ ...DEMO_MEMBER_USER, memberId: brand.id }] : []),
      ];
      for (const demo of demos) {
        const hash = await hashPassword(demo.password);
        await t
          .insert(users)
          .values({
            tenantId,
            email: demo.email,
            name: demo.name,
            role: demo.role,
            memberId: demo.memberId,
            passwordHash: hash,
            status: 'active',
            createdBy: operatorActor('demo setup'),
          })
          .onConflictDoUpdate({
            target: [users.tenantId, users.email],
            set: {
              passwordHash: hash,
              memberId: demo.memberId,
              status: 'active',
              failedLogins: 0,
              lockedUntil: null,
            },
          });
      }
      // Demo accounts have no authenticator, so two-step sign-in is off here, and the record says so.
      if ((await tenantSettings(t, tenantId)).requireTwoStep) {
        await writeSettings(
          t,
          tenantId,
          operatorActor('demo setup'),
          { requireTwoStep: false },
          `Demo accounts on the local ${name} database sign in without two-step`,
        );
      }
      return demos.map(({ role, email, password }) => ({ role, email, password }));
    });
  } finally {
    await pool.end();
  }
}
