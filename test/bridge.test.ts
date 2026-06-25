/**
 * Phase 2 verification — the bridge + auth, driven by a fake extension client.
 * Proves: token accept; wrong token / bad version → unauthorized + close 4401;
 * id-correlation under out-of-order concurrent replies; error-frame → reject;
 * per-request timeout rejects ONE call but keeps the socket; reject-all-on-close;
 * displacement (close 4000 + event); the handshake is written 0600; and the
 * token NEVER appears in any log line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { BridgeServer, type DisplacementInfo } from '../src/bridge/server';
import {
  generateToken,
  readHandshake,
  readPersistedToken,
  resolveToken,
  tokenPath,
  tokensMatch,
  writeHandshake,
  writePersistedToken,
} from '../src/bridge/auth';
import { CLOSE_SUPERSEDED, CLOSE_UNAUTHORIZED, PROTOCOL_VERSION } from '../shared/protocol';
import { ExecutorError } from '../src/executor/types';

const TOKEN = 'good-token-abc123';

interface ServerHarness {
  server: BridgeServer;
  port: number;
  logs: string[];
  displacements: DisplacementInfo[];
}

async function startServer(token = TOKEN): Promise<ServerHarness> {
  const logs: string[] = [];
  const displacements: DisplacementInfo[] = [];
  const server = new BridgeServer({
    token,
    serverVersion: 'test',
    port: 0,
    heartbeatMs: 0, // disable heartbeat noise
    onLog: (m) => logs.push(m),
    onDisplacement: (d) => displacements.push(d),
  });
  const port = await server.start();
  return { server, port, logs, displacements };
}

/** A minimal fake of the MV3 extension's WS client. */
class FakeExtension {
  onCommand: ((cmd: { id: string; method: string; params: Record<string, unknown> }) => void) | null = null;
  private welcomeResolve!: (v: Record<string, unknown>) => void;
  private unauthResolve!: (v: Record<string, unknown>) => void;
  readonly welcomed: Promise<Record<string, unknown>>;
  readonly unauthorized: Promise<Record<string, unknown>>;

  constructor(readonly ws: WebSocket) {
    this.welcomed = new Promise((r) => (this.welcomeResolve = r));
    this.unauthorized = new Promise((r) => (this.unauthResolve = r));
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'welcome') this.welcomeResolve(f);
      else if (f.type === 'unauthorized') this.unauthResolve(f);
      else if (f.type === 'command') this.onCommand?.(f);
      // ping ignored
    });
  }

  static async open(port: number): Promise<FakeExtension> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(ws, 'open');
    return new FakeExtension(ws);
  }

  hello(token: string, extId = 'ext-a', v: number = PROTOCOL_VERSION): void {
    this.ws.send(
      JSON.stringify({ type: 'hello', v, token, ext: { id: extId, version: '1.0.0', chrome: '123' } }),
    );
  }

  result(id: string, data: unknown): void {
    this.ws.send(JSON.stringify({ type: 'result', v: PROTOCOL_VERSION, id, ok: true, data }));
  }
  error(id: string, code: string, message: string): void {
    this.ws.send(JSON.stringify({ type: 'error', v: PROTOCOL_VERSION, id, ok: false, error: { code, message } }));
  }

  async waitClose(): Promise<number> {
    if (this.ws.readyState === this.ws.CLOSED) return 0;
    const [code] = (await once(this.ws, 'close')) as [number];
    return code;
  }
}

test('auth: handshake is written 0600 and round-trips; tokensMatch is exact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmcp-'));
  const token = generateToken();
  const path = writeHandshake(dir, { port: 38017, token });
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode & 0o077, 0, 'handshake must not be group/other accessible');
  const back = readHandshake(dir);
  assert.equal(back.token, token);
  assert.equal(back.v, PROTOCOL_VERSION);
  assert.ok(tokensMatch(token, back.token));
  assert.ok(!tokensMatch(token, token + 'x'));
});

test('correct token → welcome; hasActiveExtension true', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello(TOKEN);
    const welcome = await fe.welcomed;
    assert.equal(welcome.type, 'welcome');
    assert.ok(typeof welcome.sessionId === 'string');
    assert.equal(h.server.hasActiveExtension(), true);
  } finally {
    await h.server.stop();
  }
});

test('wrong token → unauthorized(bad_token) + close 4401', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello('the-wrong-token');
    const u = await fe.unauthorized;
    assert.equal(u.reason, 'bad_token');
    assert.equal(await fe.waitClose(), CLOSE_UNAUTHORIZED);
    assert.equal(h.server.hasActiveExtension(), false);
  } finally {
    await h.server.stop();
  }
});

