/**
 * Automatic profile names — a browser that leaves Profile blank is named by the
 * server from its installId, so a second blank-profile Chrome joins instead of
 * superseding the first.
 *   A. two blank-profile installs → "default" and "profile-2", both live.
 *   B. the same install re-pairing keeps its name (and supersedes only itself).
 *   C. names persist across a server restart via profiles.json.
 *   D. a Profile typed in Options wins over the registry.
 *   E. an extension too old to send an installId still pairs as "default".
 *   F. renameProfile re-keys a live auto-named browser and persists.
 *   G. renameProfile refuses Options-named profiles and taken names.
 *   H. welcome carries the assigned name; chrome_status lists how each was named.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { BridgeServer } from '../src/bridge/server';
import { ProfileRegistry, REGISTRY_FILE } from '../src/bridge/profiles';
import { PROTOCOL_VERSION } from '../shared/protocol';

const TOKEN = 'good-token-abc123';
const ID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const ID_C = 'cccccccc-3333-4333-8333-333333333333';

/** A fake extension that answers every command with `{ from: tag }`. */
class Fake {
  pairedAs = '';
  private welcomeResolve!: () => void;
  readonly welcomed: Promise<void>;
  constructor(readonly ws: WebSocket, readonly tag: string) {
    this.welcomed = new Promise((r) => (this.welcomeResolve = r));
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'welcome') {
        this.pairedAs = f.profile;
        this.welcomeResolve();
      } else if (f.type === 'command') {
        ws.send(JSON.stringify({ type: 'result', v: PROTOCOL_VERSION, id: f.id, ok: true, data: { from: this.tag } }));
      }
    });
  }
  static async open(port: number, tag: string, opts: { installId?: string; profile?: string } = {}): Promise<Fake> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    const fake = new Fake(ws, tag);
    ws.send(JSON.stringify({
      type: 'hello', v: PROTOCOL_VERSION, token: TOKEN,
      ext: { id: 'same-unpacked-id', version: '1', chrome: '1' }, ...opts,
    }));
    await fake.welcomed;
    return fake;
  }
  async waitClose(): Promise<number> {
    if (this.ws.readyState === this.ws.CLOSED) return 0;
    const [code] = (await once(this.ws, 'close')) as [number];
    return code;
  }
}

async function server(dataDir?: string): Promise<{ bridge: BridgeServer; port: number }> {
  const bridge = new BridgeServer({ token: TOKEN, serverVersion: 't', port: 0, heartbeatMs: 0, dataDir });
  const port = await bridge.start();
  return { bridge, port };
}

test('two blank-profile installs get "default" and "profile-2", both stay paired', async () => {
  const { bridge, port } = await server();
  try {
    const a = await Fake.open(port, 'A', { installId: ID_A });
    const b = await Fake.open(port, 'B', { installId: ID_B });
    assert.equal(a.pairedAs, 'default');
    assert.equal(b.pairedAs, 'profile-2');
    assert.deepEqual(bridge.connectedProfiles().sort(), ['default', 'profile-2']);
    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'default' }), { from: 'A' });
    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'profile-2' }), { from: 'B' });
  } finally {
    await bridge.stop();
  }
});

test('the same install re-pairing keeps its name and supersedes only itself', async () => {
  const { bridge, port } = await server();
  try {
    const a1 = await Fake.open(port, 'A1', { installId: ID_A });
    await Fake.open(port, 'B', { installId: ID_B });
    const a2 = await Fake.open(port, 'A2', { installId: ID_A });
    assert.equal(a2.pairedAs, 'default');
    assert.equal(await a1.waitClose(), 4000 /* CLOSE_SUPERSEDED */);
    assert.deepEqual(bridge.connectedProfiles().sort(), ['default', 'profile-2']);
    assert.deepEqual(await bridge.sendCommand('get_text', {}, { profile: 'profile-2' }), { from: 'B' });
  } finally {
    await bridge.stop();
  }
});

