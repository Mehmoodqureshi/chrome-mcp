/**
 * Frame targeting, shadow-DOM resolution, and the in-page observers.
 *
 * The headline case is the first test: `snapshot` has always walked open shadow
 * roots and stamped a ref on what it found there, while every action resolved
 * that ref with a plain `document.querySelector` — which cannot cross a shadow
 * boundary. The snapshot advertised elements no click could reach.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { pageOp } from '../shared/page-fns';
import { dispatchToolCall } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import { evaluatePolicy } from '../shared/policy';
import { observerMatches } from '../shared/observers';

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

// ---------------------------------------------------------------------------
// The shadow-DOM resolution fix
// ---------------------------------------------------------------------------

/** Minimal DOM stand-ins: `pageOp` only ever touches querySelector(All) here. */
function fakeDom(): { restore: () => void; shadowText: string } {
  const shadowText = 'inside the shadow root';
  const deep = { innerText: shadowText, tagName: 'BUTTON' };
  const shadowRoot = {
    querySelector: (s: string) => (s === '#deep' ? deep : null),
    querySelectorAll: () => [],
  };
  const host = { shadowRoot, tagName: 'MY-WIDGET' };
  const light = { innerText: 'light dom', tagName: 'DIV' };
  const document = {
    body: { innerText: 'body text' },
    documentElement: { outerHTML: '<html></html>' },
    querySelector: (s: string) => (s === '#light' ? light : null),
    querySelectorAll: (s: string) => (s === '*' ? [host] : []),
  };
  const prevDoc = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = document;
  return {
    shadowText,
    restore: () => {
      (globalThis as Record<string, unknown>).document = prevDoc;
    },
  };
}

test('pageOp resolves a selector inside an open shadow root', () => {
  const dom = fakeDom();
  try {
    const found = pageOp({ op: 'text', selector: '#deep' }) as { found: boolean; text: string };
    assert.equal(found.found, true, 'a shadow-root element must be reachable — snapshot already advertises it');
    assert.equal(found.text, dom.shadowText);

    // Light DOM still resolves, and a genuine miss is still a miss.
    const lightHit = pageOp({ op: 'text', selector: '#light' }) as { found: boolean; text: string };
    assert.equal(lightHit.text, 'light dom');
    const miss = pageOp({ op: 'text', selector: '#nope' }) as { found: boolean };
    assert.equal(miss.found, false);
  } finally {
    dom.restore();
  }
});

