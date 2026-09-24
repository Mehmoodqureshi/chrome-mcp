/**
 * src/bridge/auth.ts — the ONE auth model (every other variant in the design
 * drafts was deleted on purpose).
 *
 *   - Fresh 256-bit token EVERY boot by default, never persisted across restarts.
 *     Persistence is OPT-IN (`--persist-token` / `CHROME_MCP_TOKEN`) for hosts
 *     that want a stable token so the extension never has to re-pair.
 *   - Written atomically (tmp + rename) to `handshake.json` at mode 0600; the
 *     mode is re-verified after write and we FAIL CLOSED if it can't be set.
 *     POSIX only — Windows has no group/other bits to check (see assertPrivate).
 *   - Compared by hashing both sides to SHA-256 and `timingSafeEqual`-ing the
 *     digests — no length precondition, no length leak.
 *   - The token is NEVER written to stdout/stderr or any log (a test asserts it).
 */

import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect } from 'node:net';

import { PROTOCOL_VERSION, type HandshakeFile } from '../../shared/protocol';
import { handshakePath } from './datadir';

/** A fresh 256-bit token, base64url. Generated once per server boot. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Fail closed if `path` is group/other-accessible.
 *
 * No-op on Windows: NTFS ACLs don't map onto the POSIX mode bits, `chmodSync`
 * there only toggles the read-only attribute, and `statSync` reports a synthetic
 * 0o666 for any writable file. Enforcing the check would therefore throw on
 * every well-formed file. The token's confidentiality on Windows rests on the
 * per-user ACL of the profile directory holding it.
 */
function assertPrivate(path: string, what: string): void {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${what} ${path} is group/other-accessible (mode ${mode.toString(8)}); refusing to expose the token`,
    );
  }
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
  assertPrivate(path, 'persisted token');
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
  assertPrivate(path, 'persisted token');
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

/** Name of the auto-pairing file the server drops into its bundled extension folder. */
export const BUNDLED_PAIRING_FILE = 'pairing.json';

/**
 * Write `<extDir>/pairing.json` so an extension loaded unpacked from that very
 * folder can pair itself: its service worker fetches the file from its own
 * package and adopts the port + token with no Options-page paste. Same secret,
 * same 0600 mode, same trust boundary as the handshake (only this user can read
 * it, and the file is neither web-accessible nor shipped in the npm tarball).
 *
 * Best-effort: returns the path on success, or null when the folder is missing
 * or read-only (a locked-down global install). Never throws — manual pairing
 * still works without it.
 */
export function writeBundledPairing(extDir: string, fields: WriteHandshakeFields): string | null {
  const path = join(extDir, BUNDLED_PAIRING_FILE);
  const tmp = `${path}.tmp.${process.pid}`;
  const payload = { v: PROTOCOL_VERSION, port: fields.port, token: fields.token, ts: Date.now() };
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return path;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    return null;
  }
}

/** The port an existing `<extDir>/pairing.json` points at, or null when absent/unreadable. */
export function readBundledPairingPort(extDir: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(extDir, BUNDLED_PAIRING_FILE), 'utf8')) as { port?: unknown };
    return typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : null;
  } catch {
    return null;
  }
}

/** True when something is accepting TCP connections on 127.0.0.1:`port`. */
export function portIsListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    const done = (live: boolean): void => {
      sock.destroy();
      resolve(live);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Should a hub on `port` leave `<extDir>/pairing.json` alone? Yes when the file
 * already points the extension at a DIFFERENT port that is still live: another
 * chrome-mcp (e.g. one started with its own CHROME_MCP_DATA / --ws-port) owns
 * that pairing, and overwriting it would silently steal the user's extension.
 * A file naming our own port, a dead port, or no file at all is fair game.
 */
export async function bundledPairingHeldByOther(extDir: string, port: number): Promise<boolean> {
  const current = readBundledPairingPort(extDir);
  if (current === null || current === port) return false;
  return portIsListening(current);
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
  assertPrivate(path, 'handshake file');
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
