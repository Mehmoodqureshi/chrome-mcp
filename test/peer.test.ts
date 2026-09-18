/**
 * Several chrome-mcp servers sharing one Chrome — one per Claude session.
 *   A. a second server on a busy port joins as a peer instead of killing the hub.
 *   B. a peer's commands are relayed through the hub to the browser.
 *   C. a peer sees the hub's paired browsers, and errors keep their codes.
 *   D. a peer with its own per-boot token joins with the hub's published one.
 *   E. when the hub stops, a peer takes the port over and the browser re-pairs.
 *   F. with two peers left behind, exactly one becomes the hub; the other joins it.
 *   G. a rename made through a peer lands on the hub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { BridgeServer } from '../src/bridge/server';
import { writeHandshake } from '../src/bridge/auth';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { ExecutorError } from '../src/executor/types';

const TOKEN = 'shared-token-abc123';

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as { port: number };
  await new Promise((r) => srv.close(r));
  return port;
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A fake extension that answers every command with `{ from: tag, method }`. */
async function extension(port: number, tag: string, profile?: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  const welcomed = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'welcome') resolve();
      else if (f.type === 'command') {
        ws.send(JSON.stringify({ type: 'result', v: PROTOCOL_VERSION, id: f.id, ok: true, data: { from: tag, method: f.method } }));
      }
    });
  });
  ws.send(JSON.stringify({
    type: 'hello', v: PROTOCOL_VERSION, token: TOKEN,
    ext: { id: 'ext', version: '1', chrome: '1' }, ...(profile ? { profile } : {}),
  }));
  await welcomed;
  return ws;
}

function bridge(port: number, opts: { token?: string; dataDir?: string } = {}): BridgeServer {
  return new BridgeServer({ token: opts.token ?? TOKEN, serverVersion: 't', port, heartbeatMs: 0, dataDir: opts.dataDir });
}

test('a second server on a busy port joins as a peer and relays through the hub', async () => {
  const port = await freePort();
  const hub = bridge(port);
  const peer = bridge(port);
  try {
    await hub.start();
    await extension(port, 'chrome', 'mehmood');
    assert.equal(await peer.start(), port);
    assert.equal(hub.role, 'hub');
    assert.equal(peer.role, 'peer');

    await until(() => peer.hasConnection('mehmood'));
    assert.deepEqual(peer.connectedProfiles(), ['mehmood']);
    assert.deepEqual(await peer.sendCommand('get_text', {}, { profile: 'mehmood' }), { from: 'chrome', method: 'get_text' });
    // The hub keeps working for its own session at the same time.
    assert.deepEqual(await hub.sendCommand('tabs_list', {}, { profile: 'mehmood' }), { from: 'chrome', method: 'tabs_list' });
  } finally {
    await peer.stop();
    await hub.stop();
  }
});

test('a relayed failure keeps its error code and message', async () => {
  const port = await freePort();
  const hub = bridge(port);
  const peer = bridge(port);
  try {
    await hub.start();
    await peer.start();
    await assert.rejects(
      peer.sendCommand('get_text', {}, { profile: 'nobody' }),
      (e: unknown) => e instanceof ExecutorError && e.code === 'EXTENSION_DISCONNECTED' && /profile "nobody"/.test(e.message),
    );
  } finally {
    await peer.stop();
    await hub.stop();
  }
});

test('a peer with its own per-boot token joins using the hub\'s published one', async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-peer-'));
  const hub = bridge(port, { token: TOKEN, dataDir });
  const peer = bridge(port, { token: 'a-different-fresh-token', dataDir });
  try {
    await hub.start();
    // The handshake a hub publishes names our pid; pretend it's another process.
    writeHandshake(dataDir, { port, token: TOKEN });
    const { readFileSync, writeFileSync } = await import('node:fs');
    const path = join(dataDir, 'handshake.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pid: process.pid + 1 }), { mode: 0o600 });

    await peer.start();
    assert.equal(peer.role, 'peer');
  } finally {
    await peer.stop();
    await hub.stop();
  }
});

test('when the hub stops, the peer takes the port over and the browser re-pairs', async () => {
  const port = await freePort();
  const hub = bridge(port);
  const peer = bridge(port);
  try {
    await hub.start();
    await peer.start();
    await hub.stop();

    await until(() => peer.role === 'hub');
    // The extension redials the same port with the same token.
    await extension(port, 'chrome-again', 'mehmood');
    assert.deepEqual(await peer.sendCommand('get_text', {}, { profile: 'mehmood' }), { from: 'chrome-again', method: 'get_text' });
  } finally {
    await peer.stop();
    await hub.stop();
  }
});

test('with two peers left behind, one becomes the hub and the other joins it', async () => {
  const port = await freePort();
  const hub = bridge(port);
  const a = bridge(port);
  const b = bridge(port);
  try {
    await hub.start();
    await a.start();
    await b.start();
    await hub.stop();

    await until(() => a.role !== null && b.role !== null && (a.role === 'hub') !== (b.role === 'hub'));
    const [newHub, other] = a.role === 'hub' ? [a, b] : [b, a];
    assert.equal(other.role, 'peer');
    await extension(port, 'chrome', 'work');
    await until(() => other.hasConnection('work'));
    assert.deepEqual(await other.sendCommand('get_text', {}, { profile: 'work' }), { from: 'chrome', method: 'get_text' });
    void newHub;
  } finally {
    await a.stop();
    await b.stop();
    await hub.stop();
  }
});

test('a rename made through a peer lands on the hub', async () => {
  const port = await freePort();
  const hub = bridge(port);
  const peer = bridge(port);
  try {
    await hub.start();
    await peer.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    ws.send(JSON.stringify({
      type: 'hello', v: PROTOCOL_VERSION, token: TOKEN,
      ext: { id: 'ext', version: '1', chrome: '1' }, installId: 'aaaaaaaa-1111-4111-8111-111111111111',
    }));
    await until(() => hub.hasConnection('default'));

    assert.equal(await peer.renameProfile('default', 'work'), 'work');
    assert.deepEqual(hub.connectedProfiles(), ['work']);
    await until(() => peer.hasConnection('work'));
    await assert.rejects(peer.renameProfile('nobody', 'x'), /not an automatically named/);
  } finally {
    await peer.stop();
    await hub.stop();
  }
});
