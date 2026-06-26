/**
 * src/bridge/datadir.ts — the Electron-free data dir (the LinkedIn repo resolved
 * this via `app.getPath`; we use `$CHROME_MCP_DATA` || `~/.chrome-mcp`). Holds
 * the 0600 handshake and, later, the CDP-fallback profile.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveDataDir, resolveProfileDir, resolveTaskDir } from '../config';

/** Create (if needed) and return the data dir, 0700 so only the user can read it. */
export function ensureDataDir(dir?: string): string {
  const d = dir ?? resolveDataDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function handshakePath(dir: string): string {
  return join(dir, 'handshake.json');
}

/**
 * One-time move of the pre-0.6 flat layout into the `default` profile's
 * workspace: `<dataDir>/cdp-profile` → `profiles/default/cdp-profile` (logins)
 * and `<dataDir>/downloads` → `profiles/default/tasks/default/downloads`.
 *
 * Idempotent and conservative: a leg is migrated only when the legacy dir exists
 * AND its target does not, so it runs at most once and never clobbers a profile
 * the user has already populated. Must be called BEFORE {@link ensureWorkspace},
 * which would otherwise create the (empty) target and block the rename. Returns
 * a human-readable description of each move performed.
 */
export function migrateLegacyLayout(dataDir: string): string[] {
  const moved: string[] = [];
  const legs = [
    { from: join(dataDir, 'cdp-profile'), to: join(resolveProfileDir(dataDir, 'default'), 'cdp-profile') },
    { from: join(dataDir, 'downloads'), to: join(resolveTaskDir(dataDir, 'default', 'default'), 'downloads') },
  ];
  for (const { from, to } of legs) {
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(from, to);
      moved.push(`${from} → ${to}`);
    } catch {
      /* best effort: a failed move leaves the legacy dir untouched and usable */
    }
  }
  return moved;
}

export interface Workspace {
  /** The data dir this workspace lives under — needed to switch profile/task at runtime. */
  dataDir: string;
  profile: string;
  task: string;
  /** `profiles/<profile>/` — passed to the CDP executor as its userDataDir. */
  profileDir: string;
  /** `profiles/<profile>/tasks/<task>/` — per-run artifact root. */
  taskDir: string;
  /** `profiles/<profile>/tasks/<task>/downloads` — captured files for this run. */
  downloadDir: string;
  /** `profiles/<profile>/tasks/<task>/results` — extracted text/markdown/links. */
  resultsDir: string;
  /** `profiles/<profile>/tasks/<task>/screenshots` — PNGs captured during the run. */
  screenshotsDir: string;
  /** `profiles/<profile>/tasks/<task>/history.jsonl` — append-only action log. */
  historyPath: string;
}

/**
 * Create (0700) the profile + task directories and stamp the task with a
 * `meta.json`, returning the resolved paths. The CDP profile (identity: cookies
 * & logins) and the downloads (per-run artifacts) live under here so distinct
 * identities and distinct runs never collide. `createdAt` is preserved across
 * restarts so a resumed task keeps its original timestamp; the meta write is
 * best-effort and never fatal.
 */
export function ensureWorkspace(
  dataDir: string,
  profile: string,
  task: string,
  meta: Record<string, unknown> = {},
): Workspace {
  const profileDir = resolveProfileDir(dataDir, profile);
  const taskDir = resolveTaskDir(dataDir, profile, task);
  const downloadDir = join(taskDir, 'downloads');
  const resultsDir = join(taskDir, 'results');
  const screenshotsDir = join(taskDir, 'screenshots');
  const historyPath = join(taskDir, 'history.jsonl');
  // Create the three artifact buckets up front (0700) so every capture path can
  // assume its directory exists.
  for (const d of [downloadDir, resultsDir, screenshotsDir]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  const metaPath = join(taskDir, 'meta.json');
  try {
    let createdAt: unknown;
    if (existsSync(metaPath)) {
      createdAt = (JSON.parse(readFileSync(metaPath, 'utf8')) as { createdAt?: unknown }).createdAt;
    }
    writeFileSync(
      metaPath,
      JSON.stringify({ ...meta, profile, task, createdAt: createdAt ?? meta.createdAt }, null, 2),
      { mode: 0o600 },
    );
  } catch {
    /* non-fatal: a missing meta.json never blocks the server */
  }

  return { dataDir, profile, task, profileDir, taskDir, downloadDir, resultsDir, screenshotsDir, historyPath };
}
