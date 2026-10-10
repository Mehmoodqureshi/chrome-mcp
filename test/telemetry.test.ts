/**
 * Anonymous usage statistics from the server.
 *   A. off by CHROME_MCP_TELEMETRY=0/false/off, DO_NOT_TRACK=1, --no-telemetry, or no key.
 *   B. the install id is random, persisted, and the notice shows only once.
 *   C. a summary carries counts and error codes — never args, URLs or content.
 *   D. an idle session sends no summary; a failing send never throws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  errorCodeOf,
  initTelemetry,
  noteToolCall,
  resetTelemetryForTesting,
  stopTelemetry,
  telemetryDisabled,
} from '../src/telemetry';

type Sent = { event: string; distinct_id: string; properties: Record<string, unknown> };

function start(env: NodeJS.ProcessEnv = {}, extra: { dataDir?: string; disabledByFlag?: boolean; key?: string } = {}) {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const dataDir = extra.dataDir ?? mkdtempSync(join(tmpdir(), 'cmcp-tel-'));
  const on = initTelemetry({
    dataDir,
    version: '9.9.9',
    env,
    key: extra.key ?? 'phc_test',
    disabledByFlag: extra.disabledByFlag,
    log: (m) => logs.push(m),
    send: async (batch) => void sent.push(...(batch as Sent[])),
    context: () => ({ role: 'hub', browsers: 2 }),
  });
  return { on, sent, logs, dataDir };
}

test('telemetry is off by env, flag, or a missing key', () => {
  for (const v of ['0', 'false', 'off', 'OFF', 'no']) assert.ok(telemetryDisabled({ CHROME_MCP_TELEMETRY: v }), v);
  assert.ok(telemetryDisabled({ DO_NOT_TRACK: '1' }));
  assert.ok(telemetryDisabled({ DO_NOT_TRACK: 'true' }));
  assert.equal(telemetryDisabled({ DO_NOT_TRACK: '0' }), false);
  assert.equal(telemetryDisabled({}), false);
  assert.ok(telemetryDisabled({}, true));

  assert.equal(start({ CHROME_MCP_TELEMETRY: '0' }).on, false);
  assert.equal(start({}, { disabledByFlag: true }).on, false);
  assert.equal(start({}, { key: '' }).on, false);
  resetTelemetryForTesting();
});

test('install id persists and the notice shows only on first run', async () => {
  const first = start();
  assert.equal(first.logs.length, 1);
  assert.match(first.logs[0], /CHROME_MCP_TELEMETRY=0/);
  const id = JSON.parse(readFileSync(join(first.dataDir, 'telemetry.json'), 'utf8')).installId;
  assert.match(id, /^[0-9a-f-]{36}$/);
  await stopTelemetry();

  const second = start({}, { dataDir: first.dataDir });
  assert.equal(second.logs.length, 0);
  assert.equal(second.sent[0].distinct_id, id);
  await stopTelemetry();
});

test('a summary carries counts and error codes, never arguments or URLs', async () => {
  const { sent } = start();
  noteToolCall('navigate', true);
  noteToolCall('navigate', false, '[POLICY_DENIED] https://secret.example.com/private?token=abc is not allowlisted');
  noteToolCall('get_text', true);
  await stopTelemetry();

  // The per-call MCP Analytics events ride along in the same final batch.
  assert.deepEqual(
    sent.map((e) => e.event),
    ['session_started', '$mcp_tool_call', '$mcp_tool_call', '$mcp_tool_call', 'usage_summary', 'session_ended'],
  );
  const summary = sent.find((e) => e.event === 'usage_summary')!.properties;
  assert.equal(summary.calls, 3);
  assert.equal(summary.errors, 1);
  assert.deepEqual(summary.tools, { navigate: { calls: 2, errors: 1 }, get_text: { calls: 1, errors: 0 } });
  assert.deepEqual(summary.error_codes, { POLICY_DENIED: 1 });
  assert.equal(summary.role, 'hub');
  assert.equal(summary.browsers, 2);
  assert.equal(summary.$process_person_profile, false);
  assert.equal(summary.$geoip_disable, true);
  const everything = JSON.stringify(sent);
  assert.doesNotMatch(everything, /secret\.example|token=abc|private/);
});

test('an idle session sends no summary, and a failing send never throws', async () => {
  const { sent } = start();
  await stopTelemetry();
  assert.deepEqual(sent.map((e) => e.event), ['session_started', 'session_ended']);

  initTelemetry({
    dataDir: mkdtempSync(join(tmpdir(), 'cmcp-tel-')),
    version: '1',
    env: {},
    key: 'phc_test',
    send: async () => {
      throw new Error('offline');
    },
  });
  noteToolCall('click', true);
  await assert.doesNotReject(stopTelemetry());
});

test('stopping right after start still delivers session_started', async () => {
  const delivered: string[] = [];
  initTelemetry({
    dataDir: mkdtempSync(join(tmpdir(), 'cmcp-tel-')),
    version: '1',
    env: {},
    key: 'phc_test',
    // A slow network: session_started is still in flight when stop() is called.
    send: (batch) => new Promise((r) => setTimeout(() => r(void delivered.push(...batch.map((e) => e.event))), 50)),
  });
  await stopTelemetry();
  assert.deepEqual(delivered.sort(), ['session_ended', 'session_started']);
});

test('errorCodeOf reads the [CODE] prefix', () => {
  assert.equal(errorCodeOf('[TAB_NOT_FOUND] no tab'), 'TAB_NOT_FOUND');
  assert.equal(errorCodeOf('internal error: boom'), 'OTHER');
  assert.equal(errorCodeOf(undefined), 'OTHER');
});

test('each call becomes a $mcp_tool_call for MCP Analytics, with no arguments, results or messages', async () => {
  resetTelemetryForTesting();
  const sent: Sent[] = [];
  initTelemetry({
    dataDir: mkdtempSync(join(tmpdir(), 'cmcp-tel-')),
    version: '9.9.9',
    env: {},
    key: 'phc_test',
    send: async (batch) => void sent.push(...(batch as Sent[])),
    client: () => ({ name: 'claude-code', version: '2.1.0' }),
    delaysMs: { mcpFlush: 20 },
  });
  noteToolCall('get_text', true, undefined, 42);
  noteToolCall('navigate', false, '[POLICY_DENIED] Blocked: "navigate" can\'t run on secret.example.com', 7);
  await new Promise((r) => setTimeout(r, 80));
  const calls = sent.filter((e) => e.event === '$mcp_tool_call');
  assert.equal(calls.length, 2);
  const [ok, bad] = calls.map((e) => e.properties);
  assert.equal(ok.$mcp_source, 'posthog_mcp_analytics');
  assert.equal(ok.$mcp_tool_name, 'get_text');
  assert.equal(ok.$mcp_duration_ms, 42);
  assert.equal(ok.$mcp_is_error, false);
  assert.equal(ok.$mcp_client_name, 'claude-code');
  assert.equal(ok.$mcp_server_version, '9.9.9');
  assert.match(String(ok.$session_id), /^ses_[0-9a-f]{32}$/);
  assert.equal(bad.$mcp_is_error, true);
  assert.equal(bad.$mcp_error_type, 'POLICY_DENIED');
  const wire = JSON.stringify(calls);
  assert.ok(!wire.includes('secret.example.com'), 'never the error message');
  for (const k of ['$mcp_parameters', '$mcp_response', '$mcp_error_message']) assert.ok(!wire.includes(k));
  await stopTelemetry();
});
