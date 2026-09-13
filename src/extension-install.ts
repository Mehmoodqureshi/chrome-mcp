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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

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
    mkdirSync(to, { recursive: true });
    for (const e of entries) {
      const src = readFileSync(join(from, e.name));
      const dst = join(to, e.name);
      let current: Buffer | null = null;
      try {
        if (statSync(dst).isFile()) current = readFileSync(dst);
      } catch {
        /* absent */
      }
      if (current && sameBytes(current, src)) continue;
      writeFileSync(dst, src);
      copied.push(e.name);
    }
    return { dir: to, copied, created, ok: true };
  } catch (e) {
    return { dir: from, copied, created, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
