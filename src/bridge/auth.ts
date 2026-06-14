/**
 * src/bridge/auth.ts — the ONE auth model (every other variant in the design
 * drafts was deleted on purpose).
 *
 *   - Fresh 256-bit token EVERY boot by default, never persisted across restarts.
 *     Persistence is OPT-IN (`--persist-token` / `CHROME_MCP_TOKEN`) for hosts
 *     that want a stable token so the extension never has to re-pair.
 *   - Written atomically (tmp + rename) to `handshake.json` at mode 0600; the
 *     mode is re-verified after write and we FAIL CLOSED if it can't be set.
 *   - Compared by hashing both sides to SHA-256 and `timingSafeEqual`-ing the
 *     digests — no length precondition, no length leak.
 *   - The token is NEVER written to stdout/stderr or any log (a test asserts it).
 */

import {
  chmodSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { PROTOCOL_VERSION, type HandshakeFile } from '../../shared/protocol';
import { handshakePath } from './datadir';

/** A fresh 256-bit token, base64url. Generated once per server boot. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Path of the optional persisted-token file (only used when persistence is on). */
export function tokenPath(dir: string): string {
  return join(dir, 'token');
}

/**
 * Read the persisted token (trimmed) if present and non-empty; else null.
 * FAILS CLOSED if the file is group/other-readable — same trust boundary as the
 * handshake, so a loose permission is a hard error rather than a silent reuse.
 */
export function readPersistedToken(dir: string): string | null {
  const path = tokenPath(dir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `persisted token ${path} is group/other-accessible (mode ${mode.toString(8)}); refusing to reuse it`,
    );
  }
  const token = raw.trim();
  return token.length > 0 ? token : null;
}

/** Atomically write the persisted token at 0600 and verify the mode (fail closed). */
export function writePersistedToken(dir: string, token: string): string {
  const path = tokenPath(dir);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, token, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `persisted token ${path} is group/other-accessible (mode ${mode.toString(8)}); refusing to expose it`,
    );
  }
  return path;
}

/**
 * Resolve the token for this boot:
 *   1. `CHROME_MCP_TOKEN` env — an explicit pin; used verbatim, never written to disk.
 *   2. `persist` on — reuse the on-disk token (creating + saving one on first run),
 *      so the extension stays paired across restarts.
 *   3. otherwise — a fresh per-boot token (the secure default; never persisted).
 */
export function resolveToken(dir: string, opts: { persist: boolean }): string {
  const fromEnv = process.env.CHROME_MCP_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (opts.persist) {
    const existing = readPersistedToken(dir);
    if (existing) return existing;
    const fresh = generateToken();
    writePersistedToken(dir, fresh);
    return fresh;
  }
  return generateToken();
}

/** Constant-time token compare via fixed-length SHA-256 digests. */
export function tokensMatch(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export interface WriteHandshakeFields {
  port: number;
  token: string;
  expectedExtensionId?: string;
}

/**
 * Atomically write the handshake at 0600 and verify the mode. Throws (fail
 * closed) if the file ends up group/other-readable — the token is the entire
 * trust boundary, so a loose permission is a hard error, not a warning.
 */
export function writeHandshake(dir: string, fields: WriteHandshakeFields): string {
  const path = handshakePath(dir);
  const tmp = `${path}.tmp.${process.pid}`;

  const payload: HandshakeFile = {
    v: PROTOCOL_VERSION,
    port: fields.port,
    token: fields.token,
    pid: process.pid,
    ts: Date.now(),
    expectedExtensionId: fields.expectedExtensionId,
  };

  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);

  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `handshake file ${path} is group/other-accessible (mode ${mode.toString(8)}); refusing to expose the token`,
    );
  }
  return path;
}

export function readHandshake(dir: string): HandshakeFile {
  return JSON.parse(readFileSync(handshakePath(dir), 'utf8')) as HandshakeFile;
}

/** Best-effort removal (kill switch / clean shutdown). */
export function removeHandshake(dir: string): void {
  try {
    unlinkSync(handshakePath(dir));
  } catch {
    /* already gone */
  }
}

/** Redact a token for any human-facing string (defense against accidental logs). */
export function redactToken(s: string, token: string): string {
  return token ? s.split(token).join('«redacted»') : s;
}
