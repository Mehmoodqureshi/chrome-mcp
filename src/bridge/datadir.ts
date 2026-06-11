/**
 * src/bridge/datadir.ts — the Electron-free data dir (the LinkedIn repo resolved
 * this via `app.getPath`; we use `$CHROME_MCP_DATA` || `~/.chrome-mcp`). Holds
 * the 0600 handshake and, later, the CDP-fallback profile.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDataDir } from '../config';

/** Create (if needed) and return the data dir, 0700 so only the user can read it. */
export function ensureDataDir(dir?: string): string {
  const d = dir ?? resolveDataDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

export function handshakePath(dir: string): string {
  return join(dir, 'handshake.json');
}
