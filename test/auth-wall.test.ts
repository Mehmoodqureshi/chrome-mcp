/**
 * Auth-wall detection — the pure decision and its tool surface.
 *
 * Proves: a real login form is `high`; an identity-provider host is `high`
 * regardless of content; an ordinary page with a header "Sign in" link is NOT
 * a wall; a lone password field is only `medium`; `auth_check` reports the
 * verdict; `failOnAuthWall` turns a high-confidence wall into [AUTH_REQUIRED]
 * on auth_check, snapshot, and navigate, and never fires on medium.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { detectAuthWall } from '../shared/auth-wall';
import { dispatchToolCall } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import type { SnapshotNode } from '../src/executor/types';

const OPEN: Partial<Policy> = { allowDomains: ['*'], enableMutations: true, allowEval: true };

function configure(stub: StubOptions = {}): void {
  resetManagerForTesting();
  configureManager({ policy: resolvePolicy(OPEN), makeExecutor: () => new StubExecutor(stub) });
}

function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}
function jsonOf(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(r)) as Record<string, unknown>;
}

const n = (role: string, name: string, tag = role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', extra: Partial<SnapshotNode> = {}): SnapshotNode =>
  ({ ref: 'e', role, name, tag, ...extra });

const LOGIN_FORM: SnapshotNode[] = [
  n('textbox', 'Email'),
  n('textbox', 'Password', 'input', { secret: true }),
  n('checkbox', 'Remember me'),
  n('button', 'Sign in'),
  n('link', 'Forgot password?'),
];

const ORDINARY_PAGE: SnapshotNode[] = [
  n('link', 'Home'),
  n('link', 'Pricing'),
  n('link', 'Sign in'),
  n('button', 'Get started'),
  n('textbox', 'Search'),
];

// --- pure detector -----------------------------------------------------------

test('a login form on a neutral URL is a high-confidence wall', () => {
  const w = detectAuthWall({ url: 'https://app.example.com/', title: 'Example', nodes: LOGIN_FORM });
  assert.ok(w);
  assert.equal(w.confidence, 'high');
  assert.ok(w.signals.includes('password-field'));
  assert.ok(w.signals.includes('login-button'));
  assert.ok(w.signals.includes('username-field'));
});

test('an ordinary page with a header Sign in link is not a wall', () => {
  const w = detectAuthWall({ url: 'https://example.com/pricing', title: 'Pricing - Example', nodes: ORDINARY_PAGE });
  assert.equal(w, null);
});

test('a title mention alone is not a wall', () => {
  const w = detectAuthWall({ url: 'https://example.com/help', title: 'How to sign in - Help', nodes: ORDINARY_PAGE });
  assert.equal(w, null);
});

test('an identity-provider host is high even with an empty snapshot', () => {
  for (const url of [
    'https://accounts.google.com/v3/signin/identifier?flowName=x',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    'https://acme.okta.com/',
    'https://github.com/login?return_to=%2Fsettings',
  ]) {
    const w = detectAuthWall({ url, title: '', nodes: [] });
    assert.ok(w, url);
    assert.equal(w.confidence, 'high', url);
    assert.ok(w.signals.includes('identity-provider'), url);
  }
});

test('github.com itself is not treated as an identity provider', () => {
  const w = detectAuthWall({ url: 'https://github.com/Mehmoodqureshi/chrome-mcp', title: 'chrome-mcp', nodes: ORDINARY_PAGE });
  assert.equal(w, null);
});

test('a sign-in URL with a matching title is high', () => {
  const w = detectAuthWall({ url: 'https://example.com/users/sign_in', title: 'Sign in · Example', nodes: [n('button', 'Continue')] });
  assert.ok(w);
  assert.equal(w.confidence, 'high');
  assert.deepEqual(w.signals.filter((s) => s === 'login-url' || s === 'login-title'), ['login-url', 'login-title']);
});

test('a lone password field is only medium (a settings page, not a wall)', () => {
  const w = detectAuthWall({
    url: 'https://example.com/settings/security',
    title: 'Security settings',
    nodes: [n('textbox', 'Current password', 'input', { secret: true }), n('button', 'Save changes')],
  });
  assert.ok(w);
  assert.equal(w.confidence, 'medium');
});

test('a sign-in URL with nothing to corroborate it is only medium', () => {
  const w = detectAuthWall({ url: 'https://example.com/auth/callback', title: 'Loading…', nodes: [] });
  assert.ok(w);
  assert.equal(w.confidence, 'medium');
});

test('a garbage URL never throws', () => {
  assert.equal(detectAuthWall({ url: 'not a url', title: '', nodes: ORDINARY_PAGE }), null);
  assert.equal(detectAuthWall({ url: 'about:blank', title: '', nodes: [] }), null);
});

test('session-expired interstitials with a password field are high', () => {
  const w = detectAuthWall({
    url: 'https://app.example.com/dashboard',
    title: 'Your session has expired',
    nodes: [n('textbox', 'Password', 'input', { secret: true }), n('button', 'Continue')],
  });
  assert.ok(w);
  assert.equal(w.confidence, 'high');
  assert.ok(w.signals.includes('login-title'));
});

// --- tool surface --------------------------------------------------------------

test('auth_check reports a wall without failing by default', async () => {
  configure({ activeUrl: 'https://app.example.com/', snapshotNodes: LOGIN_FORM });
  const r = await dispatchToolCall('auth_check', {});
  assert.notEqual(r.isError, true);
  const j = jsonOf(r);
  assert.equal(j.authRequired, true);
  assert.equal(j.confidence, 'high');
});

test('auth_check on an ordinary page says authRequired:false with no confidence field', async () => {
  configure({ activeUrl: 'https://example.com/pricing', snapshotNodes: ORDINARY_PAGE });
  const j = jsonOf(await dispatchToolCall('auth_check', {}));
  assert.equal(j.authRequired, false);
  assert.equal('confidence' in j, false);
});

test('auth_check with failOnAuthWall fails as [AUTH_REQUIRED]', async () => {
  configure({ activeUrl: 'https://app.example.com/', snapshotNodes: LOGIN_FORM });
  const r = await dispatchToolCall('auth_check', { failOnAuthWall: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[AUTH_REQUIRED\]/);
  assert.match(textOf(r), /session has probably expired/);
});

test('snapshot carries authWall and stays a success unless asked to fail', async () => {
  configure({ activeUrl: 'https://app.example.com/', snapshotNodes: LOGIN_FORM });
  const ok = await dispatchToolCall('snapshot', {});
  assert.notEqual(ok.isError, true);
  const wall = jsonOf(ok).authWall as { confidence: string } | undefined;
  assert.ok(wall);
  assert.equal(wall.confidence, 'high');

  const diff = await dispatchToolCall('snapshot', { diff: true });
  assert.ok(jsonOf(diff).authWall);

  const fail = await dispatchToolCall('snapshot', { failOnAuthWall: true });
  assert.equal(fail.isError, true);
  assert.match(textOf(fail), /^\[AUTH_REQUIRED\]/);
});

test('snapshot of an ordinary page has no authWall field', async () => {
  configure({ activeUrl: 'https://example.com/', snapshotNodes: ORDINARY_PAGE });
  const j = jsonOf(await dispatchToolCall('snapshot', {}));
  assert.equal('authWall' in j, false);
});

test('navigate with failOnAuthWall fails when the landing page is a wall', async () => {
  configure({ activeUrl: 'https://app.example.com/', snapshotNodes: LOGIN_FORM });
  const plain = await dispatchToolCall('navigate', { url: 'https://app.example.com/dashboard' });
  assert.notEqual(plain.isError, true);
  assert.equal('authWall' in jsonOf(plain), false); // no extra round-trip unless asked

  const r = await dispatchToolCall('navigate', { url: 'https://app.example.com/dashboard', failOnAuthWall: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[AUTH_REQUIRED\]/);
});

test('failOnAuthWall never fires on a medium-confidence verdict', async () => {
  configure({
    activeUrl: 'https://example.com/settings/security',
    snapshotNodes: [n('textbox', 'Current password', 'input', { secret: true }), n('button', 'Save changes')],
  });
  const r = await dispatchToolCall('auth_check', { failOnAuthWall: true });
  assert.notEqual(r.isError, true);
  const j = jsonOf(r);
  assert.equal(j.authRequired, true);
  assert.equal(j.confidence, 'medium');
});

// --- the guard on actions ---------------------------------------------------------

import { parseArgs } from '../src/config';

/** Configure and keep a handle on the stub so a test can count snapshots. */
function configureWith(stub: StubOptions, policy: Partial<Policy> = OPEN): StubExecutor {
  resetManagerForTesting();
  const ex = new StubExecutor(stub);
  configureManager({ policy: resolvePolicy(policy), makeExecutor: () => ex });
  return ex;
}

