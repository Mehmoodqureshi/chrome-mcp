/**
 * Phase 3 verification.
 *   A. ExtensionExecutor translates Executor calls into real bridge round-trips,
 *      and its ping honors a short deadline (the MV3 dead-worker fall-through).
 *   B. The selector picks extension-if-responsive, else CDP, honoring --prefer
 *      and --no-cdp-fallback.
 *   C. (gated on Chromium) CdpExecutor actually launches and drives a page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';

import { BridgeServer } from '../src/bridge/server';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { ExtensionExecutor } from '../src/executor/extension-executor';
import { createSelector } from '../src/executor/select';
import { CdpExecutor, type CdpOptions } from '../src/executor/cdp-executor';
import { ExecutorError, type Executor } from '../src/executor/types';

const TOKEN = 'tok-phase3';

class FakeExtension {
  onCommand: ((c: { id: string; method: string; params: Record<string, unknown> }) => void) | null = null;
  private welcomeResolve!: () => void;
  readonly welcomed: Promise<void>;
  constructor(readonly ws: WebSocket) {
    this.welcomed = new Promise((r) => (this.welcomeResolve = r));
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'welcome') this.welcomeResolve();
      else if (f.type === 'command') this.onCommand?.(f);
    });
  }
  static async open(port: number): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const fe = new FakeExtension(ws);
    ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, token: TOKEN, ext: { id: 'e', version: '1', chrome: '123' } }));
    await fe.welcomed;
    return fe;
  }
  result(id: string, data: unknown): void {
    this.ws.send(JSON.stringify({ type: 'result', v: PROTOCOL_VERSION, id, ok: true, data }));
  }
}

async function bridgeWithExtension(): Promise<{ bridge: BridgeServer; fe: FakeExtension }> {
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0 });
  const port = await bridge.start();
  const fe = await FakeExtension.open(port);
  return { bridge, fe };
}

// --- A. ExtensionExecutor over the real bridge -----------------------------

test('ExtensionExecutor translates navigate/get_text over the bridge', async () => {
  const { bridge, fe } = await bridgeWithExtension();
  try {
    fe.onCommand = (c) => {
      if (c.method === 'navigate') fe.result(c.id, { url: c.params.url, title: 'Example' });
      else if (c.method === 'get_text') fe.result(c.id, { text: 'hello', ref: 'el_1' });
    };
    const ex = new ExtensionExecutor(bridge);
    const nav = await ex.navigate({ url: 'https://example.com' });
    assert.deepEqual(nav, { url: 'https://example.com', title: 'Example' });
    const text = await ex.getText();
    assert.deepEqual(text, { text: 'hello', ref: 'el_1' });
  } finally {
    await bridge.stop();
  }
});

test('ExtensionExecutor.ping resolves true when answered, false on deadline', async () => {
  const { bridge, fe } = await bridgeWithExtension();
  try {
    const ex = new ExtensionExecutor(bridge);
    fe.onCommand = (c) => {
      if (c.method === 'ping_probe') fe.result(c.id, {});
    };
    assert.equal(await ex.ping(500), true);
    // Now ignore the probe → ping should fail within the deadline.
    fe.onCommand = null;
    const t0 = Date.now();
    assert.equal(await ex.ping(200), false);
    assert.ok(Date.now() - t0 < 1500, 'ping must honor the short deadline');
  } finally {
    await bridge.stop();
  }
});

// --- B. Selection matrix (fakes; no browser) -------------------------------

const fakeExt = (ping: boolean): Executor => ({ backend: 'extension', ping: async () => ping } as unknown as Executor);
const fakeCdp: Executor = { backend: 'cdp' } as unknown as Executor;
const fakeBridge = (connected: boolean) => ({ hasActiveExtension: () => connected }) as unknown as BridgeServer;
const cdpOpts: CdpOptions = { mode: 'launch', userDataDir: '/tmp/none' };

test('selector: responsive extension wins', async () => {
  const ext = fakeExt(true);
  const select = createSelector({
    bridge: fakeBridge(true), cdpFallback: true, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => ext, makeCdp: () => fakeCdp,
  });
  assert.equal(await select(), ext);
});

test('selector: no extension → CDP fallback', async () => {
  const select = createSelector({
    bridge: fakeBridge(false), cdpFallback: true, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => fakeExt(true), makeCdp: () => fakeCdp,
  });
  assert.equal(await select(), fakeCdp);
});

test('selector: --prefer cdp uses CDP even with an extension present', async () => {
  const select = createSelector({
    bridge: fakeBridge(true), cdpFallback: true, prefer: 'cdp', cdp: cdpOpts,
    makeExtension: () => fakeExt(true), makeCdp: () => fakeCdp,
  });
  assert.equal(await select(), fakeCdp);
});

test('selector: dead-but-connected extension (ping false) falls through to CDP', async () => {
  const select = createSelector({
    bridge: fakeBridge(true), cdpFallback: true, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => fakeExt(false), makeCdp: () => fakeCdp,
  });
  assert.equal(await select(), fakeCdp);
});

test('selector: no extension and no CDP fallback → NO_BACKEND', async () => {
  const select = createSelector({
    bridge: fakeBridge(false), cdpFallback: false, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => fakeExt(true), makeCdp: () => fakeCdp,
  });
  await assert.rejects(select(), (e: unknown) => e instanceof ExecutorError && e.code === 'NO_BACKEND');
});

/** A pingable fake that counts how many times it was probed. */
const countingExt = (alive: () => boolean): { ext: Executor; pings: () => number } => {
  let pings = 0;
  const ext = { backend: 'extension', ping: async () => (pings++, alive()) } as unknown as Executor;
  return { ext, pings: () => pings };
};

