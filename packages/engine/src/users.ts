import {
  type ControlActor,
  DomainError,
  type Principal,
  parseInput,
  USER_ROLES,
  type UserRole,
} from '@novate/core';
import { type SESSION_ENDS, sessions, type Tx, tenants, userInvites, users } from '@novate/db';
import { and, asc, desc, eq, gt, isNull, lt, max, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { authConfig, type InviteDelivery } from './auth-config.ts';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  matchTotp,
  newToken,
  newTotpSecret,
  otpauthUrl,
  verifyPassword,
} from './auth-crypto.ts';
import { actorOf, operatorActor, personOf, ReasonInput, recordControl, SYSTEM } from './control.ts';
import { deps, tx } from './deps.ts';
import { notify } from './notifications.ts';
import { inTenant, memberInTenant } from './repo.ts';
import { readTenantSettings } from './settings.ts';

/** The time sign-in is judged by. Tests move it to see sessions and lockouts expire. */
export const authClock = { now: () => new Date() };

const MINUTE = 60_000;
/** A session ends this long after sign-in, however active it is. */
export const SESSION_TTL_MS = 12 * 60 * MINUTE;
/** ...or after this long without a request. */
export const SESSION_IDLE_MS = 30 * MINUTE;
/** The access review shows at most this many of a user's most recent sessions. */
const SESSION_REVIEW_LIMIT = 200;
/** Ended sessions stay for the access review this long, then go. */
export const SESSION_RETENTION_MS = 90 * 24 * 60 * MINUTE;
/** How stale `last_seen_at` may get before a request moves it, so reads do not all write. */
const TOUCH_AFTER_MS = MINUTE;
export const INVITE_TTL_MS = 72 * 60 * MINUTE;
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MS = 15 * MINUTE;

export type UserRow = typeof users.$inferSelect;

/** What anyone may be shown about a user. Never the password hash or the TOTP secret. */
export const publicUser = (u: UserRow) => ({
  id: u.id,
  tenantId: u.tenantId,
  email: u.email,
  name: u.name,
  role: u.role,
  memberId: u.memberId,
  status: u.status,
  mfa: u.totpEnabledAt !== null,
  createdAt: u.createdAt,
  lastLoginAt: u.lastLoginAt,
});
export type PublicUser = ReturnType<typeof publicUser>;

/** The same `Principal` a key gives, so every route and permission treats a person the same way. */
export const principalOfUser = (u: UserRow): Principal => ({
  kind: u.role,
  id: u.id,
  name: u.name,
  operator: u.name,
  userId: u.id,
  tenantId: u.tenantId,
  ...(u.memberId ? { memberId: u.memberId } : {}),
});

/** Whoever is managing users: a signed-in person or key, or the holder of the operator key. */
export type Manager = Principal | { kind: 'operator'; operator?: string };

const managerActor = (m: Manager): ControlActor =>
  m.kind === 'operator' ? operatorActor(m.operator) : actorOf(m);

/** Whether a manager is the person being managed. */
const isSelf = (m: Manager, userId: string) => m.kind !== 'operator' && m.userId === userId;

/** Clears two-step sign-in. */
const NO_MFA = { totpSecret: null, totpEnabledAt: null, totpLastStep: null } as const;
/** Clears failed sign-ins and any lock they caused. */
const UNLOCKED = { failedLogins: 0, lockedUntil: null } as const;

/**
 * The house manages everyone; the platform manages its own people and members' people; nobody
 * else manages users. Only the operator key can make the first house user, and only the house
 * brings in an auditor.
 */
export function mayManage(manager: Manager, role: UserRole): boolean {
  if (manager.kind === 'operator' || manager.kind === 'house') return true;
  if (manager.kind === 'platform') return role !== 'house' && role !== 'auditor';
  return false;
}

/** Whose sessions someone may review: those they manage, and anyone's for an auditor. */
const mayReview = (manager: Manager, role: UserRole) =>
  manager.kind === 'auditor' || mayManage(manager, role);

const forbidden = () => new DomainError('forbidden', "You can't manage that user");