const REDIRECTED_TO_LOGIN: StubOptions = {
  activeUrl: 'https://app.example.com/dashboard',
  snapshotNodes: ORDINARY_PAGE,
  afterAction: { url: 'https://app.example.com/login?next=%2Fdashboard', nodes: LOGIN_FORM },
};

test('--fail-on-auth-wall is a policy flag, off by default', () => {
  assert.equal(parseArgs([]).policy.failOnAuthWall, false);
  assert.equal(parseArgs(['--fail-on-auth-wall']).policy.failOnAuthWall, true);
  assert.equal(resolvePolicy({}).failOnAuthWall, false);
});

test('a click that lands on a wall passes silently with the guard off, and costs no snapshot', async () => {
  const ex = configureWith(REDIRECTED_TO_LOGIN);
  const r = await dispatchToolCall('click', { selector: '#save' });
  assert.notEqual(r.isError, true);
  assert.equal(ex.snapshotCalls, 0);
});

test('click { failOnAuthWall } fails with [AUTH_REQUIRED] when the click lands on a wall', async () => {
  configureWith(REDIRECTED_TO_LOGIN);
  const r = await dispatchToolCall('click', { selector: '#save', failOnAuthWall: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[AUTH_REQUIRED\]/);
  assert.match(textOf(r), /app\.example\.com\/login/);
});

test('with --fail-on-auth-wall every plain action is guarded, one snapshot each', async () => {
  const ex = configureWith(REDIRECTED_TO_LOGIN, { ...OPEN, failOnAuthWall: true });
  for (const [tool, args] of [
    ['click', { selector: '#save' }],
    ['type', { selector: '#q', text: 'hello' }],
    ['select_option', { selector: '#s', values: ['a'] }],
    ['press', { key: 'Enter' }],
    ['fill_form', { fields: { '#email': 'a@b.com' }, submitSelector: '#go' }],
    ['back', {}],
    ['forward', {}],
    ['reload', {}],
    ['navigate', { url: 'https://app.example.com/dashboard' }],
  ] as Array<[string, Record<string, unknown>]>) {
    const before = ex.snapshotCalls;
    const r = await dispatchToolCall(tool, args);
    assert.equal(r.isError, true, `${tool} should fail`);
    assert.match(textOf(r), /^\[AUTH_REQUIRED\]/, tool);
    assert.equal(ex.snapshotCalls - before, 1, `${tool} should cost exactly one snapshot`);
  }
});

test('with --fail-on-auth-wall an action that stays on an ordinary page succeeds', async () => {
  configureWith({ activeUrl: 'https://app.example.com/dashboard', snapshotNodes: ORDINARY_PAGE }, { ...OPEN, failOnAuthWall: true });
  const r = await dispatchToolCall('click', { selector: '#save' });
  assert.notEqual(r.isError, true);
  assert.deepEqual(jsonOf(r), { ok: true });
});

test('snapshotAfter plus the guard share one snapshot, and the guard wins', async () => {
  const ex = configureWith(REDIRECTED_TO_LOGIN, { ...OPEN, failOnAuthWall: true });
  const r = await dispatchToolCall('click', { selector: '#save', snapshotAfter: true });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[AUTH_REQUIRED\]/);
  assert.equal(ex.snapshotCalls, 1);
});

