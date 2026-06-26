/**
 * src/bridge/workspace.ts — the *active* task workspace (mutable, process-global)
 * plus the memory writers that persist a task's artifacts into it.
 *
 * Modeled on the executor singleton in `executor/manager.ts`: the boot path
 * installs an initial workspace, and the runtime tools (`profile_use`/`task_new`)
 * swap it via {@link switchWorkspace}. Tool handlers reach the current workspace
 * through {@link getActiveWorkspace} so downloads, extracted results, screenshots,
 * and the action log all land under `profiles/<profile>/tasks/<task>/`.
 *
 * Every writer here is BEST-EFFORT: a failed persist (full disk, races a task
 * switch) is logged to stderr and swallowed so it can never break a tool call.
 */

import { appendFileSync, copyFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { sanitizeName } from '../config';
import { MAX_DOWNLOAD_BYTES, sanitizeDownloadName } from '../../shared/download';
import { ensureWorkspace, type Workspace } from './datadir';

/** stderr only (never stdout in stdio mode); local to avoid an import cycle with mcp/server. */
function logErr(message: string): void {
  process.stderr.write(`[chrome-mcp] ${message}\n`);
}

let active: Workspace | null = null;
/** Monotonic counter so saved result/screenshot filenames sort in capture order. */
let seq = 0;

/** Install the initial workspace at boot (from cli.ts). */
export function setActiveWorkspace(w: Workspace): void {
  active = w;
}

/** The current workspace. Throws if the boot path never installed one. */
export function getActiveWorkspace(): Workspace {
  if (!active) throw new Error('no active workspace (server not fully booted)');
  return active;
}

/** The current workspace, or null before boot completes (for non-throwing callers). */
export function peekActiveWorkspace(): Workspace | null {
  return active;
}

/** Reset for tests. */
export function resetActiveWorkspaceForTesting(): void {
  active = null;
  seq = 0;
}

/**
 * Switch the active profile and/or task, creating the workspace dirs if new, and
 * make it current. Names are sanitized to a single safe path segment (reusing
 * {@link sanitizeName}) so a tool argument can never escape the data dir. Returns
 * the resolved workspace.
 */
export function switchWorkspace(opts: { profile?: string; task?: string; meta?: Record<string, unknown> }): Workspace {
  const cur = getActiveWorkspace();
  const profile = opts.profile === undefined ? cur.profile : sanitizeName(opts.profile, 'profile');
  // A profile switch resets the task to "default" unless the caller names one.
  const task =
    opts.task !== undefined
      ? sanitizeName(opts.task, 'task')
      : opts.profile !== undefined
        ? 'default'
        : cur.task;
  const w = ensureWorkspace(cur.dataDir, profile, task, {
    ...opts.meta,
    createdAt: new Date().toISOString(),
  });
  active = w;
  return w;
}

// ---------------------------------------------------------------------------
// Memory writers — persist a task's artifacts under its workspace.
// ---------------------------------------------------------------------------

/** A short safe stem like `0007-get_text`; the seq keeps capture order + uniqueness. */
function stem(tool: string): string {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return `${n}-${tool.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * Save an extracted-content result (get_text / read_as_markdown / extract_links)
 * into the active task's `results/`. `ext` is the file extension without a dot.
 * Returns the path written, or null if persisted nowhere (no workspace / error).
 */
export function saveResult(tool: string, ext: string, body: string): string | null {
  const w = peekActiveWorkspace();
  if (!w) return null;
  try {
    const path = join(w.resultsDir, `${stem(tool)}.${ext}`);
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  } catch (err) {
    logErr(`results save failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Save a screenshot PNG (base64) into the active task's `screenshots/`. */
export function saveScreenshot(dataBase64: string): string | null {
  const w = peekActiveWorkspace();
  if (!w) return null;
  try {
    const path = join(w.screenshotsDir, `${stem('screenshot')}.png`);
    writeFileSync(path, Buffer.from(dataBase64, 'base64'), { mode: 0o600 });
    return path;
  } catch (err) {
    logErr(`screenshot save failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Move a file Chrome saved to the user's Downloads dir into the active task's
 * `downloads/`. The name is re-hardened via {@link sanitizeDownloadName} and the
 * size is capped at {@link MAX_DOWNLOAD_BYTES} (over-cap files are left where they
 * are and rejected). Falls back to copy+unlink when source and destination are on
 * different filesystems (rename's `EXDEV`). Returns the final path and byte size.
 */
export function captureDownload(sourcePath: string, suggestedName?: string): { path: string; bytes: number } {
  const w = getActiveWorkspace();
  const bytes = statSync(sourcePath).size;
  if (bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`download exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap (left at ${sourcePath})`);
  }
  const name = sanitizeDownloadName(suggestedName ?? basename(sourcePath));
  const dest = join(w.downloadDir, name);
  try {
    renameSync(sourcePath, dest);
  } catch {
    copyFileSync(sourcePath, dest);
    try {
      unlinkSync(sourcePath);
    } catch {
      /* best effort: a left-behind source is harmless */
    }
  }
  return { path: dest, bytes: statSync(dest).size };
}

/** Append one action record to the active task's `history.jsonl`. */
export function appendHistory(entry: Record<string, unknown>): void {
  const w = peekActiveWorkspace();
  if (!w) return;
  try {
    appendFileSync(w.historyPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    logErr(`history append failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
