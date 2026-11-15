import { describe, expect, it } from 'vitest';
import { configureAuth } from '../src/auth-config.ts';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashPassword,
  matchTotp,
  totpAt,
  verifyPassword,
} from '../src/auth-crypto.ts';
import { testAuth } from './harness.ts';

// RFC 6238, appendix B: the SHA-1 seed, and the 8-digit codes it gives at these times.
const SEED = Buffer.from('12345678901234567890');
const VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, code] of VECTORS) {
      expect(totpAt(SEED, Math.floor(seconds / 30), 8)).toBe(code);
      // Six digits are the last six of the same number.
      expect(totpAt(SEED, Math.floor(seconds / 30))).toBe(code.slice(2));
    }
  });

  it('accepts one step either side and nothing further, and says which step matched', () => {
    const secret = base32Encode(SEED);
    expect(base32Decode(secret)).toEqual(SEED);
    const at = new Date(1111111111 * 1000);
    const step = Math.floor(1111111111 / 30);
    for (const offset of [-1, 0, 1]) {
      expect(matchTotp(secret, totpAt(SEED, step + offset), at)).toBe(step + offset);
    }
    expect(matchTotp(secret, totpAt(SEED, step + 2), at)).toBeNull();
    expect(matchTotp(secret, totpAt(SEED, step - 2), at)).toBeNull();
    expect(matchTotp(secret, 'abcdef', at)).toBeNull();
  });
});

describe('passwords', () => {
  it('hashes with a fresh salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });
});

describe('secrets at rest', () => {
  it('refuses a key that is not 32 bytes', () => {
    expect(() => configureAuth({ ...testAuth, secretKey: 'too short' })).toThrow(/32 bytes/);
  });

  it('round-trips and refuses a tampered ciphertext', () => {
    configureAuth(testAuth);
    const sealed = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptSecret(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3] as string, 'base64url');
    body[0] = (body[0] as number) ^ 1;
    parts[3] = body.toString('base64url');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });
});
