/**
 * src/bridge/tasks.ts — listing and garbage-collection over the per-profile
 * task workspaces written by `ensureWorkspace` (datadir.ts).
 *
 * A task is `profiles/<profile>/tasks/<task>/`, carrying a `meta.json` and a
 * `downloads/` bucket. These helpers walk that tree read-only (listTasks) or
 * prune it (gcTasks). `now` is threaded in rather than read from the clock so
 * GC is deterministic under test.
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskInfo {
  profile: string;
  task: string;
  /** Absolute path to `profiles/<profile>/tasks/<task>/`. */
  dir: string;
  /** ISO timestamp from meta.json, falling back to the dir's mtime. */
  createdAt: string;
  /** Total bytes under the task dir (downloads + meta.json; excludes the profile). */
  bytes: number;
  /** File count in `downloads/`. */
  downloads: number;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function dirSize(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += statSync(p).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return total;
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

function readCreatedAt(taskDir: string): string {
  try {
    const meta = JSON.parse(readFileSync(join(taskDir, 'meta.json'), 'utf8')) as { createdAt?: unknown };
    if (typeof meta.createdAt === 'string') return meta.createdAt;
  } catch {
    /* fall through to mtime */
  }
  try {
    return statSync(taskDir).mtime.toISOString();
  } catch {
    return '';
  }
}

/** Enumerate every task across every profile, newest first. */
export function listTasks(dataDir: string): TaskInfo[] {
  const profilesRoot = join(dataDir, 'profiles');
  if (!existsSync(profilesRoot)) return [];
  const out: TaskInfo[] = [];
  for (const profile of subdirs(profilesRoot)) {
    const tasksRoot = join(profilesRoot, profile, 'tasks');
    for (const task of subdirs(tasksRoot)) {
      const dir = join(tasksRoot, task);
      out.push({
        profile,
        task,
        dir,
        createdAt: readCreatedAt(dir),
        bytes: dirSize(dir),
        downloads: countFiles(join(dir, 'downloads')),
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface GcOptions {
  /** Remove tasks created more than this many days ago. */
  olderThanDays?: number;
  /** Always retain the newest N tasks (per scope), regardless of age. */
  keep?: number;
  /** Limit to a single profile; otherwise all profiles. */
  profile?: string;
  /** Compute what would be removed without deleting anything. */
  dryRun?: boolean;
}

export interface GcResult {
  removed: TaskInfo[];
  freedBytes: number;
}

/**
 * Prune task workspaces. A task is removed when it is NOT among the newest
 * `keep` (if set) AND is older than `olderThanDays` (if set). At least one of
 * `keep`/`olderThanDays` must be provided — the caller is responsible for
 * refusing an unbounded sweep. `dryRun` reports the selection without deleting.
 */
export function gcTasks(dataDir: string, opts: GcOptions, now: number): GcResult {
  if (opts.olderThanDays === undefined && opts.keep === undefined) {
    throw new Error('gcTasks requires olderThanDays or keep (refusing to remove every task)');
  }
  const scoped = listTasks(dataDir).filter((t) => !opts.profile || t.profile === opts.profile);
  const protectedDirs = new Set(
    opts.keep === undefined ? [] : scoped.slice(0, opts.keep).map((t) => t.dir),
  );
  const ageCutoffMs = (opts.olderThanDays ?? 0) * 86_400_000;

  const removed = scoped.filter((t) => {
    if (protectedDirs.has(t.dir)) return false;
    if (opts.olderThanDays !== undefined) {
      const created = Date.parse(t.createdAt);
      if (Number.isNaN(created) || now - created <= ageCutoffMs) return false;
    }
    return true;
  });

  if (!opts.dryRun) {
    for (const t of removed) {
      try {
        rmSync(t.dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  return { removed, freedBytes: removed.reduce((sum, t) => sum + t.bytes, 0) };
}
