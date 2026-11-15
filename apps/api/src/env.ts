import type { AuthSettings, InviteDelivery } from '@novate/engine';
import type { z } from 'zod';

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} (${hint})`);
  return value;
}

export const databasesFromEnv = () => ({
  databaseUrl: required('DATABASE_URL', 'the app database'),
  systemDatabaseUrl: required('DBOS_SYSTEM_DATABASE_URL', 'the DBOS system database'),
});

/** How people's accounts work on this server, for `launchEngine` or `configureAuth`. */
export const authFromEnv = (port: number | string): z.input<typeof AuthSettings> => ({
  secretKey: required('NOVATE_SECRET_KEY', '32 random bytes: openssl rand -base64 32'),
  publicUrl: process.env.NOVATE_PUBLIC_URL?.trim() || `http://localhost:${port}`,
  inviteDelivery: (process.env.NOVATE_INVITE_DELIVERY?.trim() || undefined) as
    | InviteDelivery
    | undefined,
});