test('selector: a successful ping is cached within the TTL (no re-ping on a burst)', async () => {
  const { ext, pings } = countingExt(() => true);
  const select = createSelector({
    bridge: fakeBridge(true), cdpFallback: true, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => ext, makeCdp: () => fakeCdp, pingCacheMs: 10_000,
  });
  assert.equal(await select(), ext);
  assert.equal(await select(), ext);
  assert.equal(await select(), ext);
  assert.equal(pings(), 1, 'a burst within the TTL probes once, then trusts the cache');
});

test('selector: pingCacheMs=0 disables the cache (probes every call)', async () => {
  const { ext, pings } = countingExt(() => true);
  const select = createSelector({
    bridge: fakeBridge(true), cdpFallback: true, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => ext, makeCdp: () => fakeCdp, pingCacheMs: 0,
  });
  await select();
  await select();
  assert.equal(pings(), 2, 'with the cache off, every call re-probes');
});

test('selector: a failed ping is NOT cached (keeps probing so it can recover)', async () => {
  let alive = false;
  const { ext, pings } = countingExt(() => alive);
  const select = createSelector({
    bridge: fakeBridge(true), cdpFallback: true, prefer: 'extension', cdp: cdpOpts,
    makeExtension: () => ext, makeCdp: () => fakeCdp, pingCacheMs: 10_000,
  });
  assert.equal(await select(), fakeCdp, 'dead extension → CDP fallback');
  alive = true;
  assert.equal(await select(), ext, 'recovers on the next call because the failure was not cached');
  assert.equal(pings(), 2);
});

// --- C. Live CDP launch (skipped when Chromium isn't installed) ------------

let hasChromium = false;
try {
  hasChromium = existsSync(chromium.executablePath());
} catch {
  hasChromium = false;
}

test('CdpExecutor launches Chromium and drives a page', { skip: !hasChromium }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-cdp-'));
  const ex = new CdpExecutor({ mode: 'launch', userDataDir: dir, headless: true });
  try {
    await ex.ensureReady();
    const nav = await ex.navigate({ url: 'data:text/html,<body><h1>Hi There</h1></body>' });
    assert.match(nav.url, /^data:/);
    const { text } = await ex.getText();
    assert.match(text, /Hi There/);
    const shot = await ex.screenshot();
    assert.equal(shot.mimeType, 'image/png');
    assert.ok(shot.dataBase64.length > 0);
  } finally {
    await ex.dispose();
  }
});