/** Loose on purpose: `admin@localhost` is a fine first address on a fresh install. */
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+$/, 'Not an email address');

const Password = z.string().min(12, 'At least 12 characters').max(1024);

function checkPassword(password: string, email: string): string {
  const parsed = parseInput(Password, password);
  if (parsed.trim().toLowerCase() === email) {
    throw new DomainError('invalid', 'Your password cannot be your email address');
  }
  return parsed;
}

const INVITE_PATH = '/console/#/invite/';

/** Where an invite is opened. The token is in the fragment, so it never reaches a server log. */
export function inviteUrl(token: string): string {
  return `${authConfig().publicUrl}${INVITE_PATH}${token}`;
}

/** The token an invite link carries. */
export function inviteToken(url: string | undefined): string {
  const token = url?.split(INVITE_PATH)[1];
  if (!token) throw new Error(`Not an invite link: ${url}`);
  return token;
}

/** An invite link on its way to someone, sent once the transaction that made it has committed. */
interface IssuedInvite {
  user: UserRow;
  token: string;
  expiresAt: Date;
  delivered: InviteDelivery;
  why: 'invited' | 'reinvited' | 'reset';
}

/** What the inviter is told: the link only when the inviter is the one who delivers it. */
const inviteAnswer = (i: IssuedInvite) => ({
  user: publicUser(i.user),
  delivered: i.delivered,
  expiresAt: i.expiresAt,
  ...(i.delivered === 'inviter' ? { inviteUrl: inviteUrl(i.token) } : {}),
});
export type InviteAnswer = ReturnType<typeof inviteAnswer>;

/** Send the link of an invite made with `notification` delivery. Call after the commit. */
async function deliverInvite(i: IssuedInvite): Promise<void> {
  if (i.delivered !== 'notification') return;
  await notify({
    type: 'user_invite',
    tenantId: i.user.tenantId,
    userId: i.user.id,
    email: i.user.email,
    name: i.user.name,
    role: i.user.role,
    inviteUrl: inviteUrl(i.token),
    expiresAt: i.expiresAt.toISOString(),
    why: i.why,
  });
}

/** Who a user is, for the record of anything done to them. */
const userFacts = (u: UserRow) => ({
  userId: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  memberId: u.memberId,
});

/** A new invite link for `user`. Any older unused link stops working. */
async function issueInvite(db: Tx, user: UserRow, actor: ControlActor): Promise<string> {
  const now = authClock.now();
  await db
    .update(userInvites)
    .set({ expiresAt: now })
    .where(
      and(
        eq(userInvites.userId, user.id),
        isNull(userInvites.usedAt),
        gt(userInvites.expiresAt, now),
      ),
    );
  const token = newToken();
  await db.insert(userInvites).values({
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    createdBy: actor,
  });
  return token;
}

export const InviteUser = z
  .object({
    email: Email,
    name: z.string().trim().min(1).max(120),
    role: z.enum(USER_ROLES),
    memberId: z.string().uuid().optional(),
  })
  .refine((u) => (u.role === 'member') === (u.memberId !== undefined), {
    message: 'A member user needs a memberId, and only a member user has one',
  });

/** Insert an invited user and its first link, without recording a control event. */
async function insertInvited(
  db: Tx,
  tenantId: string,
  actor: ControlActor,
  values: z.output<typeof InviteUser>,
): Promise<{ user: UserRow; token: string }> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new DomainError('not_found', 'Tenant not found');
  if (values.memberId) await memberInTenant(db, tenantId, values.memberId);
  const [row] = await db
    .insert(users)
    .values({ ...values, memberId: values.memberId ?? null, tenantId, createdBy: actor })
    .onConflictDoNothing({ target: [users.tenantId, users.email] })
    .returning();
  if (!row) throw new DomainError('conflict', 'A user with that email already exists');
  return { user: row, token: await issueInvite(db, row, actor) };
}

const inviteExpiry = () => new Date(authClock.now().getTime() + INVITE_TTL_MS);