test('names persist across a server restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-autoprof-'));
  const first = await server(dir);
  await Fake.open(first.port, 'A', { installId: ID_A });
  await Fake.open(first.port, 'B', { installId: ID_B });
  await first.bridge.stop();

  const second = await server(dir);
  try {
    // B comes back first this time and must still be profile-2, not default.
    const b = await Fake.open(second.port, 'B', { installId: ID_B });
    assert.equal(b.pairedAs, 'profile-2');
    const saved = JSON.parse(readFileSync(join(dir, REGISTRY_FILE), 'utf8'));
    assert.equal(saved.installs[ID_A].name, 'default');
  } finally {
    await second.bridge.stop();
  }
});

test('a Profile typed in Options wins, and auto naming steps around it', async () => {
  const { bridge, port } = await server();
  try {
    const typed = await Fake.open(port, 'T', { installId: ID_A, profile: 'default' });
    const auto = await Fake.open(port, 'B', { installId: ID_B });
    assert.equal(typed.pairedAs, 'default');
    assert.equal(auto.pairedAs, 'profile-2'); // "default" is held live by another install
    const named = await Fake.open(port, 'C', { installId: ID_C, profile: 'work' });
    assert.equal(named.pairedAs, 'work');
  } finally {
    await bridge.stop();
  }
});

test('an extension without an installId still pairs as "default"', async () => {
  const { bridge, port } = await server();
  try {
    const old = await Fake.open(port, 'OLD');
    assert.equal(old.pairedAs, 'default');
    assert.deepEqual(bridge.pairedProfiles(), [{ name: 'default', naming: 'legacy' }]);
  } finally {
    await bridge.stop();
  }
});

test('renameProfile re-keys a live auto-named browser and the name sticks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-autoprof-'));
  const first = await server(dir);
  try {
    await Fake.open(first.port, 'A', { installId: ID_A });
    await Fake.open(first.port, 'B', { installId: ID_B });
    assert.equal(await first.bridge.renameProfile('profile-2', 'work'), 'work');
    assert.deepEqual(first.bridge.connectedProfiles().sort(), ['default', 'work']);
    assert.deepEqual(await first.bridge.sendCommand('get_text', {}, { profile: 'work' }), { from: 'B' });
  } finally {
    await first.bridge.stop();
  }
  const second = await server(dir);
  try {
    const b = await Fake.open(second.port, 'B', { installId: ID_B });
    assert.equal(b.pairedAs, 'work');
    // The freed name is reusable by a brand-new install.
    const c = await Fake.open(second.port, 'C', { installId: ID_C });
    assert.equal(c.pairedAs, 'profile-2');
  } finally {
    await second.bridge.stop();
  }
});

test('renameProfile refuses Options-named profiles and names already taken', async () => {
  const { bridge, port } = await server();
  try {
    await Fake.open(port, 'A', { installId: ID_A });
    await Fake.open(port, 'B', { installId: ID_B });
    await Fake.open(port, 'W', { installId: ID_C, profile: 'work' });
    await assert.rejects(bridge.renameProfile('work', 'home'), /extension Options/);
    await assert.rejects(bridge.renameProfile('profile-2', 'default'), /already/);
    await assert.rejects(bridge.renameProfile('profile-2', 'work'), /already/);
    await assert.rejects(bridge.renameProfile('nobody', 'x'), /not an automatically named/);
  } finally {
    await bridge.stop();
  }
});

test('pairedProfiles reports how each browser was named', async () => {
  const { bridge, port } = await server();
  try {
    await Fake.open(port, 'A', { installId: ID_A });
    await Fake.open(port, 'W', { installId: ID_B, profile: 'work' });
    const byName = Object.fromEntries(bridge.pairedProfiles().map((p) => [p.name, p.naming]));
    assert.deepEqual(byName, { default: 'auto', work: 'options' });
  } finally {
    await bridge.stop();
  }
});

test('registry ignores a corrupt or hostile profiles.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-autoprof-'));
  writeFileSync(join(dir, REGISTRY_FILE), '{"installs":{"../../x":{"name":"evil"}}}');
  const reg = new ProfileRegistry(dir);
  assert.equal(reg.ownerOf('evil'), undefined);
  assert.equal(reg.assign(ID_A, () => false), 'default');
});
