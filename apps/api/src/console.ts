import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * The operator console is the React app in `apps/console`, built to its `dist` folder and read once
 * at start. Everything comes from this origin, so the policy allows no inline code and nothing from
 * elsewhere. During development, `pnpm dev:console` serves it with live reload instead.
 */
const ROOT = new URL('../../console/dist/', import.meta.url).pathname;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function readTree(dir: string, prefix = ''): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return readTree(join(dir, entry.name), `${path}/`);
    return TYPES[extname(entry.name)] ? [[path, readFileSync(join(dir, entry.name), 'utf8')]] : [];
  });
}

/** Only files that exist at start are ever served, so a path can never reach outside the folder. */
const FILES = new Map(existsSync(ROOT) ? readTree(ROOT) : []);

const NOT_BUILT =
  '<!doctype html><title>novate</title><p>The console has not been built. Run <code>pnpm build:console</code> and restart the server, or <code>pnpm dev:console</code> to work on it.</p>';

export function consoleFile(path: string): Response | undefined {
  const name = path === '' ? 'index.html' : path;
  const body = FILES.get(name) ?? (name === 'index.html' ? NOT_BUILT : undefined);
  if (body === undefined) return undefined;
  return new Response(body, {
    headers: {
      'content-type': TYPES[extname(name)] as string,
      'content-security-policy': CONSOLE_CSP,
      // Built assets have content hashes in their names, so they never change under one name.
      'cache-control': name.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    },
  });
}