/** Invite a person, inside the caller's transaction. Only the link's hash is stored. */
export async function addUser(
  db: Tx,
  tenantId: string,
  manager: Manager,
  input: z.input<typeof InviteUser>,
  delivered: InviteDelivery = authConfig().inviteDelivery,
): Promise<IssuedInvite> {
  const values = parseInput(InviteUser, input);
  if (!mayManage(manager, values.role)) throw forbidden();
  const actor = managerActor(manager);
  const { user, token } = await insertInvited(db, tenantId, actor, values);
  await recordControl(db, tenantId, actor, {
    type: 'user_invited',
    payload: { ...userFacts(user), delivered },
  });
  return { user, token, expiresAt: inviteExpiry(), delivered, why: 'invited' };
}

/** Invite a person. The link goes to them as a notification, or back to the inviter once. */
export async function inviteUser(
  tenantId: string,
  manager: Manager,
  input: z.input<typeof InviteUser>,
): Promise<InviteAnswer> {
  const issued = await tx('invite_user', (db) => addUser(db, tenantId, manager, input));
  await deliverInvite(issued);
  return inviteAnswer(issued);
}

/** The first house and platform users of a new installation, invited by the first boot. */
export async function inviteFirstUsers(
  db: Tx,
  tenantId: string,
  emails: { house: string; platform: string },
): Promise<{ role: UserRole; email: string; inviteUrl: string }[]> {
  const out = [];
  for (const role of ['house', 'platform'] as const) {
    const values = parseInput(InviteUser, {
      email: emails[role],
      name: role === 'house' ? 'House admin' : 'Platform admin',
      role,
    });
    // The first boot prints these links to whoever runs it: the operator delivers them. The
    // `instance_setup` row is the record; the users' `created_by` says 'first boot'.
    const { user, token } = await insertInvited(db, tenantId, operatorActor('first boot'), values);
    out.push({ role, email: user.email, inviteUrl: inviteUrl(token) });
  }
  return out;
}

export const ListUsers = z.object({ memberId: z.string().uuid().optional() });

/**
 * The tenant's people, oldest first; with `memberId`, only that member's. Someone still invited
 * carries when their latest link stops working, which is in the past once it has.
 */
export async function listUsers(tenantId: string, input: z.input<typeof ListUsers> = {}) {
  const { memberId } = parseInput(ListUsers, input);
  const { db } = deps();
  const invites = db
    .select({ userId: userInvites.userId, expiresAt: max(userInvites.expiresAt).as('expires_at') })
    .from(userInvites)
    .where(isNull(userInvites.usedAt))
    .groupBy(userInvites.userId)
    .as('open_invites');
  const rows = await db
    .select({ u: users, inviteExpiresAt: invites.expiresAt })
    .from(users)
    .leftJoin(invites, eq(invites.userId, users.id))
    .where(and(eq(users.tenantId, tenantId), memberId ? eq(users.memberId, memberId) : undefined))
    .orderBy(asc(users.createdAt));
  return rows.map(({ u, inviteExpiresAt }) => ({
    ...publicUser(u),
    createdBy: u.createdBy,
    lockedUntil: u.lockedUntil,
    inviteExpiresAt: u.status === 'invited' ? inviteExpiresAt : null,
  }));
}

/** A member's own people, as its users may see them: who, their role, and how they sign in. */
export async function memberUsers(tenantId: string, memberId: string) {
  await memberInTenant(deps().db, tenantId, memberId);
  return (await listUsers(tenantId, { memberId })).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    mfa: u.mfa,
    lastLoginAt: u.lastLoginAt,
    inviteExpiresAt: u.inviteExpiresAt,
  }));
}

async function lockUser(db: Tx, userId: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).for('update');
  return row;
}

async function managedUser(db: Tx, tenantId: string, manager: Manager, userId: string) {
  parseInput(z.string().uuid(), userId);
  const user = inTenant(await lockUser(db, userId), tenantId, 'User');
  if (!mayManage(manager, user.role)) throw forbidden();
  return user;
}

