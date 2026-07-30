/**
 * Phase 0 verification — the security policy is the real exfil firewall, so it
 * gets the first tests: default-deny, read-gating, glob matching, the capability
 * gates (eval / downloads / mutations), and the single-source-of-truth invariant
 * for the wire constants.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  DEFAULT_POLICY,
  resolvePolicy,
  assertUrlAllowed,
  isDomainAllowed,
  isMutatingMethod,
  hostOf,
  type Policy,
} from '../src/security/policy';
import { ExecutorError } from '../src/executor/types';
import { PROTOCOL_VERSION, DEFAULT_WS_PORT, WIRE_METHODS } from '../shared/protocol';
import { parseArgs } from '../src/config';
import { dispatchToolCall, resetRateLimiter } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';

function denied(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof ExecutorError && e.code === 'POLICY_DENIED';
  }
}

const permissive: Policy = resolvePolicy({
  allowDomains: ['example.com', '*.wikipedia.org'],
  enableMutations: true,
});

test('default policy denies everything', () => {
  const p = resolvePolicy();
  assert.deepEqual(p.allowDomains, []);
  assert.equal(p.allowEval, false);
  assert.equal(p.allowDownloads, false);
  assert.equal(p.enableMutations, false);
  // A read against any domain is denied under the safe default.
  assert.ok(denied(() => assertUrlAllowed('https://example.com/', 'get_text', p)));
});

test('reads are gated (reads are the exfil payload)', () => {
  // example.com allowed, evil.com not — even for a pure read.
  assert.ok(!denied(() => assertUrlAllowed('https://example.com/page', 'get_text', permissive)));
  assert.ok(denied(() => assertUrlAllowed('https://evil.com/page', 'get_text', permissive)));
  assert.ok(denied(() => assertUrlAllowed('https://evil.com/page', 'screenshot', permissive)));
});

test('glob domain matching: bare, wildcard subdomain, and star', () => {
  assert.ok(isDomainAllowed('https://example.com/x', permissive));
  assert.ok(!isDomainAllowed('https://sub.example.com/x', permissive)); // bare host != subdomain
  assert.ok(isDomainAllowed('https://en.wikipedia.org/wiki/X', permissive)); // *.wikipedia.org
  assert.ok(isDomainAllowed('https://wikipedia.org/X', permissive)); // *.foo also matches apex
  const star = resolvePolicy({ allowDomains: ['*'], enableMutations: true });
  assert.ok(isDomainAllowed('https://anything.example/', star));
});

test('allowlist entries pasted as URLs / host:port / paths still match the bare host', () => {
  // A user who pastes a full URL, a host:port, or a host/path into --allow-domain
  // still gets a working entry — we normalize each pattern down to its bare host.
  const pasted = resolvePolicy({
    allowDomains: ['https://example.com/app', 'sub.test:8443', 'foo.example/path?q=1'],
  });
  assert.ok(isDomainAllowed('https://example.com/other', pasted)); // scheme + path stripped
  assert.ok(isDomainAllowed('https://sub.test/x', pasted)); // port stripped
  assert.ok(isDomainAllowed('https://foo.example/y', pasted)); // path + query stripped
  assert.ok(!isDomainAllowed('https://evil.test/x', pasted)); // unrelated host still denied

  // The wildcard subdomain form survives a scheme prefix too.
  const scheme = resolvePolicy({ allowDomains: ['https://*.wikipedia.org'] });
  assert.ok(isDomainAllowed('https://en.wikipedia.org/wiki/X', scheme));
  assert.ok(isDomainAllowed('https://wikipedia.org/X', scheme));
  assert.ok(!isDomainAllowed('https://example.com/X', scheme));
});

test('mutations are gated by safe-mode independently of domain', () => {
  const safeButAllowed = resolvePolicy({ allowDomains: ['example.com'] }); // enableMutations false
  assert.ok(denied(() => assertUrlAllowed('https://example.com/', 'click', safeButAllowed)));
  // With mutations on, the allowlisted click is permitted.
  assert.ok(!denied(() => assertUrlAllowed('https://example.com/', 'click', permissive)));
  // But a click on a non-allowlisted domain is still denied (URL gate).
  assert.ok(denied(() => assertUrlAllowed('https://evil.com/', 'click', permissive)));
});

test('eval and downloads have their own capability gates', () => {
  // permissive has enableMutations but NOT allowEval / allowDownloads.
  assert.ok(denied(() => assertUrlAllowed('https://example.com/', 'eval', permissive)));
  assert.ok(denied(() => assertUrlAllowed('https://example.com/', 'download_file', permissive)));
  const full = resolvePolicy({
    allowDomains: ['example.com'],
    enableMutations: true,
    allowEval: true,
    allowDownloads: true,
  });
  assert.ok(!denied(() => assertUrlAllowed('https://example.com/', 'eval', full)));
  assert.ok(!denied(() => assertUrlAllowed('https://example.com/', 'download_file', full)));
});

test('navigating to about:blank is always allowed', () => {
  assert.ok(!denied(() => assertUrlAllowed('about:blank', 'navigate', permissive)));
});

test('isMutatingMethod classifies the mutating set', () => {
  for (const m of ['click', 'type', 'navigate', 'tab_close'] as const) {
    assert.ok(isMutatingMethod(m), `${m} should be mutating`);
  }
  for (const m of ['get_text', 'tabs_list', 'screenshot'] as const) {
    assert.ok(!isMutatingMethod(m), `${m} should not be mutating`);
  }
});

test('hostOf is defensive against non-URLs', () => {
  assert.equal(hostOf('https://Example.com/x'), 'example.com');
  assert.equal(hostOf('about:blank'), '');
  assert.equal(hostOf('not a url'), '');
});

// --- the gate never evaluates against a fabricated URL ----------------------

// The gate tests install a process-global manager with a deliberately wide-open
// policy; leaving it standing would hand the next test file an allow-* executor.
after(() => resetManagerForTesting());

function configure(stub: StubOptions): StubExecutor {
  resetManagerForTesting();
  resetRateLimiter();
  const ex = new StubExecutor(stub);
  configureManager({
    // Deliberately wide open: if the gate fell back to a placeholder URL it would
    // PASS here, and the read would run against an origin we never confirmed.
    policy: resolvePolicy({ allowDomains: ['*'], enableMutations: true }),
    makeExecutor: () => ex,
  });
  return ex;
}
const textOf = (r: CallToolResult): string => {
  const b = r.content.find((c) => c.type === 'text');
  return b && b.type === 'text' ? b.text : '';
};
/** Every text block joined — batch returns a summary block plus one per op. */
const allText = (r: CallToolResult): string =>
  r.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n');

