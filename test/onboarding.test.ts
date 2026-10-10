/**
 * The three walls telemetry showed new users hitting, and their fixes:
 *   A. sites allowed at runtime from the extension's Options (normalizeGrant,
 *      SiteGrants, and the bridge's site_grant → policy / blocked frames).
 *   B. pairing diagnosis: pairState and pairingSteps name what went wrong.
 *   C. telemetry: an early first summary and a pair_check event.
 *   D. selector-scoped reads wait for their element and suggest look-alikes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { BridgeServer } from '../src/bridge/server';
import { GRANTS_FILE, SiteGrants, normalizeGrant } from '../src/bridge/site-grants';
import { PROTOCOL_VERSION, type WirePolicy } from '../shared/protocol';
import { initTelemetry, noteToolCall, resetTelemetryForTesting, stopTelemetry } from '../src/telemetry';
import { pageOp } from '../shared/page-fns';

const TOKEN = 'good-token-abc123';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'cmcp-onb-'));
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function policy(allowDomains: string[] = []): WirePolicy {
  return {
    allowDomains,
    allowEval: false,
    allowDownloads: false,
    allowUploads: false,
    allowAllTabs: false,
    enableMutations: false,
  };
}

/** A fake extension that records every frame the server pushes to it. */
class Ext {
  readonly frames: Array<Record<string, unknown>> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => this.frames.push(JSON.parse(raw.toString())));
  }
  static async open(port: number, token = TOKEN, profile = 'meh'): Promise<Ext> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const ext = new Ext(ws);
    ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, token, ext: { id: 'e', version: '1', chrome: '1' }, profile }));
    await ext.next('welcome', 'unauthorized');
    return ext;
  }
  async next(...types: string[]): Promise<Record<string, unknown>> {
    for (let i = 0; i < 100; i++) {
      const hit = this.frames.find((f) => types.includes(String(f.type)));
      if (hit) {
        this.frames.splice(this.frames.indexOf(hit), 1);
        return hit;
      }
      await delay(10);
    }
    throw new Error(`no ${types.join('/')} frame arrived`);
  }
  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
  }
}

// -- A. runtime site grants ----------------------------------------------------

test('normalizeGrant keeps one concrete site and refuses the catch-alls', () => {
  assert.equal(normalizeGrant('Example.com'), 'example.com');
  assert.equal(normalizeGrant('https://app.example.com/dashboard?x=1'), 'app.example.com');
  assert.equal(normalizeGrant('*.example.com'), '*.example.com');
  assert.equal(normalizeGrant('localhost:3000'), 'localhost');
  assert.equal(normalizeGrant('*'), null);
  assert.equal(normalizeGrant('*://*/*'), null);
  assert.equal(normalizeGrant(''), null);
  assert.equal(normalizeGrant('exa mple.com'), null);
  assert.equal(normalizeGrant('a.*.com'), null);
  assert.equal(normalizeGrant(42), null);
});

test('SiteGrants edits the live array in place, persists, and never touches flag entries', () => {
  const dir = tmp();
  const live = ['flag.com'];
  const g = new SiteGrants(live, dir);
  assert.equal(g.apply('https://new.com/x', true), 'new.com');
  assert.deepEqual(live, ['flag.com', 'new.com']);
  assert.equal(g.apply('new.com', true), null, 'already granted: no change');
  assert.equal(g.apply('flag.com', true), null, 'a flag entry is not a grant');
  assert.equal(g.apply('flag.com', false), null, 'and cannot be revoked from Options');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, GRANTS_FILE), 'utf8')), { sites: ['new.com'] });

  // A restart reloads the grant into a fresh live array.
  const again = ['flag.com'];
  assert.deepEqual(new SiteGrants(again, dir).list(), ['new.com']);
  assert.deepEqual(again, ['flag.com', 'new.com']);

  assert.equal(g.apply('new.com', false), 'new.com');
  assert.deepEqual(live, ['flag.com']);
});

