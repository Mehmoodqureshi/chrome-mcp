/**
 * Port eviction — reclaiming a pinned port from a stale chrome-mcp.
 *
 * The kill is the dangerous part (a recycled pid could belong to anything), so
 * most of this file pins down when we must REFUSE: no handshake, a handshake for
 * a different port, our own pid, a dead pid, and — the important one — a live pid
 * whose command line isn't chrome-mcp. Plus the happy paths: SIGTERM, and the
 * SIGKILL escalation when the owner ignores it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evictPortOwner, looksLikeChromeMcp, type EvictDeps } from '../src/bridge/evict';
import { writeHandshake } from '../src/bridge/auth';

const PORT = 45_678;
const OWNER = 4_821;

function dirWithHandshake(fields: { port: number; pid: number }): string {
  const dir = mkdtempSync(join(tmpdir(), 'evict-'));
  writeHandshake(dir, { port: fields.port, token: 'tok' });
  // writeHandshake stamps OUR pid; rewrite it to model another session's server.
  const path = join(dir, 'handshake.json');
  const hs = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
  hs.pid = fields.pid;
  writeFileSync(path, JSON.stringify(hs), { mode: 0o600 });
  return dir;
}

/** Deps for a live owner that exits on the Nth liveness poll. */
function ownerDeps(opts: { cmdline?: string | null; diesAfter?: number }): {
  deps: EvictDeps;
  kills: Array<{ pid: number; signal: string }>;
} {
  const kills: Array<{ pid: number; signal: string }> = [];
  let polls = 0;
  const diesAfter = opts.diesAfter ?? 1;
  const deps: EvictDeps = {
    isAlive: () => {
      // Alive until the owner has been signalled and enough polls have elapsed.
      if (kills.length === 0) return true;
      return ++polls < diesAfter;
    },
    commandLine: () => (opts.cmdline === undefined ? '/usr/bin/node /x/chrome-mcp/dist/src/cli.js' : opts.cmdline),
    kill: (pid, signal) => {
      kills.push({ pid, signal });
    },
  };
  return { deps, kills };
}

const noLog = (): void => {};

test('evicts a live chrome-mcp owning the pinned port', async () => {
  const dir = dirWithHandshake({ port: PORT, pid: OWNER });
  const { deps, kills } = ownerDeps({});
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), true);
  assert.deepEqual(kills, [{ pid: OWNER, signal: 'SIGTERM' }]);
});

test('escalates to SIGKILL when the owner ignores SIGTERM', async () => {
  const dir = dirWithHandshake({ port: PORT, pid: OWNER });
  // Never dies from SIGTERM; only the post-SIGKILL check reports it gone.
  const kills: Array<{ pid: number; signal: string }> = [];
  const deps: EvictDeps = {
    isAlive: () => !kills.some((k) => k.signal === 'SIGKILL'),
    commandLine: () => 'node /opt/chrome-mcp/cli.js --port 45678',
    kill: (pid, signal) => kills.push({ pid, signal }),
  };
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), true);
  assert.deepEqual(
    kills.map((k) => k.signal),
    ['SIGTERM', 'SIGKILL'],
  );
});

test('REFUSES to kill a live pid that is not chrome-mcp', async () => {
  const dir = dirWithHandshake({ port: PORT, pid: OWNER });
  const { deps, kills } = ownerDeps({ cmdline: '/usr/bin/postgres -D /var/lib/pg' });
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), false);
  assert.deepEqual(kills, [], 'an unrelated process must never be signalled');
});

test('REFUSES when the command line cannot be read', async () => {
  const dir = dirWithHandshake({ port: PORT, pid: OWNER });
  const { deps, kills } = ownerDeps({ cmdline: null });
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), false);
  assert.deepEqual(kills, [], 'unknown identity must fail closed');
});

test('REFUSES when the handshake names a different port', async () => {
  const dir = dirWithHandshake({ port: PORT + 1, pid: OWNER });
  const { deps, kills } = ownerDeps({});
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), false);
  assert.deepEqual(kills, []);
});

test('REFUSES to kill our own pid', async () => {
  const dir = dirWithHandshake({ port: PORT, pid: process.pid });
  const { deps, kills } = ownerDeps({});
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), false);
  assert.deepEqual(kills, []);
});

test('REFUSES when the recorded owner is already dead', async () => {
  const dir = dirWithHandshake({ port: PORT, pid: OWNER });
  const kills: Array<{ pid: number; signal: string }> = [];
  const deps: EvictDeps = {
    isAlive: () => false,
    commandLine: () => 'node chrome-mcp',
    kill: (pid, signal) => kills.push({ pid, signal }),
  };
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), false);
  assert.deepEqual(kills, [], 'a dead pid needs no signal; the port frees itself');
});

test('returns false when there is no handshake at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evict-empty-'));
  const { deps } = ownerDeps({});
  assert.equal(await evictPortOwner(dir, PORT, noLog, deps), false);
});

test('looksLikeChromeMcp matches real install layouts, not bystanders', () => {
  for (const cmd of [
    '/usr/local/bin/node /Users/x/.npm/_npx/abc/node_modules/@mehmoodqureshi/chrome-mcp/dist/src/cli.js',
    'node /opt/homebrew/lib/node_modules/@mehmoodqureshi/chrome-mcp/dist/src/cli.js --port 9222',
    'C:\\Program Files\\nodejs\\node.exe C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@mehmoodqureshi\\chrome-mcp\\dist\\src\\cli.js',
  ]) {
    assert.equal(looksLikeChromeMcp(cmd), true, cmd);
  }
  for (const cmd of ['/usr/bin/postgres -D /var/lib/pg', 'node server.js', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    assert.equal(looksLikeChromeMcp(cmd), false, cmd);
  }
});
