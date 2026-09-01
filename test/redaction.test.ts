/**
 * Secret redaction, snapshot diffing, role+name locators, and the audit fields
 * on the action log.
 *
 * The through-line: this tool reads pages you are logged into. The allowlist
 * decides WHICH pages may be read and says nothing about what comes back from
 * one that is allowed — so a session token in a script tag, or the value in a
 * password field, used to travel straight into the model's context.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { redactHtml, redactText, NO_REDACTION, type RedactionConfig } from '../src/mcp/redact';
import { diffSnapshots, rememberSnapshot, resetSnapshots, lastSnapshot } from '../src/mcp/snapdiff';
import { resolveLocator } from '../src/mcp/locate';
import { dispatchToolCall } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import { parseArgs } from '../src/config';
import { ensureWorkspace } from '../src/bridge/datadir';
import { resetActiveWorkspaceForTesting, setActiveWorkspace, getActiveWorkspace } from '../src/bridge/workspace';
import type { SnapshotNode, SnapshotResult } from '../src/executor/types';

const ON: RedactionConfig = { enabled: true, extra: [] };

function configure(policy: Partial<Policy>, stub: StubOptions = {}): StubExecutor {
  resetManagerForTesting();
  const ex = new StubExecutor(stub);
  configureManager({ policy: resolvePolicy(policy), makeExecutor: () => ex });
  return ex;
}

function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

const OPEN: Partial<Policy> = { allowDomains: ['*'], enableMutations: true, allowEval: true };

beforeEach(() => resetSnapshots());

// ---------------------------------------------------------------------------
// A. Redaction
// ---------------------------------------------------------------------------

test('a password field value never survives a get_html read', () => {
  const html = '<form><input type="password" name="pw" value="hunter2"><input type="text" value="alice"></form>';
  // No flag: password suppression is unconditional, because no caller wants it.
  const out = redactHtml(html, NO_REDACTION);
  assert.equal(out.value.includes('hunter2'), false);
  assert.match(out.value, /value="\[redacted:password\]"/);
  assert.match(out.value, /value="alice"/, 'ordinary field values are untouched');
  assert.equal(out.redactions, 1);
});

test('pattern redaction catches the common secret shapes', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const body = [
    `token=${jwt}`,
    'aws=AKIAIOSFODNN7EXAMPLE',
    'gh=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'header: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'ordinary prose that mentions a bearer of good news',
  ].join('\n');

  const off = redactText(body, NO_REDACTION);
  assert.equal(off.redactions, 0, 'pattern redaction is opt-in');

  const on = redactText(body, ON);
  assert.equal(on.value.includes(jwt), false);
  assert.equal(on.value.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(on.value.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'), false);
  assert.match(on.value, /\[redacted:jwt\]/);
  assert.match(on.value, /bearer of good news/, 'prose is not collateral damage');
  assert.equal(on.redactions >= 4, true);
});

test('a custom pattern is applied alongside the builtins', () => {
  const cfg: RedactionConfig = { enabled: true, extra: [/EMP-\d{6}/g] };
  const out = redactText('employee EMP-123456 signed in', cfg);
  assert.match(out.value, /\[redacted:custom\]/);
  assert.equal(out.redactions, 1);
});

test('get_html scrubs password values through the tool surface, and reports it', async () => {
  configure(
    { ...OPEN, redact: true },
    {
      activeUrl: 'https://example.com',
      htmlPayload: '<input type="password" value="hunter2"><span>AKIAIOSFODNN7EXAMPLE</span>',
    },
  );
  const body = JSON.parse(textOf(await dispatchToolCall('get_html', {}))) as { html: string; redactions: number };
  assert.equal(body.html.includes('hunter2'), false);
  assert.equal(body.html.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(body.redactions, 2);
});

test('redaction happens BEFORE the output cap, so truncation cannot leak', async () => {
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  configure(
    { ...OPEN, redact: true },
    { activeUrl: 'https://example.com', textPayload: `${secret} ${'x'.repeat(5000)}` },
  );
  const body = JSON.parse(textOf(await dispatchToolCall('get_text', { maxBytes: 1024 }))) as { text: string };
  assert.equal(body.text.includes(secret), false);
  assert.match(body.text, /\[redacted:aws-key\]/);
});

test('--redact-pattern implies --redact, and a broken pattern fails at startup', () => {
  const cfg = parseArgs(['--redact-pattern', 'EMP-\\d+']);
  assert.equal(cfg.policy.redact, true);
  assert.deepEqual(cfg.policy.redactPatterns, ['EMP-\\d+']);
  assert.equal(parseArgs([]).policy.redact, false);
  assert.throws(() => parseArgs(['--redact-pattern', '(unclosed']), /not a valid regular expression/);
});

// ---------------------------------------------------------------------------
// B. Snapshot diffing
// ---------------------------------------------------------------------------

const snap = (nodes: SnapshotNode[]): SnapshotResult => ({
  url: 'https://example.com',
  title: 'T',
  nodes,
  truncated: false,
});

test('a diff reports added, removed and state-changed nodes', () => {
  const before = rememberSnapshot('s', snap([
    { ref: 'e1', role: 'button', name: 'Submit', tag: 'button', disabled: true },
    { ref: 'e2', role: 'link', name: 'Home', tag: 'a' },
  ]));
  const after = snap([
    { ref: 'e1', role: 'button', name: 'Submit', tag: 'button' }, // no longer disabled
    { ref: 'e2', role: 'alert', name: 'Saved', tag: 'div' },
  ]);
  const d = diffSnapshots(before, after);
  assert.equal(d.since, before.id);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, 'Saved');
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].name, 'Home');
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].was.disabled, true);
});

test('nodes are matched by role+name, not by ref (refs renumber on every snapshot)', () => {
  // The same button, shifted down by an inserted element, must NOT read as
  // "removed e1, added e2" — that is the whole failure mode of diffing on refs.
  const before = rememberSnapshot('s', snap([{ ref: 'e1', role: 'button', name: 'Submit', tag: 'button' }]));
  const after = snap([
    { ref: 'e1', role: 'heading', name: 'New banner', tag: 'h2' },
    { ref: 'e2', role: 'button', name: 'Submit', tag: 'button' },
  ]);
  const d = diffSnapshots(before, after);
  assert.equal(d.removed.length, 0);
  assert.equal(d.added.length, 1);
  assert.equal(d.unchanged, 1);
});

test('the first snapshot of a tab has nothing to diff against and says so', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const body = JSON.parse(textOf(await dispatchToolCall('snapshot', { diff: true }))) as {
    since: string | null;
    note?: string;
    added: unknown[];
  };
  assert.equal(body.since, null);
  assert.match(body.note ?? '', /no previous snapshot/);
  assert.equal(body.added.length, 1);
});

test('snapshot diff:true returns only the delta on the second call', async () => {
  const ex = configure(OPEN, { activeUrl: 'https://example.com' });
  await dispatchToolCall('snapshot', {});
  ex.snapshotNodes = [
    { ref: 'e1', role: 'link', name: 'Example', tag: 'a' },
    { ref: 'e2', role: 'alert', name: 'Saved', tag: 'div' },
  ];
  const body = JSON.parse(textOf(await dispatchToolCall('snapshot', { diff: true }))) as {
    added: SnapshotNode[];
    unchanged: number;
  };
  assert.equal(body.added.length, 1);
  assert.equal(body.added[0].name, 'Saved');
  assert.equal(body.unchanged, 1);
});

test('snapshotAfter reports what a click changed without a second read', async () => {
  const ex = configure(OPEN, { activeUrl: 'https://example.com' });
  await dispatchToolCall('snapshot', {});
  ex.snapshotNodes = [
    { ref: 'e1', role: 'link', name: 'Example', tag: 'a' },
    { ref: 'e2', role: 'alert', name: 'Could not save', tag: 'div' },
  ];
  const body = JSON.parse(textOf(await dispatchToolCall('click', { selector: '#go', snapshotAfter: true }))) as {
    ok: boolean;
    changed: { added: SnapshotNode[] };
  };
  assert.equal(body.ok, true);
  assert.equal(body.changed.added[0].name, 'Could not save');
});

test('switching profile forgets remembered snapshots (a different browser entirely)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrome-mcp-snap-'));
  resetActiveWorkspaceForTesting();
  setActiveWorkspace(ensureWorkspace(root, 'default', 'default', { createdAt: 'T0' }));
  configure(OPEN, { activeUrl: 'https://example.com' });
  await dispatchToolCall('snapshot', {});
  await dispatchToolCall('profile_use', { name: 'work' });
  assert.equal(lastSnapshot('default | active'), undefined);
  resetActiveWorkspaceForTesting();
});

// ---------------------------------------------------------------------------
// C. Role + name locators
// ---------------------------------------------------------------------------

const PAGE: SnapshotNode[] = [
  { ref: 'e1', role: 'button', name: 'Sign in', tag: 'button' },
  { ref: 'e2', role: 'link', name: 'Sign in with Google', tag: 'a' },
  { ref: 'e3', role: 'button', name: 'Cancel', tag: 'button' },
  { ref: 'e4', role: 'button', name: 'Cancel', tag: 'button' },
];

test('an exact name beats a longer one that merely contains it', async () => {
  const ex = new StubExecutor({ snapshotNodes: PAGE });
  const found = await resolveLocator(ex, { name: 'Sign in' });
  assert.deepEqual(found.target, { ref: 'e1' });
});

test('a role narrows an otherwise ambiguous name', async () => {
  const ex = new StubExecutor({ snapshotNodes: PAGE });
  const found = await resolveLocator(ex, { role: 'link', name: 'Sign in with Google' });
  assert.deepEqual(found.target, { ref: 'e2' });
});

test('a genuinely ambiguous locator fails loudly rather than clicking the first match', async () => {
  const ex = new StubExecutor({ snapshotNodes: PAGE });
  await assert.rejects(() => resolveLocator(ex, { role: 'button', name: 'Cancel' }), /2 elements match/);
  // ...and `nth` is the documented way through it.
  const picked = await resolveLocator(ex, { role: 'button', name: 'Cancel', nth: 1 });
  assert.deepEqual(picked.target, { ref: 'e4' });
});

test('a locator that matches nothing names what IS on the page', async () => {
  const ex = new StubExecutor({ snapshotNodes: PAGE });
  await assert.rejects(() => resolveLocator(ex, { role: 'button', name: 'Delete account' }), /Closest by role/);
});

test('click accepts role+name instead of a selector', async () => {
  configure(OPEN, { activeUrl: 'https://example.com', snapshotNodes: PAGE });
  const res = await dispatchToolCall('click', { role: 'button', name: 'Sign in' });
  assert.equal(res.isError, undefined);
});

test('mixing a selector and a locator is rejected rather than silently preferring one', async () => {
  configure(OPEN, { activeUrl: 'https://example.com', snapshotNodes: PAGE });
  const res = await dispatchToolCall('click', { selector: '#a', role: 'button', name: 'Sign in' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /exactly one of selector \| ref \| role\+name/);
});

// ---------------------------------------------------------------------------
// D. The audit fields on history.jsonl
// ---------------------------------------------------------------------------

test('the action log records the URL touched, the policy verdict, and bytes returned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'chrome-mcp-audit-'));
  resetActiveWorkspaceForTesting();
  setActiveWorkspace(ensureWorkspace(root, 'default', 'default', { createdAt: 'T0' }));
  const historyPath = getActiveWorkspace().historyPath;

  configure({ allowDomains: ['example.com'] }, { activeUrl: 'https://example.com', textPayload: 'hello' });
  await dispatchToolCall('get_text', {});
  // A denial must be recorded as a denial, not merely as a failure.
  configure({ allowDomains: ['other.com'] }, { activeUrl: 'https://example.com' });
  await dispatchToolCall('get_text', {});

  const lines = readFileSync(historyPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const allowed = lines.find((l) => l.policy === 'allowed');
  const denied = lines.find((l) => l.policy === 'denied');
  assert.ok(allowed, 'an allowed call records its target URL and verdict');
  assert.equal(allowed?.url, 'https://example.com');
  assert.equal(allowed?.bytes, 5);
  assert.equal(typeof allowed?.ms, 'number');
  assert.ok(denied, 'a policy denial is recorded as such');
  assert.equal(denied?.ok, false);
  resetActiveWorkspaceForTesting();
});