/** Why a session ended early. Kept on the session, for the access review. */
export type SessionEnd = (typeof SESSION_ENDS)[number];

/** How a session ended, or null while it still signs its user in. */
function sessionEnded(
  s: typeof sessions.$inferSelect,
  now: Date,
): SessionEnd | 'expired' | 'idle' | null {
  if (s.endedReason) return s.endedReason;
  if (s.expiresAt <= now) return 'expired';
  if (s.lastSeenAt.getTime() <= now.getTime() - SESSION_IDLE_MS) return 'idle';
  return null;
}

const revokeSessions = (db: Tx, userId: string, reason: SessionEnd, except?: string) =>
  db
    .update(sessions)
    .set({ revokedAt: authClock.now(), endedReason: reason })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        ...(except ? [ne(sessions.idHash, except)] : []),
      ),
    );

/** Disable or re-enable a user. Disabling ends every session they have at once. */
export function setUserStatus(
  tenantId: string,
  manager: Manager,
  userId: string,
  status: 'disabled' | 'enabled',
  input: z.input<typeof ReasonInput>,
) {
  const { reason } = parseInput(ReasonInput, input);
  return tx('set_user_status', async (db) => {
    const user = await managedUser(db, tenantId, manager, userId);
    if (status === 'disabled' && isSelf(manager, user.id)) {
      throw new DomainError('invalid', 'You cannot disable yourself');
    }
    const enabled = user.passwordHash ? 'active' : 'invited';
    if (status === 'disabled' ? user.status === 'disabled' : user.status !== 'disabled') {
      return { user: publicUser(user) };
    }
    const [row] = await db
      .update(users)
      .set(status === 'disabled' ? { status: 'disabled' } : { status: enabled, ...UNLOCKED })
      .where(eq(users.id, user.id))
      .returning();
    if (status === 'disabled') await revokeSessions(db, user.id, 'user_disabled');
    await recordControl(db, tenantId, managerActor(manager), {
      type: status === 'disabled' ? 'user_disabled' : 'user_enabled',
      reason,
      payload: userFacts(user),
    });
    return { user: publicUser(row as UserRow) };
  });
}

/**
 * A new link for someone who has never accepted an invite, because the first was lost or expired.
 * Anyone who has signed in before is reset instead (`resetUser`), which needs a reason.
 */
export async function reinvite(
  db: Tx,
  tenantId: string,
  manager: Manager,
  userId: string,
  delivered: InviteDelivery = authConfig().inviteDelivery,
): Promise<IssuedInvite> {
  const user = await managedUser(db, tenantId, manager, userId);
  if (user.status === 'disabled') throw new DomainError('conflict', 'Enable the user first');
  if (user.status !== 'invited') {
    throw new DomainError(
      'conflict',
      'This person has already signed in: reset their account, with a reason, to send a new link',
    );
  }
  const actor = managerActor(manager);
  const token = await issueInvite(db, user, actor);
  await recordControl(db, tenantId, actor, {
    type: 'user_invited',
    payload: { ...userFacts(user), reissued: true, delivered },
  });
  return { user, token, expiresAt: inviteExpiry(), delivered, why: 'reinvited' };
}

/**
 * The way back in for someone who has lost their password or authenticator. Every session they
 * have ends, their password and two-step sign-in are cleared, they are invited again, and the reset
 * is recorded with its reason. Nobody resets themselves, and a reset ties the two people together
 * for four-eyes purposes for 30 days (`assertIndependent`).
 */
export async function resetUserIn(
  db: Tx,
  tenantId: string,
  manager: Manager,
  userId: string,
  reason: string,
  delivered: InviteDelivery = authConfig().inviteDelivery,
): Promise<IssuedInvite> {
  const user = await managedUser(db, tenantId, manager, userId);
  if (user.status === 'disabled') throw new DomainError('conflict', 'Enable the user first');
  if (isSelf(manager, user.id)) {
    throw new DomainError('invalid', 'You cannot reset yourself: ask another administrator');
  }
  const actor = managerActor(manager);
  await revokeSessions(db, user.id, 'user_reset');
  const [row] = await db
    .update(users)
    .set({
      status: 'invited',
      passwordHash: null,
      ...NO_MFA,
      ...UNLOCKED,
    })
    .where(eq(users.id, user.id))
    .returning();
  const reset = row as UserRow;
  const token = await issueInvite(db, reset, actor);
  await recordControl(db, tenantId, actor, {
    type: 'user_reset',
    reason,
    payload: { ...userFacts(reset), from: user.status, delivered },
  });
  return { user: reset, token, expiresAt: inviteExpiry(), delivered, why: 'reset' };
}

