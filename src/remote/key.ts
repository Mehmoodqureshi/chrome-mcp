/**
 * src/remote/key.ts — the secret that guards remote (HTTP) access.
 *
 * Anyone holding it can drive the user's signed-in Chrome, so it is 32 random
 * bytes, kept in `<dataDir>/remote-key` (mode 0600), and never logged except in
 * the one connector URL printed for the person who started the server.
 * `--rotate-remote-key` replaces it, which cuts off every client at once.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY_FILE = 'remote-key';
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function remoteKeyPath(dataDir: string): string {
  return join(dataDir, KEY_FILE);
}

/** The stored key, or a fresh one when there is none, it is malformed, or `rotate` is set. */
export function resolveRemoteKey(dataDir: string, opts: { rotate?: boolean } = {}): string {
  const path = remoteKeyPath(dataDir);
  if (!opts.rotate && existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (KEY_SHAPE.test(stored)) return stored;
  }
  const key = randomBytes(32).toString('base64url');
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // a file that already existed keeps its old mode otherwise
  return key;
}

/** Constant-time comparison, so response timing reveals nothing about the key. */
export function keyMatches(given: string | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}