test('an Allow from the extension widens the live policy and reaches every browser', async () => {
  const live = policy([]);
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0, policy: live, dataDir: tmp() });
  const port = await bridge.start();
  try {
    const a = await Ext.open(port);
    const b = await Ext.open(port, TOKEN, 'work');
    a.send({ type: 'site_grant', host: 'https://news.ycombinator.com/item', allow: true });
    for (const ext of [a, b]) {
      const f = await ext.next('policy');
      assert.deepEqual((f.policy as WirePolicy).allowDomains, ['news.ycombinator.com']);
      assert.deepEqual(f.granted, ['news.ycombinator.com']);
    }
    // The server gate reads this same array.
    assert.deepEqual(live.allowDomains, ['news.ycombinator.com']);
    assert.deepEqual(bridge.grantedSites(), ['news.ycombinator.com']);

    // A browser pairing later learns the grants in its welcome.
    const c = new Ext(new WebSocket(`ws://127.0.0.1:${port}`));
    await once(c.ws, 'open');
    c.send({ type: 'hello', token: TOKEN, ext: { id: 'c', version: '1', chrome: '1' }, profile: 'other' });
    assert.deepEqual((await c.next('welcome')).granted, ['news.ycombinator.com']);

    // A catch-all is never accepted from Options.
    a.send({ type: 'site_grant', host: '*', allow: true });
    await delay(50);
    assert.deepEqual(live.allowDomains, ['news.ycombinator.com']);
  } finally {
    await bridge.stop();
  }
});

test('a refused site is reported to the browser so Options can offer Allow', async () => {
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0, policy: policy() });
  const port = await bridge.start();
  try {
    const a = await Ext.open(port);
    bridge.noteBlocked('example.com', 'get_text');
    const f = await a.next('blocked');
    assert.equal(f.host, 'example.com');
    assert.equal(f.method, 'get_text');
  } finally {
    await bridge.stop();
  }
});

test('--no-site-grants: Options cannot change the allowlist', async () => {
  const live = policy(['flag.com']);
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0, policy: live, siteGrants: false });
  const port = await bridge.start();
  try {
    const a = await Ext.open(port);
    a.send({ type: 'site_grant', host: 'new.com', allow: true });
    await delay(50);
    assert.deepEqual(live.allowDomains, ['flag.com']);
    assert.equal(a.frames.some((f) => f.type === 'policy'), false);
  } finally {
    await bridge.stop();
  }
});

test('a grant made through the hub reaches a peer session, and a peer\'s block reaches the browser', async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));

  const dataDir = tmp();
  const hubPolicy = policy();
  const peerPolicy = policy();
  const hub = new BridgeServer({ token: TOKEN, serverVersion: 't', port, heartbeatMs: 0, policy: hubPolicy, dataDir });
  const peer = new BridgeServer({ token: TOKEN, serverVersion: 't', port, heartbeatMs: 0, policy: peerPolicy, dataDir });
  await hub.start();
  await peer.start();
  try {
    assert.equal(peer.role, 'peer');
    const a = await Ext.open(port);
    a.send({ type: 'site_grant', host: 'github.com', allow: true });
    await a.next('policy');
    for (let i = 0; i < 100 && !peerPolicy.allowDomains.includes('github.com'); i++) await delay(10);
    assert.deepEqual(peerPolicy.allowDomains, ['github.com'], "the peer's own gate is widened too");

    peer.noteBlocked('gitlab.com', 'navigate');
    assert.equal((await a.next('blocked')).host, 'gitlab.com');
  } finally {
    await peer.stop();
    await hub.stop();
  }
});

// -- B. pairing diagnosis ------------------------------------------------------

