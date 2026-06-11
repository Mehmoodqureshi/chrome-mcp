/**
 * Phase 1 verification — the tool dispatch spine, exercised against the Stub
 * executor with no Chrome. Proves: catalog/handler drift parity, exactly-one-of
 * target validation, McpToolError → isError, screenshot → image block,
 * eval-throw → {ok:false} (NOT a tool error), safe-mode blocks eval + mutations,
 * and the domain policy denies cross-domain reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  assertNoDrift,
  dispatchToolCall,
} from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';

function configure(policy: Partial<Policy>, stub: StubOptions = {}): void {
  resetManagerForTesting();
  configureManager({ policy: resolvePolicy(policy), makeExecutor: () => new StubExecutor(stub) });
}

/** The first text block's text, or '' for an image-only result. */
function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

const OPEN: Partial<Policy> = { allowDomains: ['*'], enableMutations: true, allowEval: true, allowDownloads: true };

test('catalog and handlers do not drift', () => {
  assert.doesNotThrow(assertNoDrift);
  assert.equal(TOOL_DEFINITIONS.length, Object.keys(TOOL_HANDLERS).length);
});

test('requireTarget enforces exactly-one-of selector|ref', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });

  const none = await dispatchToolCall('click', {});
  assert.equal(none.isError, true);
  assert.match(textOf(none), /exactly one of/i);

  const both = await dispatchToolCall('click', { selector: '#a', ref: 'el_1' });
  assert.equal(both.isError, true);

  const okOne = await dispatchToolCall('click', { selector: '#a' });
  assert.notEqual(okOne.isError, true);
});

test('McpToolError renders as an isError result, never throws', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('navigate', {}); // missing required "url"
  assert.equal(r.isError, true);
  assert.match(textOf(r), /"url" is required/);
});

test('unknown tool is a clean isError', async () => {
  configure(OPEN);
  const r = await dispatchToolCall('does_not_exist', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /unknown tool/);
});

test('screenshot returns an image content block', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('screenshot', {});
  assert.notEqual(r.isError, true);
  assert.equal(r.content[0].type, 'image');
});

test('eval page-throw is {ok:false}, not a tool error', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('eval', { expression: 'throw new Error("x")' });
  assert.notEqual(r.isError, true); // the TOOL succeeded
  const parsed = JSON.parse(textOf(r)) as { ok: boolean };
  assert.equal(parsed.ok, false); // the page eval failed
});

test('safe-mode (default policy) blocks eval and mutations', async () => {
  configure({ allowDomains: ['*'] }, { activeUrl: 'https://example.com' }); // mutations + eval OFF
  const ev = await dispatchToolCall('eval', { expression: '1+1' });
  assert.equal(ev.isError, true);
  assert.match(textOf(ev), /eval is disabled/i);

  const click = await dispatchToolCall('click', { selector: '#a' });
  assert.equal(click.isError, true);
  assert.match(textOf(click), /disabled \(safe-mode\)/i);
});

test('domain policy denies cross-domain reads', async () => {
  configure({ allowDomains: ['example.com'] }, { activeUrl: 'https://evil.com' });
  const r = await dispatchToolCall('get_text', {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not in the domain allowlist/i);

  // ...and allows an allowlisted read.
  configure({ allowDomains: ['example.com'] }, { activeUrl: 'https://example.com' });
  const ok = await dispatchToolCall('get_text', {});
  assert.notEqual(ok.isError, true);
});

test('a read tool (tabs_list) works with no policy grant (management, not content)', async () => {
  configure({}, { activeUrl: 'https://anything.test' });
  const r = await dispatchToolCall('tabs_list', {});
  assert.notEqual(r.isError, true);
});
