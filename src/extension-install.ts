/**
 * src/extension-install.ts — put the extension somewhere a human can find.
 *
 * The extension ships inside the npm package, which is the wrong place to send
 * someone with a "Load unpacked" file dialog: a global install buries it five
 * folders deep under `npm root -g`, and an npx run hides it in a cache. So on
 * every boot (and on `--extension-path`) the server mirrors the bundled
 * `extension-dist/` into a plain, visible folder directly under the home
 * directory — `~/chrome-mcp-extension` — and that is the folder the docs, the
 * pairing file, and `--extension-path` all point at.
 *
 * The copy is a one-way mirror of top-level regular files, written only when
 * content differs, so an unchanged boot touches nothing. It never deletes: the
 * target may hold `pairing.json` (ours) and, if the operator pointed
 * CHROME_MCP_EXTENSION_DIR somewhere of their own, files that are not ours to
 * remove. It never throws — a read-only home just falls back to the bundled
 * folder, which still works for Load unpacked.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFileAtomic } from './atomic-file';

/** Folder name under the home directory. */
export const EXTENSION_DIR_NAME = 'chrome-mcp-extension';

/** The auto-pairing file the server writes; never copied, never overwritten by the mirror. */
export const PAIRING_FILE = 'pairing.json';

/** `dist/src/extension-install.js` -> `<pkg>/extension-dist`, which the tarball ships. */
export function bundledExtensionDir(): string {
  return resolve(__dirname, '..', '..', 'extension-dist');
}

/** Where the extension is mirrored for Load unpacked. `CHROME_MCP_EXTENSION_DIR` overrides. */
export function extensionInstallDir(): string {
  const override = process.env.CHROME_MCP_EXTENSION_DIR;
  return override && override.trim() ? resolve(override.trim()) : join(homedir(), EXTENSION_DIR_NAME);
}

export interface SyncResult {
  /** The folder that now holds the extension (the target on success, the source on failure). */
  dir: string;
  /** Files written this run (new or changed). Empty means the target was already current. */
  copied: string[];
  /** True when the target folder did not exist before this run (first install). */
  created: boolean;
  ok: boolean;
  error?: string;
}

type Manifest = Record<string, unknown> & { version: string; key?: string };

function readManifest(path: string): Manifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  if (!value || Array.isArray(value) || typeof value.version !== 'string' ||
      (value.key !== undefined && (typeof value.key !== 'string' || !value.key.trim()))) {
    throw new Error(`invalid extension manifest at ${path}; existing files were not changed`);
  }
  return value;
}

/** Compare dotted versions numerically: >0 when a is newer, <0 when older, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

/**
 * Mirror the bundled extension into the install dir. Returns the folder to
 * point Chrome at either way: the target when the mirror succeeded, the source
 * when it did not (so callers always have a loadable folder).
 */
export function syncExtension(from: string = bundledExtensionDir(), to: string = extensionInstallDir()): SyncResult {
  const copied: string[] = [];
  let created = false;
  try {
    const entries = readdirSync(from, { withFileTypes: true }).filter((e) => e.isFile() && e.name !== PAIRING_FILE);
    if (!entries.some((e) => e.name === 'manifest.json')) {
      return { dir: from, copied, created, ok: false, error: `no manifest.json in ${from}` };
    }
    try {
      statSync(to);
    } catch {
      created = true;
    }
    // Never downgrade: an older server (a session left running for days) must
    // not put its stale build over a newer one another session already wrote.
    const sourceManifest = readManifest(join(from, 'manifest.json'));
    const targetManifestPath = join(to, 'manifest.json');
    const targetManifest = existsSync(targetManifestPath) ? readManifest(targetManifestPath) : null;
    if (targetManifest && compareVersions(targetManifest.version, sourceManifest.version) > 0) {
      return { dir: to, copied, created, ok: true };
    }
    // A manifest key is the extension's identity, not an ordinary update field.
    // Adding a key to an existing keyless install changes its path-derived ID.
    // Chrome retains the old registration, then rejects the shared path on the
    // next startup. Preserve both existing keys AND their absence.
    let manifestBytes = readFileSync(join(from, 'manifest.json'));
    if (targetManifest && targetManifest.key !== sourceManifest.key) {
      const manifest = { ...sourceManifest };
      if (targetManifest.key === undefined) delete manifest.key;
      else manifest.key = targetManifest.key;
      manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    mkdirSync(to, { recursive: true });
    // Publish the manifest/version last so the extension's reload check cannot
    // observe a new version before its background/options files are ready.
    entries.sort((a, b) => Number(a.name === 'manifest.json') - Number(b.name === 'manifest.json'));
    for (const e of entries) {
      const src = e.name === 'manifest.json' ? manifestBytes : readFileSync(join(from, e.name));
      const dst = join(to, e.name);
      let current: Buffer | null = null;
      try {
        if (statSync(dst).isFile()) current = readFileSync(dst);
      } catch {
        /* absent */
      }
      if (current && sameBytes(current, src)) continue;
      writeFileAtomic(dst, src);
      copied.push(e.name);
    }
    return { dir: to, copied, created, ok: true };
  } catch (e) {
    return { dir: from, copied, created, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
