/**
 * batch fan-out tool — verifies parallel/serial execution, per-op isolation,
 * the parallel explicit-tabId guard (the H2 active-tab race fix), stopOnError,
 * no-nesting, and that every sub-op still passes the policy gate (no bypass).
 * Exercised against the Stub executor, no Chrome.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { dispatchToolCall, resetRateLimiter, TOOL_DEFINITIONS } from '../src/mcp/tools';
import { runBatch } from '../src/mcp/batch';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';

function configure(policy: Partial<Policy>, stub: StubOptions = {}): void {
  resetManagerForTesting();
  resetRateLimiter();
  configureManager({ policy: resolvePolicy(policy), makeExecutor: () => new StubExecutor(stub) });
}

const OPEN: Partial<Policy> = { allowDomains: ['*'], enableMutations: true, allowEval: true, allowDownloads: true };
const TAB = 'extension:stub:1'; // the stub's single tab

function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

/** Every text block joined — per-op messages live in blocks after the summary. */
function allText(r: CallToolResult): string {
  return r.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

interface Summary {
  batch: { mode: string; total: number; ok: number; error: number; skipped: number };
  results: { index: number; tool: string; status: 'ok' | 'error' | 'skipped' }[];
}
function summaryOf(r: CallToolResult): Summary {
  return JSON.parse(textOf(r)) as Summary;
}

test('batch is advertised in the catalog', () => {
  assert.ok(TOOL_DEFINITIONS.some((d) => d.name === 'batch'));
});

test('parallel batch runs every op and reports a summary', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'get_text', args: { tabId: TAB } },
      { tool: 'get_text', args: { tabId: TAB } },
      { tool: 'snapshot', args: { tabId: TAB } },
    ],
  });
  assert.notEqual(r.isError, true);
  const s = summaryOf(r);
  assert.equal(s.batch.mode, 'parallel');
  assert.equal(s.batch.total, 3);
  assert.equal(s.batch.ok, 3);
  // each op's own content is appended after the summary block.
  assert.ok(r.content.some((c) => c.type === 'text' && c.text.includes('--- op 0 (get_text) ok ---')));
});

test('parallel mode requires an explicit tabId on tab-scoped ops (active-tab race guard)', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'get_text', args: {} }, // no tabId -> rejected in parallel
      { tool: 'get_text', args: { tabId: TAB } }, // explicit -> ok
    ],
  });
  const s = summaryOf(r);
  assert.equal(s.results[0].status, 'error');
  assert.equal(s.results[1].status, 'ok');
  assert.match(allText(r), /needs an explicit "tabId"/);
});

test('parallel exemptions: tabs_list / tab_new / chrome_status need no tabId', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'tabs_list', args: {} },
      { tool: 'chrome_status', args: {} },
      { tool: 'tab_new', args: { url: 'https://example.com' } },
    ],
  });
  assert.notEqual(r.isError, true);
  assert.equal(summaryOf(r).batch.ok, 3);
});

test('serial mode allows the active-tab default (omitted tabId is fine when not concurrent)', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', {
    mode: 'serial',
    ops: [{ tool: 'get_text', args: {} }, { tool: 'get_text', args: {} }],
  });
  assert.equal(summaryOf(r).batch.ok, 2);
});

test('serial stopOnError stops after the first failure; the rest are skipped', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', {
    mode: 'serial',
    stopOnError: true,
    ops: [
      { tool: 'navigate', args: {} }, // missing required "url" -> error
      { tool: 'get_text', args: { tabId: TAB } }, // never runs
    ],
  });
  const s = summaryOf(r);
  assert.equal(s.results[0].status, 'error');
  assert.equal(s.results[1].status, 'skipped');
  assert.equal(s.batch.skipped, 1);
});

test('a single op failure is isolated — other ops still succeed (partial success is not isError)', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'get_text', args: { tabId: TAB } }, // ok
      { tool: 'click', args: { tabId: TAB } }, // no selector|ref -> error
    ],
  });
  assert.notEqual(r.isError, true); // batch ran; partial success
  const s = summaryOf(r);
  assert.equal(s.batch.ok, 1);
  assert.equal(s.batch.error, 1);
});

test('every sub-op still passes the policy gate — no bypass', async () => {
  // active tab is evil.com but only example.com is allowed: the read must be denied.
  configure({ allowDomains: ['example.com'] }, { activeUrl: 'https://evil.com' });
  const r = await dispatchToolCall('batch', {
    ops: [{ tool: 'get_text', args: { tabId: TAB } }],
  });
  const s = summaryOf(r);
  assert.equal(s.results[0].status, 'error');
  assert.match(allText(r), /isn't on this browser tool's allowed-sites list/i);
});

test('batch cannot be nested', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', { ops: [{ tool: 'batch', args: { ops: [] } }] });
  assert.equal(r.isError, true); // nothing succeeded
  assert.match(allText(r), /cannot be nested/i);
});

test('unknown sub-tool is a clean per-op error', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const r = await dispatchToolCall('batch', { ops: [{ tool: 'does_not_exist', args: { tabId: TAB } }] });
  assert.equal(summaryOf(r).results[0].status, 'error');
  assert.match(allText(r), /unknown tool/i);
});

test('structural errors fail the whole batch', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });

  const empty = await dispatchToolCall('batch', { ops: [] });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /at least one operation/i);

  const notArray = await dispatchToolCall('batch', { ops: 'nope' });
  assert.equal(notArray.isError, true);
  assert.match(textOf(notArray), /must be an array/i);

  const badOp = await dispatchToolCall('batch', { ops: [{ args: { tabId: TAB } }] }); // no tool
  assert.equal(badOp.isError, true);
  assert.match(textOf(badOp), /\.tool must be a non-empty string/i);
});

test('parallel batch opens new tabs in the background; serial/explicit keep focus', async () => {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const dispatch = async (tool: string, args: unknown): Promise<CallToolResult> => {
    calls.push({ tool, args: args as Record<string, unknown> });
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  const deps = {
    dispatch,
    requiresExplicitTab: (t: string) => !['tab_new', 'tabs_list', 'chrome_status'].includes(t),
  };

  // parallel: active:false is injected so concurrent opens don't fight for focus.
  await runBatch({ ops: [{ tool: 'tab_new', args: { url: 'https://x.test' } }] }, deps);
  assert.equal(calls[0].args.active, false);

  // an explicit active is preserved.
  calls.length = 0;
  await runBatch({ ops: [{ tool: 'tab_new', args: { url: 'https://x.test', active: true } }] }, deps);
  assert.equal(calls[0].args.active, true);

  // serial: left alone (the executor's focus default applies).
  calls.length = 0;
  await runBatch({ mode: 'serial', ops: [{ tool: 'tab_new', args: { url: 'https://x.test' } }] }, deps);
  assert.equal(calls[0].args.active, undefined);
});

test('ops over the max are rejected', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const ops = Array.from({ length: 51 }, () => ({ tool: 'tabs_list', args: {} }));
  const r = await dispatchToolCall('batch', { ops });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /the max is 50/i);
});
