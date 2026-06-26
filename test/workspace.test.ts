/**
 * Active-workspace verification — the mutable singleton the runtime tools drive,
 * plus the memory writers that persist a task's artifacts into it.
 *   A. switchWorkspace: profile/task switching, profile-switch resets the task.
 *   B. memory writers: saveResult / saveScreenshot / appendHistory land on disk.
 *   C. captureDownload: relocates a file into the active task's downloads/.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureWorkspace } from '../src/bridge/datadir';
import {
  appendHistory,
  captureDownload,
  getActiveWorkspace,
  resetActiveWorkspaceForTesting,
  saveResult,
  saveScreenshot,
  setActiveWorkspace,
  switchWorkspace,
} from '../src/bridge/workspace';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'chrome-mcp-ws-'));
}

/** Install a fresh active workspace rooted at a new temp data dir; return its root. */
function boot(profile = 'default', task = 'default'): string {
  const root = tmp();
  resetActiveWorkspaceForTesting();
  setActiveWorkspace(ensureWorkspace(root, profile, task, { createdAt: 'T0' }));
  return root;
}

beforeEach(() => resetActiveWorkspaceForTesting());

// --- A. switchWorkspace -----------------------------------------------------

test('getActiveWorkspace throws before boot installs one', () => {
  resetActiveWorkspaceForTesting();
  assert.throws(() => getActiveWorkspace(), /no active workspace/);
});

test('switchWorkspace task swap keeps the profile and creates the task dir', () => {
  const root = boot('mehmood', 'default');
  const ws = switchWorkspace({ task: 'linkedin-scrape' });
  assert.equal(ws.profile, 'mehmood');
  assert.equal(ws.task, 'linkedin-scrape');
  assert.equal(ws.taskDir, join(root, 'profiles', 'mehmood', 'tasks', 'linkedin-scrape'));
  assert.ok(existsSync(ws.downloadDir) && existsSync(ws.resultsDir) && existsSync(ws.screenshotsDir));
  assert.equal(getActiveWorkspace().task, 'linkedin-scrape', 'becomes active');
});

test('switchWorkspace profile swap resets the task to default', () => {
  boot('mehmood', 'linkedin-scrape');
  const ws = switchWorkspace({ profile: 'muhammad' });
  assert.equal(ws.profile, 'muhammad');
  assert.equal(ws.task, 'default', 'a bare profile switch resets the task');
});

test('switchWorkspace sanitizes names (no traversal)', () => {
  boot();
  // '/' → '-' and the leading dots are stripped, so the segment can't escape.
  const ws = switchWorkspace({ profile: '../evil' });
  assert.equal(ws.profile, '-evil');
  assert.ok(!ws.profileDir.includes('..'), 'no traversal survives');
});

// --- B. memory writers ------------------------------------------------------

test('saveResult writes into the active task results/ dir', () => {
  boot();
  const p = saveResult('get_text', 'json', '{"hello":"world"}');
  assert.ok(p && existsSync(p), 'a results file is written');
  assert.equal(readFileSync(p!, 'utf8'), '{"hello":"world"}');
  assert.match(p!, /results[/\\]\d{4}-get_text\.json$/);
});

test('saveScreenshot decodes base64 into a png under screenshots/', () => {
  boot();
  const png = Buffer.from('not-really-a-png').toString('base64');
  const p = saveScreenshot(png);
  assert.ok(p && existsSync(p));
  assert.match(p!, /screenshots[/\\]\d{4}-screenshot\.png$/);
  assert.equal(readFileSync(p!).toString(), 'not-really-a-png');
});

test('appendHistory appends one json line per call', () => {
  boot();
  appendHistory({ tool: 'navigate', ok: true });
  appendHistory({ tool: 'click', ok: false });
  const lines = readFileSync(getActiveWorkspace().historyPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).tool, 'navigate');
  assert.equal(JSON.parse(lines[1]).ok, false);
});

test('memory writers no-op (return null) when no workspace is active', () => {
  resetActiveWorkspaceForTesting();
  assert.equal(saveResult('get_text', 'json', '{}'), null);
  assert.equal(saveScreenshot('AAAA'), null);
  assert.doesNotThrow(() => appendHistory({ tool: 'x', ok: true }));
});

// --- C. captureDownload -----------------------------------------------------

test('captureDownload moves a file into the active task downloads/', () => {
  boot('mehmood', 'wpos-audit');
  const src = join(tmp(), 'report.pdf');
  writeFileSync(src, 'pdf-bytes');
  const { path, bytes } = captureDownload(src, 'report.pdf');
  assert.equal(path, join(getActiveWorkspace().downloadDir, 'report.pdf'));
  assert.ok(existsSync(path) && !existsSync(src), 'moved, not copied');
  assert.equal(bytes, 'pdf-bytes'.length);
  assert.deepEqual(readdirSync(getActiveWorkspace().downloadDir), ['report.pdf']);
});

test('captureDownload re-hardens a dangerous suggested name', () => {
  boot();
  const src = join(tmp(), 'x');
  writeFileSync(src, 'x');
  const { path } = captureDownload(src, 'evil.exe');
  assert.match(path, /evil\.download$/);
});
