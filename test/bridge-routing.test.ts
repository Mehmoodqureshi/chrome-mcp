/**
 * Multi-browser routing — the bridge keeps one connection PER profile, so several
 * browsers stay paired at once and a command is routed to its target profile.
 *   A. two profiles coexist; sendCommand routes by profile.
 *   B. a no-profile hello lands under "default".
 *   C. same-profile re-pair supersedes only that profile; others untouched.
 *   D. closing one profile's socket removes only that entry.
 *   E. command to an unpaired profile → actionable EXTENSION_DISCONNECTED.
 *   F. ExtensionExecutor routes to the ACTIVE workspace profile.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { BridgeServer } from '../src/bridge/server';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { ExecutorError } from '../src/executor/types';
import { ExtensionExecutor } from '../src/executor/extension-executor';
import { ensureWorkspace } from '../src/bridge/datadir';
import { setActiveWorkspace, resetActiveWorkspaceForTesting } from '../src/bridge/workspace';

const TOKEN = 'good-token-abc123';

/** A fake extension that auto-answers every command with `{ from: extId }`. */
class Fake {
  private welcomeResolve!: () => void;
  readonly welcomed: Promise<void>;
  constructor(readonly ws: WebSocket, readonly extId: string) {
    this.welcomed = new Promise((r) => (this.welcomeResolve = r));
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'welcome') this.welcomeResolve();
      else if (f.type === 'command') {
        ws.send(JSON.stringify({ type: 'result', v: PROTOCOL_VERSION, id: f.id, ok: true, data: { from: this.extId } }));
      }
    });
  }
  static async open(port: number, extId: string, profile?: string): Promise<Fake> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const fake = new Fake(ws, extId);
    ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, token: TOKEN, ext: { id: extId, version: '1', chrome: '1' }, profile }));
    await fake.welcomed;
    return fake;
  }
  async waitClose(): Promise<number> {
    if (this.ws.readyState === this.ws.CLOSED) return 0;
    const [code] = (await once(this.ws, 'close')) as [number];
    return code;
  }
}

async function server(): Promise<{ bridge: BridgeServer; port: number }> {
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0 });
  const port = await bridge.start();
  return { bridge, port };
}

test('two profiles stay paired at once and sendCommand routes by profile', async () => {
  const { bridge, port } = await server();
  try {
    await Fake.open(port, 'ext-meh', 'mehmood');
    await Fake.open(port, 'ext-muh', 'muhammad');

    assert.deepEqual(bridge.connectedProfiles().sort(), ['mehmood', 'muhammad']);
    assert.ok(bridge.hasConnection('mehmood') && bridge.hasConnection('muhammad'));

    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'mehmood' }), { from: 'ext-meh' });
    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'muhammad' }), { from: 'ext-muh' });
  } finally {
    await bridge.stop();
  }
});

test('a hello with no profile lands under "default"', async () => {
  const { bridge, port } = await server();
  try {
    await Fake.open(port, 'ext-d'); // no profile
    assert.deepEqual(bridge.connectedProfiles(), ['default']);
    assert.deepEqual(await bridge.sendCommand('get_text', {}), { from: 'ext-d' }); // default route
  } finally {
    await bridge.stop();
  }
});

test('same-profile re-pair supersedes only that profile; others survive', async () => {
  const { bridge, port } = await server();
  try {
    const meh1 = await Fake.open(port, 'ext-meh1', 'mehmood');
    await Fake.open(port, 'ext-muh', 'muhammad');

    const meh2 = await Fake.open(port, 'ext-meh2', 'mehmood'); // re-pair mehmood
    assert.equal(await meh1.waitClose(), 4000 /* CLOSE_SUPERSEDED */);

    assert.deepEqual(bridge.connectedProfiles().sort(), ['mehmood', 'muhammad']);
    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'mehmood' }), { from: 'ext-meh2' });
    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'muhammad' }), { from: 'ext-muh' });
    void meh2;
  } finally {
    await bridge.stop();
  }
});

test('closing one profile removes only that entry', async () => {
  const { bridge, port } = await server();
  try {
    const meh = await Fake.open(port, 'ext-meh', 'mehmood');
    await Fake.open(port, 'ext-muh', 'muhammad');

    meh.ws.close();
    // wait until the bridge observes the close
    const deadline = Date.now() + 2000;
    while (bridge.hasConnection('mehmood') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    assert.equal(bridge.hasConnection('mehmood'), false);
    assert.equal(bridge.hasConnection('muhammad'), true);
  } finally {
    await bridge.stop();
  }
});

test('command to an unpaired profile → actionable EXTENSION_DISCONNECTED', async () => {
  const { bridge, port } = await server();
  try {
    await Fake.open(port, 'ext-meh', 'mehmood');
    await assert.rejects(
      bridge.sendCommand('get_text', {}, { profile: 'nobody' }),
      (e: unknown) =>
        e instanceof ExecutorError &&
        e.code === 'EXTENSION_DISCONNECTED' &&
        /No browser is paired for profile "nobody"/.test(e.message) &&
        e.message.includes('Profile to'),
    );
  } finally {
    await bridge.stop();
  }
});

test('ExtensionExecutor routes to the active workspace profile', async () => {
  const { bridge, port } = await server();
  const root = mkdtempSync(join(tmpdir(), 'cmcp-route-'));
  try {
    await Fake.open(port, 'ext-meh', 'mehmood');
    await Fake.open(port, 'ext-muh', 'muhammad');
    const ex = new ExtensionExecutor(bridge);

    setActiveWorkspace(ensureWorkspace(root, 'mehmood', 'default', { createdAt: 'T0' }));
    assert.deepEqual(await ex.getText(), { from: 'ext-meh' });

    setActiveWorkspace(ensureWorkspace(root, 'muhammad', 'default', { createdAt: 'T0' }));
    assert.deepEqual(await ex.getText(), { from: 'ext-muh' });

    const st = ex.status();
    assert.equal(st.activeProfile, 'muhammad');
    assert.deepEqual(st.connectedProfiles?.sort(), ['mehmood', 'muhammad']);
  } finally {
    resetActiveWorkspaceForTesting();
    await bridge.stop();
  }
});
