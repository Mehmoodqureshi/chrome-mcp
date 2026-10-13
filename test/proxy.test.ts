/**
 * The per-profile proxy: parsing what the Options page saves, and the
 * read-only `proxy_status` tool the agent uses to check the exit IP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseProxyConfig, parseProxyLine } from '../shared/proxy';
import type { ProxyWireStatus } from '../shared/protocol';
import { dispatchToolCall } from '../src/mcp/tools';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor, type StubOptions } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';

function configure(stub: StubOptions = {}): void {
  resetManagerForTesting();
  const ex = new StubExecutor(stub);
  configureManager({ policy: resolvePolicy({}), makeExecutor: () => ex });
}

function textOf(r: CallToolResult): string {
  const block = r.content.find((c) => c.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

const ON: ProxyWireStatus = {
  enabled: true,
  server: 'http://proxy.example.net:8000',
  auth: true,
  control: 'controlled_by_this_extension',
  webrtcProtected: true,
  exitIp: '203.0.113.7',
  country: 'DE',
  city: 'Berlin',
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parseProxyConfig keeps a valid setting and rejects a missing host or bad port', () => {
  assert.deepEqual(parseProxyConfig({ enabled: true, scheme: 'socks5', host: ' 1.2.3.4 ', port: '1080' }), {
    enabled: true,
    scheme: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    username: '',
    password: '',
  });
  assert.equal(parseProxyConfig({ host: '', port: 8080 }), null);
  assert.equal(parseProxyConfig({ host: 'p.example', port: 0 }), null);
  assert.equal(parseProxyConfig({ host: 'p.example', port: 70000 }), null);
  assert.equal(parseProxyConfig(null), null);
});

test('parseProxyConfig defaults an unknown scheme to http and never enables by accident', () => {
  const cfg = parseProxyConfig({ scheme: 'ftp', host: 'p.example', port: 8080, enabled: 'yes' });
  assert.equal(cfg?.scheme, 'http');
  assert.equal(cfg?.enabled, false);
});

test('parseProxyLine splits the provider one-liners, keeping colons in the password', () => {
  assert.deepEqual(parseProxyLine('p.example:8080'), { host: 'p.example', port: 8080 });
  assert.deepEqual(parseProxyLine('http://p.example:8080:alice:s3:cr:et'), {
    scheme: 'http',
    host: 'p.example',
    port: 8080,
    username: 'alice',
    password: 's3:cr:et',
  });
  assert.equal(parseProxyLine('p.example'), null);
  assert.equal(parseProxyLine('p.example:http'), null);
  assert.equal(parseProxyLine('p.example:99999'), null);
});

// ---------------------------------------------------------------------------
// proxy_status
// ---------------------------------------------------------------------------

test('proxy_status reports the exit IP and works under the deny-all default policy', async () => {
  configure({ proxy: ON });
  const res = await dispatchToolCall('proxy_status', {});
  assert.equal(res.isError, undefined);
  const body = JSON.parse(textOf(res)) as ProxyWireStatus & { hint?: string };
  assert.equal(body.exitIp, '203.0.113.7');
  assert.equal(body.country, 'DE');
  assert.equal(body.hint, undefined);
});

test('proxy_status says when no proxy is set, when it is overridden, and when it is down', async () => {
  configure({ proxy: { ...ON, enabled: false, server: null, auth: false } });
  assert.match(textOf(await dispatchToolCall('proxy_status', {})), /real IP/);

  configure({ proxy: { ...ON, control: 'controlled_by_other_extensions' } });
  assert.match(textOf(await dispatchToolCall('proxy_status', {})), /overrides the proxy/);

  configure({ proxy: { ...ON, exitIp: null, error: 'net::ERR_PROXY_CONNECTION_FAILED' } });
  assert.match(textOf(await dispatchToolCall('proxy_status', {})), /unreachable/);
});

test('proxy_status on a backend without proxy support is a clear error', async () => {
  configure();
  const res = await dispatchToolCall('proxy_status', {});
  assert.equal(res.isError, true);
  assert.match(textOf(res), /no proxy setting/);
});