test('pairState tells no extension, a stale token and a profile mismatch apart', async () => {
  const dataDir = tmp();
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0, dataDir });
  const port = await bridge.start();
  try {
    assert.equal(bridge.pairState('meh'), 'no_extension');
    const none = bridge.pairingSteps('meh').join(' ');
    assert.match(none, /chromewebstore\.google\.com/);
    assert.match(none, new RegExp(`Port ${port}`));
    assert.ok(none.includes(join(dataDir, 'handshake.json')));
    assert.ok(!none.includes(TOKEN), 'never the token itself');

    const stale = await Ext.open(port, 'wrong-token');
    if (stale.ws.readyState !== WebSocket.CLOSED) await once(stale.ws, 'close');
    assert.equal(bridge.pairState('meh'), 'token_mismatch');
    assert.match(bridge.noPairMessage('meh'), /old token.*--persist-token/s);

    await Ext.open(port); // pairs as "meh"
    assert.equal(bridge.pairState('meh'), 'ok');
    assert.deepEqual(bridge.pairingSteps('meh'), []);
    assert.equal(bridge.pairState('work'), 'profile_mismatch');
    assert.match(bridge.noPairMessage('work'), /paired, but as "meh".*profile_use/);
  } finally {
    await bridge.stop();
  }
});

// -- C. telemetry --------------------------------------------------------------

test('telemetry sends pair_check and an early first summary', async () => {
  resetTelemetryForTesting();
  const sent: Array<{ event: string; properties: Record<string, unknown> }> = [];
  initTelemetry({
    dataDir: tmp(),
    version: '9.9.9',
    env: {},
    key: 'phc_test',
    send: async (batch) => void sent.push(...(batch as typeof sent)),
    context: () => ({ role: 'hub', browsers: 0, pair_state: 'token_mismatch' }),
    delaysMs: { firstFlush: 20, pairCheck: 20 },
  });
  noteToolCall('navigate', false, '[NO_BACKEND] nothing paired');
  await delay(80);
  const check = sent.find((e) => e.event === 'pair_check');
  assert.equal(check?.properties.pair_state, 'token_mismatch');
  const summary = sent.find((e) => e.event === 'usage_summary');
  assert.equal(summary?.properties.calls, 1);
  assert.deepEqual(summary?.properties.error_codes, { NO_BACKEND: 1 });
  await stopTelemetry();
});

// -- D. reads wait, misses suggest -----------------------------------------------

/** Just enough DOM for pageOp's text op and its suggestion scan. */
function fakeDom(nodes: Array<{ id?: string; classes?: string[]; tag?: string }>, appearAfterMs?: number) {
  const elements = nodes.map((n) => ({
    id: n.id ?? '',
    tagName: (n.tag ?? 'div').toUpperCase(),
    classList: n.classes ?? [],
    getAttribute: () => null,
    innerText: 'late text',
  }));
  let present = false;
  if (appearAfterMs !== undefined) setTimeout(() => (present = true), appearAfterMs);
  const g = globalThis as Record<string, unknown>;
  g.document = {
    querySelector: (sel: string) => (present && sel === '#late' ? elements[0] : null),
    querySelectorAll: (sel: string) => (sel === '*' ? [] : elements),
    body: { innerText: '' },
  };
  g.CSS = { escape: (v: string) => v };
  return () => {
    delete g.document;
    delete g.CSS;
  };
}

test('a selector miss suggests similar elements on the page', async () => {
  const restore = fakeDom([{ id: 'submit-order' }, { classes: ['order-total'] }, { id: 'nav' }]);
  try {
    const out = (await pageOp({ op: 'text', selector: '#submitOrderBtn .order' })) as { found: boolean; suggestions: string[] };
    assert.equal(out.found, false);
    assert.deepEqual(out.suggestions, ['#submit-order', 'div.order-total']);
    const out2 = (await pageOp({ op: 'html', selector: '#submit' })) as { found: boolean; suggestions: string[] };
    assert.deepEqual(out2.suggestions, ['#submit-order']);
  } finally {
    restore();
  }
});

test('get_text with a selector waits for an element that renders late', async () => {
  const restore = fakeDom([{ id: 'late' }], 100);
  try {
    const out = (await pageOp({ op: 'text', selector: '#late', timeoutMs: 1_000, interval: 20 })) as { found: boolean; text: string };
    assert.equal(out.found, true);
    assert.equal(out.text, 'late text');
  } finally {
    restore();
  }
});
