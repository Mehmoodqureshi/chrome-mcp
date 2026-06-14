/**
 * Phase 0 verification — the security policy is the real exfil firewall, so it
 * gets the first tests: default-deny, read-gating, glob matching, the capability
 * gates (eval / downloads / mutations), and the single-source-of-truth invariant
 * for the wire constants.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

  // Opt back into the CDP fallback explicitly.
  assert.equal(parseArgs(['--cdp-fallback']).cdpFallback, true);
  // --no-cdp-fallback still accepted (now a no-op vs the default).
  assert.equal(parseArgs(['--no-cdp-fallback']).cdpFallback, false);

  // The "your Chrome, every time, no re-pair" combo.
  const pinned = parseArgs(['--persist-token']);
  assert.equal(pinned.cdpFallback, false);
  assert.equal(pinned.persistToken, true);

  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
});

void DEFAULT_POLICY; // referenced to keep the import meaningful across refactors