test('pageOp survives a malformed selector instead of throwing into the page', () => {
  const dom = fakeDom();
  try {
    (globalThis as Record<string, unknown>).document = {
      querySelector: () => {
        throw new SyntaxError('bad selector');
      },
      querySelectorAll: () => [],
    };
    const res = pageOp({ op: 'click', selector: ':::' }) as { found: boolean };
    assert.equal(res.found, false);
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// Frame targeting
// ---------------------------------------------------------------------------

test('frames_list reports every frame with its URL', async () => {
  configure(OPEN, {
    activeUrl: 'https://example.com',
    frames: [
      { frameId: 0, top: true, url: 'https://example.com/checkout', title: 'Checkout' },
      { frameId: 7, top: false, url: 'https://pay.example.net/widget', title: 'Pay' },
    ],
  });
  const res = await dispatchToolCall('frames_list', {});
  assert.equal(res.isError, undefined);
  const body = JSON.parse(textOf(res)) as { count: number; frames: Array<{ frameId: number }>; hint?: string };
  assert.equal(body.count, 2);
  assert.equal(body.frames[1].frameId, 7);
  assert.match(body.hint ?? '', /allFrames/);
});

test('a frame-scoped command is gated against the FRAME url, not the tab url', () => {
  // The extension resolves each frame's own URL and drops the ones the
  // allowlist does not cover; this is that decision, exercised directly.
  const policy = resolvePolicy({ allowDomains: ['example.com'], enableMutations: true });
  assert.equal(evaluatePolicy('https://example.com/page', 'click', policy).ok, true);
  assert.equal(evaluatePolicy('https://tracker.example.net/frame', 'click', policy).ok, false);
});

// ---------------------------------------------------------------------------
// Observers
// ---------------------------------------------------------------------------

test('observers are denied unless explicitly enabled', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const res = await dispatchToolCall('console_logs', {});
  assert.equal(res.isError, true);
  assert.match(textOf(res), /--enable-observers/);
});

test('console_logs returns recorded entries and filters by level', async () => {
  configure(
    { ...OPEN, allowObservers: true },
    {
      activeUrl: 'https://example.com',
      observers: {
        installed: true,
        console: [
          { seq: 1, ts: 1, level: 'log', text: 'hello' },
          { seq: 2, ts: 2, level: 'error', text: 'boom' },
        ],
      },
    },
  );
  const all = JSON.parse(textOf(await dispatchToolCall('console_logs', {}))) as { count: number };
  assert.equal(all.count, 2);

  const errors = JSON.parse(textOf(await dispatchToolCall('console_logs', { level: 'error' }))) as {
    count: number;
    entries: Array<{ text: string }>;
  };
  assert.equal(errors.count, 1);
  assert.equal(errors.entries[0].text, 'boom');
});

test('console_logs says the hook is missing rather than reporting an empty page', async () => {
  configure({ ...OPEN, allowObservers: true }, { activeUrl: 'https://example.com' });
  const res = await dispatchToolCall('console_logs', {});
  assert.equal(res.isError, true);
  assert.match(textOf(res), /observer hook is not present/);
});

test('network_log filters to failures', async () => {
  configure(
    { ...OPEN, allowObservers: true },
    {
      activeUrl: 'https://example.com',
      observers: {
        installed: true,
        network: [
          { seq: 1, ts: 1, via: 'fetch', method: 'GET', url: 'https://example.com/ok', status: 200, ok: true },
          { seq: 2, ts: 2, via: 'fetch', method: 'POST', url: 'https://example.com/api/save', status: 500, ok: false },
          { seq: 3, ts: 3, via: 'xhr', method: 'GET', url: 'https://example.com/dead', error: 'network error' },
        ],
      },
    },
  );
  const failed = JSON.parse(textOf(await dispatchToolCall('network_log', { failedOnly: true }))) as {
    count: number;
    entries: Array<{ url: string }>;
  };
  assert.equal(failed.count, 2);

  const filtered = JSON.parse(textOf(await dispatchToolCall('network_log', { urlContains: '/api/' }))) as {
    count: number;
  };
  assert.equal(filtered.count, 1);
});

test('dialogs reports what was answered and can switch the policy', async () => {
  const ex = configure(
    { ...OPEN, allowObservers: true },
    {
      activeUrl: 'https://example.com',
      observers: {
        installed: true,
        dialogPolicy: 'dismiss',
        dialogs: [{ seq: 1, ts: 1, kind: 'confirm', message: 'Delete this?', answered: 'false' }],
      },
    },
  );
  const res = JSON.parse(textOf(await dispatchToolCall('dialogs', { policy: 'accept' }))) as {
    count: number;
    entries: Array<{ kind: string; answered: string }>;
  };
  assert.equal(res.count, 1);
  assert.equal(res.entries[0].kind, 'confirm');
  assert.equal(ex.lastObserverArgs?.setPolicy, 'accept', 'the policy change must reach the page');
});

test('observer content scripts are registered only for allowlisted sites', () => {
  assert.deepEqual(observerMatches({ ...resolvePolicy({ allowDomains: ['example.com'] }), allowObservers: true }), [
    '*://example.com/*',
  ]);
  assert.deepEqual(
    observerMatches({ ...resolvePolicy({ allowDomains: ['*.example.com'] }), allowObservers: true }),
    ['*://*.example.com/*'],
  );
  assert.deepEqual(observerMatches({ ...resolvePolicy({ allowDomains: ['*'] }), allowObservers: true }), [
    '<all_urls>',
  ]);
  assert.deepEqual(observerMatches(resolvePolicy({})), []);
});

// ---------------------------------------------------------------------------
// print_pdf
// ---------------------------------------------------------------------------

test('print_pdf reports the saved file, not megabytes of base64', async () => {
  configure(OPEN, { activeUrl: 'https://example.com' });
  const res = await dispatchToolCall('print_pdf', {});
  assert.equal(res.isError, undefined);
  const body = JSON.parse(textOf(res)) as { bytes: number; dataBase64?: string };
  assert.ok(body.bytes > 0);
  assert.equal(body.dataBase64, undefined, 'the PDF bytes must not be spent on the caller context');
});
