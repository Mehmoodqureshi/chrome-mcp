/**
 * Output caps on the page-read tools, the batch result budget, and the
 * retry-once-on-EXTENSION_DISCONNECTED path — all exercised through
 * `dispatchToolCall` against the Stub executor (no Chrome).
 *
 * `eval` and `screenshot` were already bounded; get_html / get_text /
 * read_as_markdown were not, so one call on a large page could consume an
 * agent's whole context. A batch multiplies that, so it carries its own budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { dispatchToolCall, resetRateLimiter } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import {
  capHtml,
  capText,
  DEFAULT_MAX_OUTPUT_BYTES,
  MIN_OUTPUT_BYTES,
} from '../src/mcp/limits';
import { getLogLevel, logDebug, logErr, setLogLevel } from '../src/mcp/log';

const OPEN: Partial<Policy> = { allowDomains: ['*'], enableMutations: true, allowEval: true, allowDownloads: true };
const TAB = 'extension:stub:1';

function configure(stub: StubOptions = {}): StubExecutor {
  resetManagerForTesting();
  resetRateLimiter();
  const ex = new StubExecutor({ activeUrl: 'https://example.com', ...stub });
  configureManager({ policy: resolvePolicy(OPEN), makeExecutor: () => ex });
  return ex;
}

function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

function jsonOf(r: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(r)) as Record<string, unknown>;
}

// --- The pure helpers ------------------------------------------------------

test('capText leaves content under the budget untouched', () => {
  const out = capText('hello', 1024);
  assert.equal(out.text, 'hello');
  assert.equal(out.truncated, false);
  assert.equal(out.totalBytes, 5);
});

test('capText truncates and reports both byte counts', () => {
  const out = capText('x'.repeat(5000), 1000);
  assert.equal(out.truncated, true);
  assert.equal(out.totalBytes, 5000);
  assert.equal(out.returnedBytes, 1000);
});

test('capText never splits a multi-byte character', () => {
  // Each "é" is 2 bytes, so a 5-byte budget lands mid-character.
  const out = capText('é'.repeat(10), 5);
  assert.equal(out.truncated, true);
  assert.ok(!out.text.includes('�'), 'decoded a replacement character at the seam');
  assert.equal(Buffer.byteLength(out.text, 'utf8'), 4);
});

test('capHtml backs up to the last complete tag', () => {
  const html = '<div><p>alpha</p><p>beta-and-more-text</p></div>';
  const out = capHtml(html, 25);
  assert.equal(out.truncated, true);
  assert.ok(out.text.endsWith('>'), `ended mid-tag: ${JSON.stringify(out.text)}`);
  assert.ok(html.startsWith(out.text));
});

// --- The tool surface ------------------------------------------------------

test('get_html caps a huge page and reports the truncation', async () => {
  const huge = `<html><body>${'<p>filler</p>'.repeat(60_000)}</body></html>`;
  configure({ htmlPayload: huge });
  const r = await dispatchToolCall('get_html', { tabId: TAB });
  const out = jsonOf(r);
  assert.equal(out.truncated, true);
  assert.equal(out.totalBytes, Buffer.byteLength(huge, 'utf8'));
  assert.ok((out.returnedBytes as number) <= DEFAULT_MAX_OUTPUT_BYTES);
  assert.ok((out.html as string).endsWith('>'), 'html was cut mid-tag');
  assert.match(String(out.truncationNote), /maxBytes/);
});

test('get_html honors an explicit maxBytes', async () => {
  configure({ htmlPayload: `<html><body>${'<p>filler</p>'.repeat(5000)}</body></html>` });
  const r = await dispatchToolCall('get_html', { tabId: TAB, maxBytes: MIN_OUTPUT_BYTES });
  const out = jsonOf(r);
  assert.equal(out.truncated, true);
  assert.ok((out.returnedBytes as number) <= MIN_OUTPUT_BYTES);
});

test('get_html under the cap carries no truncation fields', async () => {
  configure();
  const r = await dispatchToolCall('get_html', { tabId: TAB });
  const out = jsonOf(r);
  assert.equal(out.truncated, undefined);
  assert.equal(out.totalBytes, undefined);
  assert.match(out.html as string, /Example/);
});

test('get_text caps a huge text read', async () => {
  configure({ textPayload: 'y'.repeat(DEFAULT_MAX_OUTPUT_BYTES * 2) });
  const r = await dispatchToolCall('get_text', { tabId: TAB, maxBytes: 2048 });
  const out = jsonOf(r);
  assert.equal(out.truncated, true);
  assert.equal((out.text as string).length, 2048);
  assert.equal(out.totalBytes, DEFAULT_MAX_OUTPUT_BYTES * 2);
});

test('read_as_markdown appends a truncation notice in the body', async () => {
  configure({ htmlPayload: `<html><body>${'<p>a paragraph of prose</p>'.repeat(4000)}</body></html>` });
  const r = await dispatchToolCall('read_as_markdown', { tabId: TAB, maxBytes: 2048 });
  const body = textOf(r);
  assert.match(body, /\[truncated: \d+ of \d+ bytes/);
});

test('an out-of-range maxBytes is a clean isError, not a throw', async () => {
  configure();
  let r: CallToolResult;
  await assert.doesNotReject(async () => {
    r = await dispatchToolCall('get_html', { tabId: TAB, maxBytes: 1 });
  });
  assert.equal(r!.isError, true);
});

// --- Batch result budget ---------------------------------------------------

interface BatchHeader {
  batch: { total: number; ok: number; omittedOps?: number; omittedBytes?: number };
}

test('batch elides op payloads once the result budget is spent', async () => {
  configure({ htmlPayload: `<html><body>${'<p>filler</p>'.repeat(2000)}</body></html>` });
  const ops = Array.from({ length: 8 }, () => ({ tool: 'get_html', args: { tabId: TAB } }));
  const r = await dispatchToolCall('batch', { ops, maxResultBytes: 40_000 });
  const header = JSON.parse(textOf(r)) as BatchHeader;
  assert.equal(header.batch.total, 8);
  assert.equal(header.batch.ok, 8, 'every op should still RUN — only the payload is elided');
  assert.ok((header.batch.omittedOps ?? 0) > 0, 'expected some ops to be elided');
  const all = r.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  assert.match(all, /omitted: \d+ text block\(s\)/);
  assert.match(all, /batch result budget reached/);
});

test('batch returns the first op in full even when it alone exceeds the budget', async () => {
  configure({ htmlPayload: `<html><body>${'<p>filler</p>'.repeat(2000)}</body></html>` });
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'get_html', args: { tabId: TAB } },
      { tool: 'get_html', args: { tabId: TAB } },
    ],
    maxResultBytes: 4096,
  });
  const header = JSON.parse(textOf(r)) as BatchHeader;
  assert.equal(header.batch.omittedOps, 1);
  const all = r.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  assert.match(all, /--- op 0 \(get_html\) ok ---/);
});

test('a small batch inside the budget reports no omissions', async () => {
  configure();
  const r = await dispatchToolCall('batch', {
    ops: [
      { tool: 'get_text', args: { tabId: TAB } },
      { tool: 'get_text', args: { tabId: TAB } },
    ],
  });
  const header = JSON.parse(textOf(r)) as BatchHeader;
  assert.equal(header.batch.omittedOps, undefined);
});

// --- Retry on a mid-flight extension disconnect ----------------------------

test('a read that hits EXTENSION_DISCONNECTED is retried once and succeeds', async () => {
  const ex = configure({ disconnectReads: 1 });
  const r = await dispatchToolCall('get_text', { tabId: TAB });
  assert.notEqual(r.isError, true, `expected the retry to succeed, got: ${textOf(r)}`);
  assert.equal(jsonOf(r).text, 'stub text');
  assert.equal(ex.pendingDisconnects, 0, 'the scripted disconnect should have been consumed');
});

test('a persistent disconnect still surfaces the error after one retry', async () => {
  configure({ disconnectReads: 5 });
  const r = await dispatchToolCall('get_html', { tabId: TAB });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /\[EXTENSION_DISCONNECTED\]/);
});

test('a mutating tool is NOT retried — repeating a write is worse than one error', async () => {
  // Two disconnects are scripted but only one attempt may be made: if `type`
  // were retried, the second attempt would consume the second disconnect and
  // then a third call would succeed, silently double-typing into a real page.
  const ex = configure({ disconnectWrites: 2 });
  const r = await dispatchToolCall('type', { selector: '#in', text: 'hello', tabId: TAB });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /\[EXTENSION_DISCONNECTED\]/);
  assert.equal(ex.pendingWriteDisconnects, 1, 'exactly one attempt should have been made');
});

test('a read that recovers consumes exactly one retry, not an unbounded loop', async () => {
  const ex = configure({ disconnectReads: 3 });
  const r = await dispatchToolCall('get_text', { tabId: TAB });
  assert.equal(r.isError, true);
  // 1 initial attempt + 1 retry = 2 consumed, leaving 1.
  assert.equal(ex.pendingDisconnects, 1);
});

// --- --log-level ------------------------------------------------------------

/** Capture everything written to stderr while `run` executes. */
function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    run();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  return captured;
}

test('--log-level silent suppresses stderr output', () => {
  const previous = getLogLevel();
  try {
    setLogLevel('silent');
    const out = captureStderr(() => {
      logErr('this must not appear');
      logDebug('nor this');
    });
    assert.equal(out, '');
  } finally {
    setLogLevel(previous);
  }
});

test('--log-level info logs errors but not debug tracing', () => {
  const previous = getLogLevel();
  try {
    setLogLevel('info');
    const out = captureStderr(() => {
      logErr('visible');
      logDebug('hidden');
    });
    assert.match(out, /visible/);
    assert.ok(!out.includes('hidden'), 'debug tracing leaked at info level');
  } finally {
    setLogLevel(previous);
  }
});

test('--log-level debug enables the verbose tracing', () => {
  const previous = getLogLevel();
  try {
    setLogLevel('debug');
    const out = captureStderr(() => {
      logErr('visible');
      logDebug('traced');
    });
    assert.match(out, /visible/);
    assert.match(out, /\[debug\] traced/);
  } finally {
    setLogLevel(previous);
  }
});
