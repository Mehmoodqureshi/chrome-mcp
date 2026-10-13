/**
 * Remote access: the key that guards it, the HTTP endpoint a client elsewhere
 * talks to, and reading the public URL out of cloudflared's output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { keyMatches, remoteKeyPath, resolveRemoteKey } from '../src/remote/key';
import { presentedKey, startHttpMcp } from '../src/remote/http';
import { findTunnelUrl } from '../src/remote/tunnel';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';
import { parseArgs } from '../src/config';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'chrome-mcp-remote-'));

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

test('the remote key is created once, private, and reused', () => {
  const dir = tmp();
  const key = resolveRemoteKey(dir);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(resolveRemoteKey(dir), key);
  if (process.platform !== 'win32') assert.equal(statSync(remoteKeyPath(dir)).mode & 0o777, 0o600);
});

test('rotating, or a malformed file, makes a new key', () => {
  const dir = tmp();
  const first = resolveRemoteKey(dir);
  const rotated = resolveRemoteKey(dir, { rotate: true });
  assert.notEqual(rotated, first);
  assert.equal(readFileSync(remoteKeyPath(dir), 'utf8').trim(), rotated);
  writeFileSync(remoteKeyPath(dir), 'short');
  assert.match(resolveRemoteKey(dir), /^[A-Za-z0-9_-]{43}$/);
});

test('keyMatches needs the exact key', () => {
  assert.equal(keyMatches('abc', 'abc'), true);
  assert.equal(keyMatches('abd', 'abc'), false);
  assert.equal(keyMatches('ab', 'abc'), false);
  assert.equal(keyMatches(undefined, 'abc'), false);
});

test('the key is read from the path or a Bearer header on /mcp, nowhere else', () => {
  assert.equal(presentedKey({ url: '/mcp/k1', headers: {} }), 'k1');
  assert.equal(presentedKey({ url: '/mcp/k1/?x=1', headers: {} }), 'k1');
  assert.equal(presentedKey({ url: '/mcp', headers: { authorization: 'Bearer k2' } }), 'k2');
  assert.equal(presentedKey({ url: '/other', headers: { authorization: 'Bearer k2' } }), undefined);
  assert.equal(presentedKey({ url: '/mcp', headers: {} }), undefined);
  assert.equal(presentedKey({ url: '/mcp/a/b', headers: {} }), undefined);
});

// ---------------------------------------------------------------------------
// Flags and the tunnel URL
// ---------------------------------------------------------------------------

test('--tunnel implies --http; --http-port sets the port', () => {
  const cfg = parseArgs(['--tunnel', '--http-port', '40001']);
  assert.equal(cfg.http, true);
  assert.equal(cfg.tunnel, true);
  assert.equal(cfg.httpPort, 40001);
  assert.equal(parseArgs([]).http, false);
});

test('findTunnelUrl picks the quick-tunnel URL out of cloudflared output', () => {
  const line = '2026-10-12T14:30:01Z INF |  https://brave-otter-sun-heater.trycloudflare.com                    |';
  assert.equal(findTunnelUrl(line), 'https://brave-otter-sun-heater.trycloudflare.com');
  assert.equal(findTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null);
  // Cloudflare's API host appears in error lines and must never be taken for the tunnel.
  assert.equal(
    findTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded'),
    null,
  );
});

// ---------------------------------------------------------------------------
// The HTTP endpoint, with a real MCP client
// ---------------------------------------------------------------------------

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'remote-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

test('a client with the key can list and call tools; without it, it gets nothing', async () => {
  resetManagerForTesting();
  const ex = new StubExecutor({ activeUrl: 'https://example.com' });
  const policy = resolvePolicy({ allowDomains: ['example.com'] });
  configureManager({ policy, makeExecutor: () => ex });
  const key = 'k'.repeat(43);
  const server = await startHttpMcp({ port: 0, key, version: 'test', policy, log: () => undefined });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const viaPath = await connect(`${base}/mcp/${key}`);
    const tools = await viaPath.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'tabs_list'));
    const res = await viaPath.callTool({ name: 'tabs_list', arguments: {} });
    assert.equal(res.isError, undefined);

    const viaHeader = await connect(`${base}/mcp`, { authorization: `Bearer ${key}` });
    assert.ok((await viaHeader.listTools()).tools.length > 0);
    assert.equal(server.sessions(), 2);
    await viaPath.close();
    await viaHeader.close();

    await assert.rejects(connect(`${base}/mcp/${'x'.repeat(43)}`));
    await assert.rejects(connect(`${base}/mcp`));
    const probe = await fetch(`${base}/`);
    assert.equal(probe.status, 404);
  } finally {
    await server.close();
  }
});