export async function resetUser(
  tenantId: string,
  manager: Manager,
  userId: string,
  input: z.input<typeof ReasonInput>,
): Promise<InviteAnswer> {
  const { reason } = parseInput(ReasonInput, input);
  parseInput(z.string().uuid(), userId);
  const issued = await tx('reset_user', (db) => resetUserIn(db, tenantId, manager, userId, reason));
  await deliverInvite(issued);
  return inviteAnswer(issued);
}

/**
 * Invite `email`, or give the user already there a way back in: a new link if they never signed
 * in, a reset if they did. The operator's break-glass, run on the database's own machine, so the
 * link is always given to the operator (`delivered: 'inviter'`).
 */
export async function inviteOrReinvite(
  db: Tx,
  tenantId: string,
  manager: Manager,
  input: z.input<typeof InviteUser>,
  reason = 'Way back in, from the command line',
): Promise<InviteAnswer> {
  const values = parseInput(InviteUser, input);
  const [existing] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, values.email)));
  const issued = !existing
    ? await addUser(db, tenantId, manager, values, 'inviter')
    : existing.status === 'invited'
      ? await reinvite(db, tenantId, manager, existing.id, 'inviter')
      : await resetUserIn(db, tenantId, manager, existing.id, reason, 'inviter');
  return inviteAnswer(issued);
}

export async function reissueInvite(
  tenantId: string,
  manager: Manager,
  userId: string,
): Promise<InviteAnswer> {
  const issued = await tx('reissue_invite', (db) => reinvite(db, tenantId, manager, userId));
  await deliverInvite(issued);
  return inviteAnswer(issued);
}

/**
 * A user's sessions, newest first, for an access review: when each began and was last used, from
 * where, and how it ended. Never the session token or its hash.
 */
export async function userSessions(tenantId: string, manager: Manager, userId: string) {
  parseInput(z.string().uuid(), userId);
  const { db } = deps();
  const [found] = await db.select().from(users).where(eq(users.id, userId));
  if (!mayReview(manager, inTenant(found, tenantId, 'User').role)) throw forbidden();
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt))
    .limit(SESSION_REVIEW_LIMIT);
  const now = authClock.now();
  return rows.map((r) => {
    const ended = sessionEnded(r, now);
    return {
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      expiresAt: r.expiresAt,
      ip: r.ip,
      userAgent: r.userAgent,
      revokedAt: r.revokedAt,
      endedReason: ended,
      active: ended === null,
    };
  });
}

// ── Sessions ───────────────────────────────────────────────────────────────

/** Where a sign-in came from, kept on the session. */
export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

/** Where a request came from, trimmed to what the session and the record keep. */
const clientMeta = (meta: SessionMeta) => ({
  ip: meta.ip?.slice(0, 64) ?? null,
  userAgent: meta.userAgent?.slice(0, 300) ?? null,
});

async function openSession(db: Tx, user: UserRow, meta: SessionMeta): Promise<string> {
  const now = authClock.now();
  const token = newToken();
  await db.insert(sessions).values({
    idHash: hashToken(token),
    userId: user.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    lastSeenAt: now,
    ...clientMeta(meta),
  });
  return token;
}