test('a tabs_list failure surfaces as the bridge error, not a gate verdict', async () => {
  configure({ tabsListThrows: true });
  const r = await dispatchToolCall('get_text', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /cannot resolve the target tab URL for the policy gate/i);
  assert.match(textOf(r), /stub bridge is down/i); // underlying cause preserved
});

test('the gate reports no open tabs rather than assuming a URL', async () => {
  configure({ noTabs: true });
  const r = await dispatchToolCall('get_text', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no open tabs/i);
});

test('the gate still resolves the active tab URL when tabs_list works', async () => {
  configure({ activeUrl: 'https://example.com/page' });
  const r = await dispatchToolCall('get_text', {});
  assert.notEqual(r.isError, true);
});

test('the failure keeps its executor code, so a caller can tell retryable from denied', async () => {
  configure({ tabsListThrows: true });
  const r = await dispatchToolCall('get_text', {});
  assert.match(textOf(r), /^\[EXTENSION_DISCONNECTED\]/);
  assert.doesNotMatch(textOf(r), /POLICY_DENIED/);
});

test('a tab that reports no URL is named as such, not blocked as an origin', async () => {
  configure({ blankTabUrl: true });
  const r = await dispatchToolCall('get_text', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /reports no URL/i);
  // The old shape: '' fell through and the allowlist denied a nameless host.
  assert.doesNotMatch(textOf(r), /isn't on this browser tool's allowed-sites list/i);
});

// --- the gate costs no round-trip when the backend already knows the URL ------

test('a reported URL is gated against without asking for the tab list', async () => {
  const ex = configure({ cachedUrl: 'https://example.com/page', activeUrl: 'https://example.com/page' });
  const r = await dispatchToolCall('get_text', {});
  assert.notEqual(r.isError, true);
  assert.equal(ex.tabsListCalls, 0); // the whole point: one round-trip, not two
});

test('a reported URL is still a real URL — the policy applies to it', async () => {
  resetManagerForTesting();
  resetRateLimiter();
  const ex = new StubExecutor({ cachedUrl: 'https://evil.test/p', activeUrl: 'https://evil.test/p' });
  configureManager({
    policy: resolvePolicy({ allowDomains: ['example.com'] }),
    makeExecutor: () => ex,
  });
  const r = await dispatchToolCall('get_text', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /evil\.test/);
  assert.equal(ex.tabsListCalls, 0);
});

// --- the gate authorizes the tab the call TARGETS, not whichever is active ----

/** Allow only example.com, park an allowlisted page as the active tab, and hang a
 *  non-allowlisted tab in the background for an explicit tabId to point at. */
function twoTabs(opts: { cachedUrl?: string } = {}): StubExecutor {
  resetManagerForTesting();
  resetRateLimiter();
  const ex = new StubExecutor({
    activeUrl: 'https://example.com/allowed',
    backgroundTabs: [{ tabId: 'extension:stub:2', url: 'https://evil.test/secrets' }],
    ...opts,
  });
  configureManager({
    policy: resolvePolicy({ allowDomains: ['example.com'], enableMutations: true, allowEval: true }),
    makeExecutor: () => ex,
  });
  return ex;
}