test('snapshotAfter without the guard still returns the diff when the page became a wall', async () => {
  configureWith(REDIRECTED_TO_LOGIN);
  const r = await dispatchToolCall('click', { selector: '#save', snapshotAfter: true });
  assert.notEqual(r.isError, true);
  const changed = jsonOf(r).changed as { url: string };
  assert.match(changed.url, /\/login/);
});

test('a medium-confidence landing page never trips the guard', async () => {
  configureWith(
    {
      activeUrl: 'https://app.example.com/',
      snapshotNodes: ORDINARY_PAGE,
      afterAction: { url: 'https://app.example.com/settings/security', nodes: [n('textbox', 'Current password', 'input', { secret: true }), n('button', 'Save changes')] },
    },
    { ...OPEN, failOnAuthWall: true },
  );
  const r = await dispatchToolCall('click', { selector: '#security' });
  assert.notEqual(r.isError, true);
});

test('wait_for that times out on a wall is reclassified as [AUTH_REQUIRED] with the guard on', async () => {
  configureWith({ activeUrl: 'https://app.example.com/login', snapshotNodes: LOGIN_FORM, waitForTimesOut: true }, { ...OPEN, failOnAuthWall: true });
  const r = await dispatchToolCall('wait_for', { selector: '#dashboard', timeoutMs: 10 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[AUTH_REQUIRED\]/);
});

test('wait_for that times out on an ordinary page stays [TIMEOUT]', async () => {
  configureWith({ activeUrl: 'https://app.example.com/slow', snapshotNodes: ORDINARY_PAGE, waitForTimesOut: true }, { ...OPEN, failOnAuthWall: true });
  const r = await dispatchToolCall('wait_for', { selector: '#late', timeoutMs: 10 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[TIMEOUT\]/);
});

test('wait_for that times out on a wall stays [TIMEOUT] with the guard off', async () => {
  const ex = configureWith({ activeUrl: 'https://app.example.com/login', snapshotNodes: LOGIN_FORM, waitForTimesOut: true });
  const r = await dispatchToolCall('wait_for', { selector: '#dashboard', timeoutMs: 10 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^\[TIMEOUT\]/);
  assert.equal(ex.snapshotCalls, 0);
});

test('a guarded action that hits a wall is recorded as a failure in the action log', async () => {
  configureWith(REDIRECTED_TO_LOGIN, { ...OPEN, failOnAuthWall: true });
  const r = await dispatchToolCall('press', { key: 'Enter' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /AUTH_REQUIRED/);
});