/** The person a session cookie belongs to, or null once it has ended. Slides the idle timeout. */
export async function sessionFor(
  token: string,
): Promise<{ principal: Principal; user: UserRow } | null> {
  const now = authClock.now();
  const { db } = deps();
  const idHash = hashToken(token);
  const [row] = await db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, idHash), eq(users.status, 'active')));
  if (!row || sessionEnded(row.session, now)) return null;
  if (now.getTime() - row.session.lastSeenAt.getTime() >= TOUCH_AFTER_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.idHash, idHash));
  }
  return { principal: principalOfUser(row.user), user: row.user };
}

export async function logout(token: string): Promise<void> {
  await deps()
    .db.update(sessions)
    .set({ revokedAt: authClock.now(), endedReason: 'signed_out' })
    .where(and(eq(sessions.idHash, hashToken(token)), isNull(sessions.revokedAt)));
}

export const Login = z.object({
  tenantId: z.string().uuid().optional(),
  email: Email,
  password: z.string().min(1).max(1024),
  code: z.string().trim().max(16).optional(),
});

export interface SignedIn {
  user: PublicUser;
  token: string;
  /** A house or platform person without two-step sign-in, whom the console asks to turn it on. */
  mfaRequired?: true;
}

const wrongCredentials = () =>
  new DomainError(
    'invalid_credentials',
    'Wrong email or password, or the account is locked for now',
  );
const codeNeeded = () =>
  new DomainError('mfa_required', 'Enter the six-digit code from your authenticator app');

const isLocked = (u: UserRow, now: Date) => u.lockedUntil !== null && u.lockedUntil > now;

/** Count a failed sign-in. The fifth in a row locks the account for fifteen minutes. */
async function recordFailure(userId: string): Promise<void> {
  await tx('login_failed', async (db) => {
    const user = await lockUser(db, userId);
    if (!user) return;
    const now = authClock.now();
    const failures = user.failedLogins + 1;
    if (failures < LOCK_AFTER_FAILURES) {
      await db.update(users).set({ failedLogins: failures }).where(eq(users.id, userId));
      return;
    }
    const until = new Date(now.getTime() + LOCK_MS);
    await db.update(users).set({ failedLogins: 0, lockedUntil: until }).where(eq(users.id, userId));
    await recordControl(db, user.tenantId, SYSTEM, {
      type: 'user_login_locked',
      reason: `${LOCK_AFTER_FAILURES} failed sign-ins in a row`,
      payload: { userId, email: user.email, until: until.toISOString() },
    });
  });
}

/**
 * Sign a person in. A wrong email, a wrong password, a locked, invited or disabled account all
 * get the same answer, after the same amount of work. Without `tenantId`, the password is checked
 * in every tenant that has the email, so a match is found without saying where else it exists.
 */
export async function login(meta: SessionMeta, input: z.input<typeof Login>): Promise<SignedIn> {
  const { tenantId, email, password, code } = parseInput(Login, input);
  const now = authClock.now();
  const candidates = await deps()
    .db.select()
    .from(users)
    .where(and(eq(users.email, email), ...(tenantId ? [eq(users.tenantId, tenantId)] : [])));
  if (!candidates.length) {
    await verifyPassword(password, null);
    throw wrongCredentials();
  }
  const checked = await Promise.all(
    candidates.map(async (u) => ({
      user: u,
      // The hash is checked even when the answer is already no, so timing says nothing.
      ok: (await verifyPassword(password, u.passwordHash)) && u.status === 'active',
    })),
  );
  const usable = checked.filter((c) => !isLocked(c.user, now) && c.user.status === 'active');
  const matched = usable.filter((c) => c.ok);
  if (matched.length > 1) {
    throw new DomainError('invalid', 'Say which tenant: this email is in more than one');
  }
  const user = matched[0]?.user;
  if (!user) {
    for (const c of usable) await recordFailure(c.user.id);
    throw wrongCredentials();
  }
  let step: number | null = null;
  if (user.totpEnabledAt && user.totpSecret) {
    if (!code) throw codeNeeded();
    step = matchTotp(decryptSecret(user.totpSecret), code, now);
    if (step === null || step <= (user.totpLastStep ?? -1)) {
      await recordFailure(user.id);
      throw codeNeeded();
    }
  }
  const token = await tx('login', async (db) => {
    const updated = await db
      .update(users)
      .set({
        ...UNLOCKED,
        lastLoginAt: now,
        ...(step !== null ? { totpLastStep: step } : {}),
      })
      .where(
        and(
          eq(users.id, user.id),
          // A code accepted by a sign-in racing this one cannot be used again here.
          ...(step !== null ? [sql`coalesce(${users.totpLastStep}, -1) < ${step}`] : []),
        ),
      )
      .returning({ id: users.id });
    if (!updated.length) return null;
    const token = await openSession(db, user, meta);
    await recordControl(db, user.tenantId, actorOf(principalOfUser(user)), {
      type: 'user_signed_in',
      payload: {
        ...userFacts(user),
        ...clientMeta(meta),
        twoStep: step !== null,
      },
    });
    return token;
  });
  if (!token) throw codeNeeded();
  // People who can move money should turn two-factor sign-in on. The console asks them to.
  const nudge = user.role !== 'member' && !user.totpEnabledAt;
  return {
    user: publicUser({ ...user, ...UNLOCKED, lastLoginAt: now }),
    token,
    ...(nudge ? { mfaRequired: true } : {}),
  };
}