test('bad protocol version → unauthorized(bad_version)', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello(TOKEN, 'ext-a', 999);
    const u = await fe.unauthorized;
    assert.equal(u.reason, 'bad_version');
  } finally {
    await h.server.stop();
  }
});

test('id-correlation holds under out-of-order concurrent replies', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello(TOKEN);
    await fe.welcomed;
    // Reply to each command after an inverse delay so replies arrive reversed.
    fe.onCommand = (cmd) => {
      const n = cmd.params.n as number;
      setTimeout(() => fe.result(cmd.id, { echoed: n }), (4 - n) * 25);
    };
    const results = await Promise.all([1, 2, 3].map((n) => h.server.sendCommand('eval', { n })));
    assert.deepEqual(results, [{ echoed: 1 }, { echoed: 2 }, { echoed: 3 }]);
  } finally {
    await h.server.stop();
  }
});

test('error frame rejects the call with an ExecutorError', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello(TOKEN);
    await fe.welcomed;
    fe.onCommand = (cmd) => fe.error(cmd.id, 'POLICY_DENIED', 'nope');
    await assert.rejects(h.server.sendCommand('get_text', {}), (e: unknown) => {
      assert.ok(e instanceof ExecutorError);
      assert.equal(e.code, 'POLICY_DENIED');
      return true;
    });
  } finally {
    await h.server.stop();
  }
});

test('per-request timeout rejects one call but keeps the socket alive', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello(TOKEN);
    await fe.welcomed;
    fe.onCommand = null; // ignore the first command → it times out
    await assert.rejects(h.server.sendCommand('get_text', {}, { timeoutMs: 100 }), (e: unknown) => {
      assert.ok(e instanceof ExecutorError);
      assert.equal(e.code, 'TIMEOUT');
      return true;
    });
    // Socket still works: a subsequent command resolves.
    fe.onCommand = (cmd) => fe.result(cmd.id, { ok: true });
    assert.deepEqual(await h.server.sendCommand('get_text', {}), { ok: true });
  } finally {
    await h.server.stop();
  }
});

test('disconnect rejects all pending with EXTENSION_DISCONNECTED', async () => {
  const h = await startServer();
  try {
    const fe = await FakeExtension.open(h.port);
    fe.hello(TOKEN);
    await fe.welcomed;
    fe.onCommand = null; // never reply
    const pending = h.server.sendCommand('navigate', { url: 'https://x.test' }, { timeoutMs: 5000 });
    fe.ws.close();
    await assert.rejects(pending, (e: unknown) => {
      assert.ok(e instanceof ExecutorError);
      assert.equal(e.code, 'EXTENSION_DISCONNECTED');
      return true;
    });
  } finally {
    await h.server.stop();
  }
});

test('a second valid client supersedes the first (close 4000 + displacement event)', async () => {
  const h = await startServer();
  try {
    const fe1 = await FakeExtension.open(h.port);
    fe1.hello(TOKEN, 'ext-a');
    await fe1.welcomed;

    const fe2 = await FakeExtension.open(h.port);
    fe2.hello(TOKEN, 'ext-b');
    await fe2.welcomed;

    assert.equal(await fe1.waitClose(), CLOSE_SUPERSEDED);
    assert.equal(h.server.hasActiveExtension(), true);
    assert.equal(h.displacements.length, 1);
    assert.deepEqual(h.displacements[0], { oldExtId: 'ext-a', newExtId: 'ext-b', differentId: true });
  } finally {
    await h.server.stop();
  }
});

test('FIX 7: a throwing onDisplacement callback does NOT crash the bridge', async () => {
  const logs: string[] = [];
  const server = new BridgeServer({
    token: TOKEN,
    serverVersion: 'test',
    port: 0,
    heartbeatMs: 0,
    onLog: (m) => logs.push(m),
    onDisplacement: () => {
      throw new Error('callback boom');
    },
  });
  const port = await server.start();
  try {
    const fe1 = await FakeExtension.open(port);
    fe1.hello(TOKEN, 'ext-a');
    await fe1.welcomed;

    // ext-b displaces ext-a, firing the throwing callback. The server must survive.
    const fe2 = await FakeExtension.open(port);
    fe2.hello(TOKEN, 'ext-b');
    await fe2.welcomed;

    assert.equal(await fe1.waitClose(), CLOSE_SUPERSEDED);
    assert.equal(server.hasActiveExtension(), true);

    // And the bridge still drives commands on the surviving connection.
    fe2.onCommand = (cmd) => fe2.result(cmd.id, { ok: true });
    assert.deepEqual(await server.sendCommand('get_text', {}), { ok: true });

    // The throw was swallowed + logged, and no secret leaked.
    assert.ok(logs.some((l) => /onDisplacement/i.test(l)), 'the swallowed throw is logged');
    assert.ok(!logs.some((l) => l.includes(TOKEN)), 'the token never appears in logs');
  } finally {
    await server.stop();
  }
});

