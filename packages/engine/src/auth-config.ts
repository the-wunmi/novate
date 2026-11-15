import { z } from 'zod';

export const INVITE_DELIVERIES = ['inviter', 'notification'] as const;
/**
 * How invite links reach people. `inviter`: the link is returned to whoever invited, who passes it
 * on, and the record says so. `notification`: the link goes out as a `user_invite` notification to
 * the invitee's email and the inviter never sees it, so nobody can accept an invite meant for
 * someone else.
 */
export type InviteDelivery = (typeof INVITE_DELIVERIES)[number];

export const AuthSettings = z.object({
  /** Encrypts secrets at rest, such as authenticator keys: 32 bytes, as 64 hex characters or base64. */
  secretKey: z
    .string()
    .trim()
    .transform((text, ctx) => {
      const key = /^[0-9a-f]{64}$/i.test(text)
        ? Buffer.from(text, 'hex')
        : Buffer.from(text, 'base64');
      if (key.length !== 32) {
        ctx.addIssue({ code: 'custom', message: 'must be 32 bytes, as hex or base64' });
        return z.NEVER;
      }
      return key;
    }),
  /** Where people reach the console. Invite links point here. */
  publicUrl: z
    .string()
    .url()
    .transform((url) => url.replace(/\/+$/, '')),
  inviteDelivery: z.enum(INVITE_DELIVERIES).default('inviter'),
});
export type AuthConfig = z.output<typeof AuthSettings>;

let current: AuthConfig | undefined;

/** Set once by `launchEngine`, or by a tool that invites people without running the engine. */
export function configureAuth(input: z.input<typeof AuthSettings>): void {
  const parsed = AuthSettings.safeParse(input);
  if (!parsed.success) throw new Error(`Account settings: ${z.prettifyError(parsed.error)}`);
  current = parsed.data;
}

export function authConfig(): AuthConfig {
  if (!current)
    throw new Error('Accounts are not configured: launch the engine or call configureAuth');
  return current;
}