export const AcceptInvite = z.object({
  token: z.string().min(16).max(128),
  password: z.string(),
});

/** Set a password from an invite link, activate the user and sign them in. */
export async function acceptInvite(meta: SessionMeta, input: z.input<typeof AcceptInvite>) {
  const { token, password } = parseInput(AcceptInvite, input);
  const unusable = () =>
    new DomainError('invalid', 'This invite link has expired or was already used');
  const now = authClock.now();
  const [found] = await deps()
    .db.select({ email: users.email })
    .from(userInvites)
    .innerJoin(users, eq(users.id, userInvites.userId))
    .where(eq(userInvites.tokenHash, hashToken(token)));
  if (!found) throw unusable();
  const hash = await hashPassword(checkPassword(password, found.email));
  return tx('accept_invite', async (db) => {
    const [invite] = await db
      .select()
      .from(userInvites)
      .where(eq(userInvites.tokenHash, hashToken(token)))
      .for('update');
    if (!invite || invite.usedAt || invite.expiresAt <= now) throw unusable();
    const user = await lockUser(db, invite.userId);
    if (!user || user.status === 'disabled') throw unusable();
    await db.update(userInvites).set({ usedAt: now }).where(eq(userInvites.id, invite.id));
    const [row] = await db
      .update(users)
      .set({
        passwordHash: hash,
        status: 'active',
        ...UNLOCKED,
        ...NO_MFA,
        lastLoginAt: now,
      })
      .where(eq(users.id, user.id))
      .returning();
    await revokeSessions(db, user.id, 'invite_accepted');
    const active = row as UserRow;
    await recordControl(db, active.tenantId, actorOf(principalOfUser(active)), {
      type: 'invite_accepted',
      payload: {
        ...userFacts(active),
        inviteId: invite.id,
        invitedBy: invite.createdBy,
        ...clientMeta(meta),
      },
    });
    return { user: publicUser(active), token: await openSession(db, active, meta) };
  });
}

// ── The signed-in person's own account ─────────────────────────────────────

async function ownAccount(db: Tx, principal: Principal): Promise<UserRow> {
  const user = await lockUser(db, personOf(principal, 'change your account'));
  if (user?.status !== 'active') throw new DomainError('not_found', 'User not found');
  return user;
}

/** Who a signed-in person is, as `GET /me` answers. */
export const me = (u: UserRow) => ({
  kind: u.role,
  tenantId: u.tenantId,
  memberId: u.memberId,
  keyId: null,
  userId: u.id,
  name: u.name,
  email: u.email,
  mfa: u.totpEnabledAt !== null,
});

/** Who holds a key, in the same shape `me` gives a person. */
export const keyHolder = (p: Principal) => ({
  kind: p.kind,
  tenantId: p.tenantId,
  memberId: p.memberId ?? null,
  keyId: p.id,
  userId: null,
  name: p.name ?? null,
  email: null,
  mfa: false,
});