test('an explicit tabId is gated against THAT tab, not the active one', async () => {
  twoTabs();
  // The bypass this closes: with an allowlisted tab active, a tabId-addressed read
  // of a non-allowlisted tab used to be authorized against the active tab's origin.
  const r = await dispatchToolCall('get_text', { tabId: 'extension:stub:2' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /evil\.test/);
});

test('every tabId-addressed gated tool authorizes the targeted tab', async () => {
  for (const [tool, args] of [
    ['get_text', {}],
    ['get_html', {}],
    ['screenshot', {}],
    ['snapshot', {}],
    ['get_cookies', {}],
    ['read_as_markdown', {}],
    ['extract_links', {}],
    ['eval', { expression: '1+1' }],
    ['click', { selector: '#x' }],
    ['type', { selector: '#x', text: 'hi' }],
    ['storage', { op: 'get', key: 'k' }],
    ['wait_for', { selector: '#x' }],
  ] as const) {
    twoTabs();
    const r = await dispatchToolCall(tool, { ...args, tabId: 'extension:stub:2' });
    assert.equal(r.isError, true, `${tool} must not be authorized against the active tab`);
    assert.match(textOf(r), /evil\.test/, `${tool} should be denied on the targeted tab's origin`);
  }
});

test('the active tab is still gated normally when no tabId is given', async () => {
  twoTabs();
  const r = await dispatchToolCall('get_text', {});
  assert.notEqual(r.isError, true);
});

test('an explicit tabId bypasses the reported-URL cache', async () => {
  // The cache only ever describes the active tab, so trusting it for an explicit
  // tabId would reintroduce the bypass by a side door.
  const ex = twoTabs({ cachedUrl: 'https://example.com/allowed' });
  const r = await dispatchToolCall('get_text', { tabId: 'extension:stub:2' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /evil\.test/);
  assert.equal(ex.tabsListCalls, 1); // it asked, instead of believing the cache
});

test('an unknown tabId is named, not quietly gated against another tab', async () => {
  twoTabs();
  const r = await dispatchToolCall('get_text', { tabId: 'extension:stub:404' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no open tab has id extension:stub:404/i);
  assert.doesNotMatch(textOf(r), /allowed-sites list/i); // not a policy verdict
});

test('a parallel batch op is gated against its own target tab', async () => {
  // The amplifier: a parallel batch REQUIRES an explicit tabId on every tab-scoped
  // op, so driving several tabs at once — the feature's whole purpose — was exactly
  // the path where every op got authorized against whichever tab was active.
  twoTabs();
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'get_text', args: { tabId: 'extension:stub:1' } },
      { tool: 'get_text', args: { tabId: 'extension:stub:2' } },
    ],
  });
  // The allowlisted tab succeeds, the non-allowlisted one is denied. Before the fix
  // both were authorized against the active tab, so this read ok: 2.
  const summary = JSON.parse(textOf(r)) as { batch: { ok: number; error: number } };
  assert.equal(summary.batch.ok, 1);
  assert.equal(summary.batch.error, 1);
  // The denial names the origin it was actually evaluated against.
  assert.match(allText(r), /evil\.test/);
});

test('tabs open but none active does not fall back to an arbitrary tab', async () => {
  resetManagerForTesting();
  resetRateLimiter();
  const ex = new StubExecutor({ activeUrl: 'https://evil.test/p', noActiveTab: true });
  configureManager({
    policy: resolvePolicy({ allowDomains: ['example.com'] }),
    makeExecutor: () => ex,
  });
  const r = await dispatchToolCall('get_text', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /none active/i);
});

test('tools whose verdict needs no URL never touch the tab list', async () => {
  // tab_new is the recovery move when the tab list is unreadable; making it wait
  // on that list is what bricked it.
  const ex = configure({ tabsListThrows: true });
  const r = await dispatchToolCall('tab_new', { url: 'https://example.com' });
  assert.notEqual(r.isError, true);
  assert.equal(ex.tabsListCalls, 0);
});

test('wire constants are sane and singular', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(DEFAULT_WS_PORT, 38017);
  // No accidental duplicates in the method list (the one source of truth).
  assert.equal(new Set(WIRE_METHODS).size, WIRE_METHODS.length);
});

test('parseArgs: safe defaults and flag overrides', () => {
  const def = parseArgs([]);
  assert.equal(def.wsPort, DEFAULT_WS_PORT);
  assert.equal(def.cdpFallback, false); // extension-only by default: never launches a browser
  assert.equal(def.persistToken, false);
  assert.equal(def.policy.enableMutations, false);
  assert.equal(def.policy.allowEval, false);

  const loud = parseArgs(['--unsafe-all-domains', '--enable-mutations', '--port', '40000']);
  assert.deepEqual(loud.policy.allowDomains, ['*']);
  assert.equal(loud.policy.enableMutations, true);
  assert.equal(loud.wsPort, 40000);

  // Extension-only build: the CDP flags are accepted for back-compat but ignored —
  // cdpFallback stays false regardless.
  assert.equal(parseArgs(['--cdp-fallback']).cdpFallback, false);
  assert.equal(parseArgs(['--no-cdp-fallback']).cdpFallback, false);

  // The "your Chrome, every time, no re-pair" combo.
  const pinned = parseArgs(['--persist-token']);
  assert.equal(pinned.cdpFallback, false);
  assert.equal(pinned.persistToken, true);

  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

void DEFAULT_POLICY; // referenced to keep the import meaningful across refactors
