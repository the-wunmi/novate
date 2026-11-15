import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  type ScryptOptions,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { authConfig } from './auth-config.ts';

// ── Passwords ──────────────────────────────────────────────────────────────

/** scrypt cost. Stored with each hash, so raising it later leaves older hashes readable. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

function derive(password: string, salt: Buffer, opts: ScryptOptions & { keylen: number }) {
  const { keylen, ...params } = opts;
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password.normalize('NFKC'),
      salt,
      keylen,
      { ...params, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

/** `scrypt$N$r$p$salt$hash`, with its own salt and the parameters it was made with. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/** A hash nobody's password matches, so a missing account costs the same time as a wrong password. */
let decoy: Promise<string> | undefined;

/**
 * Whether `password` matches `stored`. With no stored hash it still does the work and says no, so
 * the time taken does not reveal whether the account exists or has a password.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  const hash = stored ?? (await decoy);
  const [scheme, n, r, p, salt, key] = hash.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    keylen: expected.length,
  });
  return stored !== null && timingSafeEqual(actual, expected);
}

// ── Tokens ─────────────────────────────────────────────────────────────────

/** 32 random bytes, for a session or an invite. Only its hash is ever stored. */
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// ── TOTP (RFC 6238: SHA-1, 30 seconds, 6 digits) ───────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD_SECONDS = 30;

/** A fresh secret: 20 bytes, the length RFC 4226 recommends for SHA-1, in base32. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

/** The code for one 30-second step. */
export function totpAt(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/**
 * The step `code` belongs to, if it is valid within one step either side of `at`, else null. The
 * caller refuses a step it has already accepted, so a code cannot be used twice.
 */
export function matchTotp(secretBase32: string, code: string, at: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(at);
  let found: number | null = null;
  // Every candidate is checked, so the time taken does not depend on which one matched.
  for (const step of [now - 1, now, now + 1]) {
    if (timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code))) found = step;
  }
  return found;
}

export const otpauthUrl = (secret: string, account: string, issuer = 'novate') =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?${new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(TOTP_PERIOD_SECONDS),
  })}`;

// ── Secrets at rest (AES-256-GCM, under the configured secret key) ─────────

const secretKey = () => authConfig().secretKey;

/** `v1.iv.tag.ciphertext`, each base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function decryptSecret(sealed: string): string {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unreadable secret');
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(body, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