/** `GET /me`: who is asking, and the tenant's time zone, which every time they see is shown in. */
export async function whoAmI(user: UserRow | undefined, principal: Principal) {
  const who = user ? me(user) : keyHolder(principal);
  return { ...who, timeZone: (await readTenantSettings(who.tenantId)).timeZone };
}

/** Start setting up two-factor sign-in. The secret is shown once, to put in an authenticator app. */
export function startMfaSetup(principal: Principal) {
  return tx('mfa_setup', async (db) => {
    const user = await ownAccount(db, principal);
    if (user.totpEnabledAt) {
      throw new DomainError('conflict', 'Two-factor sign-in is already on. Turn it off first.');
    }
    const secret = newTotpSecret();
    await db
      .update(users)
      .set({ totpSecret: encryptSecret(secret), totpLastStep: null })
      .where(eq(users.id, user.id));
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  });
}

export const MfaCode = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Six digits'),
});

/** A code from the authenticator, at a step not used before. */
function acceptCode(user: UserRow, code: string): number {
  if (!user.totpSecret) throw new DomainError('conflict', 'Set up two-factor sign-in first');
  const step = matchTotp(decryptSecret(user.totpSecret), code, authClock.now());
  if (step === null || step <= (user.totpLastStep ?? -1)) {
    throw new DomainError('invalid', 'That code is not right');
  }
  return step;
}

export function enableMfa(principal: Principal, input: z.input<typeof MfaCode>) {
  const { code } = parseInput(MfaCode, input);
  return tx('mfa_enable', async (db) => {
    const user = await ownAccount(db, principal);
    if (user.totpEnabledAt) throw new DomainError('conflict', 'Two-factor sign-in is already on');
    const step = acceptCode(user, code);
    await db
      .update(users)
      .set({ totpEnabledAt: authClock.now(), totpLastStep: step })
      .where(eq(users.id, user.id));
    await recordControl(db, user.tenantId, actorOf(principal), {
      type: 'two_step_enabled',
      payload: userFacts(user),
    });
    return { mfa: true };
  });
}

export function disableMfa(principal: Principal, input: z.input<typeof MfaCode>) {
  const { code } = parseInput(MfaCode, input);
  return tx('mfa_disable', async (db) => {
    const user = await ownAccount(db, principal);
    if (!user.totpEnabledAt) throw new DomainError('conflict', 'Two-factor sign-in is not on');
    acceptCode(user, code);
    await db.update(users).set(NO_MFA).where(eq(users.id, user.id));
    await recordControl(db, user.tenantId, actorOf(principal), {
      type: 'two_step_disabled',
      payload: userFacts(user),
    });
    return { mfa: false };
  });
}

export const ChangePassword = z.object({
  current: z.string().min(1).max(1024),
  next: z.string(),
});

/** Change one's own password. Every other session of that user ends. */
export async function changePassword(
  principal: Principal,
  sessionToken: string,
  input: z.input<typeof ChangePassword>,
) {
  const { current, next } = parseInput(ChangePassword, input);
  const userId = personOf(principal, 'change your password');
  const [user] = await deps().db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new DomainError('not_found', 'User not found');
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw new DomainError('invalid', 'Your current password is not right');
  }
  const hash = await hashPassword(checkPassword(next, user.email));
  await tx('change_password', async (db) => {
    const own = await ownAccount(db, principal);
    await db.update(users).set({ passwordHash: hash }).where(eq(users.id, userId));
    await revokeSessions(db, userId, 'password_changed', hashToken(sessionToken));
    await recordControl(db, own.tenantId, actorOf(principal), {
      type: 'password_changed',
      payload: userFacts(own),
    });
  });
  return { ok: true };
}

/** Every session has ended by its `expiresAt`, whether it was revoked, went idle or ran its course. */
export async function purgeEndedSessions(db: Tx, now: Date): Promise<number> {
  const gone = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now.getTime() - SESSION_RETENTION_MS)))
    .returning({ idHash: sessions.idHash });
  return gone.length;
}
