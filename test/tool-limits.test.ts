/**
 * FIX 9 + FIX 10 verification — input size limits and per-session rate limiting,
 * exercised through `dispatchToolCall` against the Stub executor (no Chrome).
 * Both must render as clean `isError` results: the dispatch firewall NEVER throws
 * to the transport, even for an over-long selector/text or a flood of calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { dispatchToolCall, resetRateLimiter } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import { MAX_SELECTOR_LEN, MAX_TEXT_LEN } from '../src/mcp/validators';

function configure(policy: Partial<Policy>, stub: StubOptions = {}): void {
  resetManagerForTesting();
  resetRateLimiter();
  configureManager({ policy: resolvePolicy(policy), makeExecutor: () => new StubExecutor(stub) });
}

function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

const OPEN: Partial<Policy> = { allowDomains: ['*'], enableMutations: true, allowEval: true, allowDownloads: true };

test('an over-long selector is a clean isError, not a throw', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const longSel = '.' + 'a'.repeat(MAX_SELECTOR_LEN + 1);
  let r: CallToolResult;
  await assert.doesNotReject(async () => {
    r = await dispatchToolCall('click', { selector: longSel });
  });
  assert.equal(r!.isError, true);
  assert.match(textOf(r!), /selector.*too long/i);
});

test('an over-long type text is a clean isError, not a throw', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const longText = 'x'.repeat(MAX_TEXT_LEN + 1);
  let r: CallToolResult;
  await assert.doesNotReject(async () => {
    r = await dispatchToolCall('type', { selector: '#in', text: longText });
  });
  assert.equal(r!.isError, true);
  assert.match(textOf(r!), /text.*too long/i);
});

test('an over-long fill_form value is a clean isError', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('fill_form', { fields: { '#in': 'x'.repeat(MAX_TEXT_LEN + 1) } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /too long/i);
});

test('a selector at exactly the cap is accepted', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const sel = '.' + 'a'.repeat(MAX_SELECTOR_LEN - 1); // total length == MAX_SELECTOR_LEN
  const r = await dispatchToolCall('click', { selector: sel });
  assert.notEqual(r.isError, true);
});

test('rate limit: exceeding the ceiling returns isError and never throws', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  // RATE_MAX_CALLS is 600; drive well past it. tabs_list is a cheap, always-OK call.
  let sawLimit = false;
  let lastLimitMsg = '';
  for (let i = 0; i < 650; i++) {
    let r: CallToolResult;
    await assert.doesNotReject(async () => {
      r = await dispatchToolCall('tabs_list', {});
    });
    if (r!.isError && /rate limit/i.test(textOf(r!))) {
      sawLimit = true;
      lastLimitMsg = textOf(r!);
    }
  }
  assert.equal(sawLimit, true, 'expected the rate limiter to trip within 650 calls');
  assert.match(lastLimitMsg, /rate limit exceeded/i);
});

test('rate limit resets via resetRateLimiter (so it does not leak across sessions/tests)', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  for (let i = 0; i < 650; i++) await dispatchToolCall('tabs_list', {});
  // Trip confirmed above; now reset and prove a fresh call succeeds.
  resetRateLimiter();
  const r = await dispatchToolCall('tabs_list', {});
  assert.notEqual(r.isError, true);
});
