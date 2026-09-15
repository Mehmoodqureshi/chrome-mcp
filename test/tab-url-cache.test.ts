/**
 * The per-tab URL cache on an extension connection (src/bridge/connection.ts).
 *
 * A `tabs_list` result primes the cache for EVERY tab it lists, a result for an
 * explicitly-targeted tab refreshes that tab's entry, an error for a tab drops
 * it, and `tab_close` forgets the tab. This is what lets a parallel batch over
 * N tabs pass the server-side policy gate on one round-trip rather than N.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import { BridgeServer } from '../src/bridge/server';
import { ExtensionExecutor } from '../src/executor/extension-executor';
import { PROTOCOL_VERSION, WIRE_CAP_TAB_URL } from '../shared/protocol';

const TOKEN = 'tok-tab-url-cache';

interface Cmd {
  id: string;
  method: string;
  params: Record<string, unknown>;
  tabId?: string;
}

class FakeExtension {
  onCommand: ((c: Cmd) => void) | null = null;
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
  static async open(port: number, caps: string[]): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const fe = new FakeExtension(ws);
    ws.send(
      JSON.stringify({
        type: 'hello',
        v: PROTOCOL_VERSION,
        token: TOKEN,
        ext: { id: 'e', version: '1', chrome: '123' },
        caps,
      }),
    );
    await fe.welcomed;
    return fe;
  }
  result(id: string, data: unknown, tabUrl?: string): void {
    this.ws.send(JSON.stringify({ type: 'result', v: PROTOCOL_VERSION, id, ok: true, data, ...(tabUrl !== undefined ? { tabUrl } : {}) }));
  }
  error(id: string): void {
    this.ws.send(JSON.stringify({ type: 'error', v: PROTOCOL_VERSION, id, ok: false, error: { code: 'TARGET_GONE', message: 'gone' } }));
  }
}

async function setup(caps: string[] = [WIRE_CAP_TAB_URL]): Promise<{ bridge: BridgeServer; fe: FakeExtension; ex: ExtensionExecutor }> {
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0 });
  const port = await bridge.start();
  const fe = await FakeExtension.open(port, caps);
  return { bridge, fe, ex: new ExtensionExecutor(bridge) };
}

const TABS = [
  { tabId: 'ext:s:1', url: 'https://a.example/', title: 'A', active: true, index: 0 },
  { tabId: 'ext:s:2', url: 'https://b.example/', title: 'B', active: false, index: 1 },
  { tabId: 'ext:s:3', url: '', title: 'hidden', active: false, index: 2 },
];

test('a tabs_list result primes the per-tab URL cache for every listed tab', async () => {
  const { bridge, fe, ex } = await setup();
  try {
    fe.onCommand = (c) => {
      if (c.method === 'tabs_list') fe.result(c.id, TABS);
    };
    assert.equal(ex.cachedTabUrl('ext:s:2'), null, 'nothing known before any result');
    await ex.tabsList();
    assert.equal(ex.cachedTabUrl('ext:s:1'), 'https://a.example/');
    assert.equal(ex.cachedTabUrl('ext:s:2'), 'https://b.example/');
    assert.equal(ex.cachedTabUrl('ext:s:3'), null, 'a tab Chrome hides the URL of is never cached');
  } finally {
    await bridge.stop();
  }
});

test('a result for an explicitly-targeted tab refreshes that tab; an error drops it', async () => {
  const { bridge, fe, ex } = await setup();
  try {
    fe.onCommand = (c) => {
      if (c.method === 'tabs_list') fe.result(c.id, TABS);
      else if (c.method === 'navigate') fe.result(c.id, { url: 'https://b.example/next', title: 'B2' }, 'https://b.example/next');
      else if (c.method === 'get_text') fe.error(c.id);
    };
    await ex.tabsList();
    await ex.navigate({ url: 'https://b.example/next', tabId: 'ext:s:2' });
    assert.equal(ex.cachedTabUrl('ext:s:2'), 'https://b.example/next', 'the landing URL replaces the listed one');
    assert.equal(ex.cachedTabUrl('ext:s:1'), 'https://a.example/', 'other tabs are untouched');
    await assert.rejects(ex.getText(undefined, { tabId: 'ext:s:2' }));
    assert.equal(ex.cachedTabUrl('ext:s:2'), null, 'a failed command says nothing reliable about the tab');
  } finally {
    await bridge.stop();
  }
});

test('tab_close forgets the tab; a legacy extension (no tab-url cap) never caches', async () => {
  const { bridge, fe, ex } = await setup();
  try {
    fe.onCommand = (c) => {
      if (c.method === 'tabs_list') fe.result(c.id, TABS);
      else if (c.method === 'tab_close') fe.result(c.id, { closed: true, tabId: c.tabId });
    };
    await ex.tabsList();
    await ex.tabClose('ext:s:1');
    assert.equal(ex.cachedTabUrl('ext:s:1'), null);
    assert.equal(ex.cachedTabUrl('ext:s:2'), 'https://b.example/');
  } finally {
    await bridge.stop();
  }

  const legacy = await setup([]);
  try {
    legacy.fe.onCommand = (c) => {
      if (c.method === 'tabs_list') legacy.fe.result(c.id, TABS);
    };
    await legacy.ex.tabsList();
    assert.equal(legacy.ex.cachedTabUrl('ext:s:1'), null, 'without the capability the server must always ask');
  } finally {
    await legacy.bridge.stop();
  }
});
