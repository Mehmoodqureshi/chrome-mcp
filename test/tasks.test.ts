/**
 * Per-profile workspace verification — the layout written by ensureWorkspace,
 * the one-time legacy migration, and the list/gc helpers over it.
 *   A. ensureWorkspace: dir layout, meta.json, createdAt preserved on resume.
 *   B. migrateLegacyLayout: moves the flat layout, idempotent, never clobbers.
 *   C. listTasks: empty-safe, cross-profile, newest-first, size + file counts.
 *   D. gcTasks: age + keep selection, profile scope, dry-run, unbounded guard.
 *   E. sanitizeName: traversal/separators rejected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorkspace, migrateLegacyLayout } from '../src/bridge/datadir';
import { gcTasks, listTasks } from '../src/bridge/tasks';
import { resolveTaskDir, sanitizeName } from '../src/config';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'chrome-mcp-tasks-'));
}

const DAY = 86_400_000;
function isoDaysAgo(now: number, days: number): string {
  return new Date(now - days * DAY).toISOString();
}

// --- A. ensureWorkspace -----------------------------------------------------

test('ensureWorkspace creates the profile/task/downloads tree and a meta.json', () => {
  const root = tmp();
  const ws = ensureWorkspace(root, 'work', 'audit', { version: '9.9.9', createdAt: 'T0' });
  assert.equal(ws.dataDir, root);
  assert.equal(ws.profileDir, join(root, 'profiles', 'work'));
  assert.equal(ws.taskDir, join(root, 'profiles', 'work', 'tasks', 'audit'));
  assert.ok(existsSync(ws.downloadDir), 'downloads dir exists');
  assert.ok(existsSync(ws.resultsDir), 'results dir exists');
  assert.ok(existsSync(ws.screenshotsDir), 'screenshots dir exists');
  const meta = JSON.parse(readFileSync(join(ws.taskDir, 'meta.json'), 'utf8'));
  assert.equal(meta.profile, 'work');
  assert.equal(meta.task, 'audit');
  assert.equal(meta.version, '9.9.9');
});

test('ensureWorkspace preserves the original createdAt across a resume', () => {
  const root = tmp();
  ensureWorkspace(root, 'work', 'audit', { createdAt: 'FIRST' });
  const ws = ensureWorkspace(root, 'work', 'audit', { createdAt: 'SECOND' });
  const meta = JSON.parse(readFileSync(join(ws.taskDir, 'meta.json'), 'utf8'));
  assert.equal(meta.createdAt, 'FIRST');
});

// --- B. migrateLegacyLayout -------------------------------------------------

test('migrateLegacyLayout moves the flat cdp-profile and downloads into default', () => {
  const root = tmp();
  mkdirSync(join(root, 'cdp-profile'), { recursive: true });
  mkdirSync(join(root, 'downloads'), { recursive: true });
  writeFileSync(join(root, 'cdp-profile', 'Cookies'), 'secret');
  writeFileSync(join(root, 'downloads', 'report.pdf'), 'pdf');

  const moved = migrateLegacyLayout(root);
  assert.equal(moved.length, 2);
  assert.ok(existsSync(join(root, 'profiles', 'default', 'cdp-profile', 'Cookies')));
  assert.ok(existsSync(join(resolveTaskDir(root, 'default', 'default'), 'downloads', 'report.pdf')));
  assert.ok(!existsSync(join(root, 'cdp-profile')), 'legacy profile dir is gone');
  assert.ok(!existsSync(join(root, 'downloads')), 'legacy downloads dir is gone');
});

test('migrateLegacyLayout is idempotent and never clobbers an existing target', () => {
  const root = tmp();
  // A target already populated: ensureWorkspace made profiles/default/.../downloads.
  ensureWorkspace(root, 'default', 'default', { createdAt: 'T0' });
  mkdirSync(join(root, 'downloads'), { recursive: true });
  writeFileSync(join(root, 'downloads', 'new.pdf'), 'x');

  const moved = migrateLegacyLayout(root);
  assert.equal(moved.length, 0, 'no move when the target already exists');
  assert.ok(existsSync(join(root, 'downloads', 'new.pdf')), 'legacy dir left intact');
});

// --- C. listTasks -----------------------------------------------------------

test('listTasks returns [] for a data dir with no workspaces', () => {
  assert.deepEqual(listTasks(tmp()), []);
});

test('listTasks reports tasks across profiles, newest first, with sizes', () => {
  const root = tmp();
  const now = Date.parse('2026-06-27T00:00:00Z');
  ensureWorkspace(root, 'work', 'old', { createdAt: isoDaysAgo(now, 10) });
  ensureWorkspace(root, 'work', 'new', { createdAt: isoDaysAgo(now, 1) });
  ensureWorkspace(root, 'default', 'scratch', { createdAt: isoDaysAgo(now, 5) });
  writeFileSync(join(resolveTaskDir(root, 'work', 'old'), 'downloads', 'a.bin'), 'x'.repeat(100));

  const tasks = listTasks(root);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.task), ['new', 'scratch', 'old']); // newest → oldest
  const old = tasks.find((t) => t.task === 'old')!;
  assert.equal(old.downloads, 1);
  assert.ok(old.bytes >= 100, 'size includes the download');
});

// --- D. gcTasks -------------------------------------------------------------

test('gcTasks removes only tasks older than the cutoff', () => {
  const root = tmp();
  const now = Date.parse('2026-06-27T00:00:00Z');
  ensureWorkspace(root, 'work', 'old', { createdAt: isoDaysAgo(now, 10) });
  ensureWorkspace(root, 'work', 'fresh', { createdAt: isoDaysAgo(now, 1) });

  const res = gcTasks(root, { olderThanDays: 5 }, now);
  assert.deepEqual(res.removed.map((t) => t.task), ['old']);
  assert.ok(!existsSync(join(root, 'profiles', 'work', 'tasks', 'old')));
  assert.ok(existsSync(join(root, 'profiles', 'work', 'tasks', 'fresh')));
});

test('gcTasks --keep protects the newest N regardless of age', () => {
  const root = tmp();
  const now = Date.parse('2026-06-27T00:00:00Z');
  ensureWorkspace(root, 'work', 'oldest', { createdAt: isoDaysAgo(now, 30) });
  ensureWorkspace(root, 'work', 'mid', { createdAt: isoDaysAgo(now, 20) });
  ensureWorkspace(root, 'work', 'newest', { createdAt: isoDaysAgo(now, 10) });

  const res = gcTasks(root, { olderThanDays: 1, keep: 1 }, now);
  assert.deepEqual(res.removed.map((t) => t.task).sort(), ['mid', 'oldest']);
  assert.ok(existsSync(join(root, 'profiles', 'work', 'tasks', 'newest')));
});

test('gcTasks --profile scopes deletion to one profile', () => {
  const root = tmp();
  const now = Date.parse('2026-06-27T00:00:00Z');
  ensureWorkspace(root, 'work', 'old', { createdAt: isoDaysAgo(now, 10) });
  ensureWorkspace(root, 'other', 'old', { createdAt: isoDaysAgo(now, 10) });

  const res = gcTasks(root, { olderThanDays: 5, profile: 'work' }, now);
  assert.deepEqual(res.removed.map((t) => t.profile), ['work']);
  assert.ok(existsSync(join(root, 'profiles', 'other', 'tasks', 'old')), 'other profile untouched');
});

test('gcTasks dry-run reports but deletes nothing', () => {
  const root = tmp();
  const now = Date.parse('2026-06-27T00:00:00Z');
  ensureWorkspace(root, 'work', 'old', { createdAt: isoDaysAgo(now, 10) });

  const res = gcTasks(root, { olderThanDays: 5, dryRun: true }, now);
  assert.equal(res.removed.length, 1);
  assert.ok(existsSync(join(root, 'profiles', 'work', 'tasks', 'old')), 'still on disk after dry-run');
});

test('gcTasks refuses an unbounded sweep with neither criterion', () => {
  assert.throws(() => gcTasks(tmp(), {}, Date.now()), /requires olderThanDays or keep/);
});

// --- E. sanitizeName --------------------------------------------------------

test('sanitizeName rejects traversal and strips separators', () => {
  assert.throws(() => sanitizeName('..', 'profile'), /invalid profile/);
  assert.throws(() => sanitizeName('   ', 'task'), /invalid task/);
  assert.equal(sanitizeName('a/b\\c', 'task'), 'a-b-c');
  assert.equal(sanitizeName('..hidden', 'profile'), 'hidden');
});