test('the token never appears in any log line', async () => {
  const h = await startServer();
  try {
    const good = await FakeExtension.open(h.port);
    good.hello(TOKEN, 'ext-a');
    await good.welcomed;
    const bad = await FakeExtension.open(h.port);
    bad.hello(TOKEN + 'tampered');
    await bad.unauthorized;
    // Give logs a tick to flush.
    await new Promise((r) => setTimeout(r, 20));
    for (const line of h.logs) {
      assert.ok(!line.includes(TOKEN), `log leaked the token: ${line}`);
    }
    assert.ok(h.logs.length > 0, 'expected some diagnostics');
  } finally {
    await h.server.stop();
  }
});

test('token persistence: --persist-token reuses one stable token at 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-tok-'));
  delete process.env.CHROME_MCP_TOKEN;

  // First boot with persistence: mints + saves a token.
  const first = resolveToken(dir, { persist: true });
  assert.ok(first.length >= 32, 'expected a real token');
  assert.equal((statSync(tokenPath(dir)).mode & 0o077), 0, 'token file must be 0600');

  // Second boot with persistence: SAME token (no re-pair needed).
  const second = resolveToken(dir, { persist: true });
  assert.equal(second, first, 'persisted token must be stable across boots');
  assert.equal(readPersistedToken(dir), first);

  // Without persistence (the default): a fresh per-boot token, ignoring the file.
  const fresh = resolveToken(dir, { persist: false });
  assert.notEqual(fresh, first, 'default must be a fresh per-boot token');
});

test('token persistence: CHROME_MCP_TOKEN env pins the token and is never written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-tok-'));
  process.env.CHROME_MCP_TOKEN = '  pinned-token-xyz  ';
  try {
    assert.equal(resolveToken(dir, { persist: true }), 'pinned-token-xyz', 'env pin wins and is trimmed');
    assert.equal(readPersistedToken(dir), null, 'env-pinned token must not be persisted to disk');
  } finally {
    delete process.env.CHROME_MCP_TOKEN;
  }
});

test('token persistence: a group/other-readable token file fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-tok-'));
  writePersistedToken(dir, 'sometoken');
  chmodSync(tokenPath(dir), 0o644);
  assert.throws(() => readPersistedToken(dir), /group\/other-accessible/);
});

test('port conflict: a fixed port already in use surfaces a friendly, actionable error', async () => {
  const first = new BridgeServer({ token: TOKEN, serverVersion: 'test', port: 0, heartbeatMs: 0 });
  const port = await first.start();
  // A second server on the SAME fixed port can never bind (first never releases),
  // so after the wait window it must fail with the plain-English message — not EADDRINUSE.
  const second = new BridgeServer({ token: TOKEN, serverVersion: 'test', port, heartbeatMs: 0 });
  try {
    await assert.rejects(second.start(), (err: Error) => {
      assert.match(err.message, /another program is already using/i);
      assert.match(err.message, new RegExp(`:${port}`));
      assert.doesNotMatch(err.message, /EADDRINUSE/);
      return true;
    });
  } finally {
    await second.stop();
    await first.stop();
  }
});

test('port conflict: start retries and succeeds once the old listener releases the port', async () => {
  const first = new BridgeServer({ token: TOKEN, serverVersion: 'test', port: 0, heartbeatMs: 0 });
  const port = await first.start();
  const logs: string[] = [];
  const second = new BridgeServer({ token: TOKEN, serverVersion: 'test', port, heartbeatMs: 0, onLog: (m) => logs.push(m) });
  // Free the port shortly after the second server starts waiting; its retry loop should then bind.
  setTimeout(() => void first.stop(), 500);
  const boundPort = await second.start();
  try {
    assert.equal(boundPort, port, 'second server reclaims the same fixed port after the first releases it');
    assert.ok(logs.some((l) => /waiting for the previous instance/i.test(l)), 'logs the wait-and-retry');
  } finally {
    await second.stop();
  }
});
