import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js';
import { requireAccess, setAccessPollIntervalForTesting } from '../src/access';
import { createServer } from '../src/mcp/server';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function setup(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cmcp-access-'));
  const originalFetch = globalThis.fetch;
  const state = {
    status: 'pending', allowed: true, prompts: 0, starts: 0, polls: 0, validations: 0,
    notifications: [] as Array<{ data: { status: string; message: string } }>,
  };
  const server = {
    elicitInput: async () => {
      state.prompts++;
      return { action: 'accept', content: { email: 'user@example.com' } };
    },
    sendLoggingMessage: async (message: typeof state.notifications[number]) => { state.notifications.push(message); },
  } as unknown as Server;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/start')) {
      state.starts++;
      return Response.json({ status: 'pending' });
    }
    if (url.endsWith('/status')) {
      state.polls++;
      if (state.status === 'offline') throw new Error('offline');
      if (state.status === 'expired') return Response.json({}, { status: 410 });
      return Response.json({ status: state.status });
    }
    if (url.endsWith('/validate')) {
      state.validations++;
      return state.allowed ? Response.json({ authorized: true }) : Response.json({}, { status: 403 });
    }
    throw new Error('unexpected request ' + url);
  };
  setAccessPollIntervalForTesting(2, 500);
  const saved = () => JSON.parse(readFileSync(join(dataDir, 'access.json'), 'utf8')) as { verified?: boolean; challengeId?: string; deviceSecret: string };
  t.after(async () => {
    // Resolve any surviving watcher before restoring real network access.
    state.status = 'expired';
    if (existsSync(join(dataDir, 'access.json')) && saved().challengeId) await requireAccess(server, dataDir);
    globalThis.fetch = originalFetch;
    setAccessPollIntervalForTesting(2_000);
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { state, server, dataDir, saved };
}

test('the original call waits, receives verification, and caches access; revocation fails closed', async (t) => {
  const h = setup(t);
  const progress: ProgressNotification[] = [];
  let verified = false;
  let completed = false;
  const call = requireAccess(h.server, h.dataDir, {
    progressToken: 0,
    sendNotification: async (message) => { progress.push(message); },
    onVerified: () => { verified = true; },
  }).then((value) => { completed = true; return value; });
  await until(() => h.state.polls > 0);
  assert.equal(completed, false, 'sending an email must not finish the tool call');
  h.state.status = 'approved';
  assert.equal(await call, null);
  assert.equal(verified, true);
  assert.equal(h.saved().verified, true);
  assert.equal(h.saved().challengeId, undefined);
  if (process.platform !== 'win32') assert.equal(statSync(join(h.dataDir, 'access.json')).mode & 0o777, 0o600);
  assert.deepEqual(h.state.notifications.map((n) => n.data.status), ['pending', 'verified']);
  assert.match(progress.at(-1)!.params.message!, /Email verified/);
  assert.ok(progress.every((n, i) => n.params.progressToken === 0 && n.params.progress === i + 1));
  assert.equal(await requireAccess(h.server, h.dataDir), null);
  assert.equal(h.state.validations, 1);

  const realNow = Date.now;
  const future = realNow() + 60_001;
  Date.now = () => future;
  h.state.allowed = false;
  try {
    const denied = await requireAccess(h.server, h.dataDir);
    assert.match(denied!.content[0].text, /revoked/);
    assert.equal(h.saved().verified, false);
    assert.equal(h.state.prompts, 1);
  } finally { Date.now = realNow; }
});

test('expiry and denied grants return failure to the waiting call and notify the client', async (t) => {
  for (const status of ['expired', 'approved']) {
    await t.test(status, async (t) => {
      const h = setup(t);
      const call = requireAccess(h.server, h.dataDir);
      await until(() => h.state.polls > 0);
      h.state.status = status;
      h.state.allowed = false;
      const result = await call;
      assert.equal(result?.isError, true);
      assert.match(result!.content[0].text, status === 'expired' ? /expired/ : /did not grant access/);
      assert.notEqual(h.saved().verified, true);
      assert.equal(h.saved().challengeId, undefined);
      assert.equal(h.state.notifications.at(-1)?.data.status, status === 'expired' ? 'expired' : 'denied');
    });
  }
});

test('a bounded wait stays pending, reuses the email, and reports late background approval', async (t) => {
  const h = setup(t);
  setAccessPollIntervalForTesting(2, 20);
  const pending = await requireAccess(h.server, h.dataDir);
  assert.match(pending!.content[0].text, /ACCESS_PENDING/);
  assert.notEqual(h.saved().verified, true);
  h.state.status = 'approved';
  await until(() => h.state.notifications.some((n) => n.data.status === 'verified'));
  let verified = false;
  assert.equal(await requireAccess(h.server, h.dataDir, { onVerified: () => { verified = true; } }), null);
  assert.equal(verified, true, 'next call also carries the completion if the first wait ended');
  assert.equal(h.state.prompts, 1);
  assert.equal(h.state.starts, 1);
});

test('a follow-up wait reuses the active challenge and resumes when it is approved', async (t) => {
  const h = setup(t);
  setAccessPollIntervalForTesting(2, 20);
  await requireAccess(h.server, h.dataDir);
  setAccessPollIntervalForTesting(2, 500);
  const next = requireAccess(h.server, h.dataDir);
  h.state.status = 'approved';
  assert.equal(await next, null);
  assert.equal(h.state.starts, 1);
  assert.equal(h.state.prompts, 1);
});

test('expiry after a wait ends is reported on the next call before asking for another email', async (t) => {
  const h = setup(t);
  setAccessPollIntervalForTesting(2, 20);
  await requireAccess(h.server, h.dataDir);
  h.state.status = 'expired';
  await until(() => h.state.notifications.some((n) => n.data.status === 'expired'));
  assert.match((await requireAccess(h.server, h.dataDir))!.content[0].text, /expired/);
  assert.equal(h.state.prompts, 1);
});

test('cancelling one concurrent caller does not cancel another or run the cancelled action', async (t) => {
  const h = setup(t);
  const controller = new AbortController();
  const cancelled = requireAccess(h.server, h.dataDir, { signal: controller.signal });
  const ongoing = requireAccess(h.server, h.dataDir);
  await until(() => h.state.polls > 0);
  controller.abort();
  assert.match((await cancelled)!.content[0].text, /cancelled/);
  h.state.status = 'approved';
  assert.equal(await ongoing, null);
  assert.equal(h.state.prompts, 1);
});

test('network errors do not claim verification failed or succeeded, and recovery activates access', async (t) => {
  const h = setup(t);
  h.state.status = 'offline';
  setAccessPollIntervalForTesting(2, 20);
  const result = await requireAccess(h.server, h.dataDir);
  assert.match(result!.content[0].text, /service is unavailable/);
  assert.notEqual(h.saved().verified, true);
  h.state.status = 'approved';
  await until(() => h.state.notifications.some((n) => n.data.status === 'verified'));
  assert.equal(await requireAccess(h.server, h.dataDir), null);
});

test('notifications contain no email address, device secret, or challenge identifier', async (t) => {
  const h = setup(t);
  const call = requireAccess(h.server, h.dataDir);
  await until(() => h.state.polls > 0);
  const { deviceSecret, challengeId } = h.saved();
  h.state.status = 'approved';
  await call;
  const wire = JSON.stringify(h.state.notifications);
  assert.ok(!wire.includes('user@example.com'));
  assert.ok(!wire.includes(deviceSecret));
  assert.ok(!wire.includes(challengeId!));
});

test('a local verified flag cannot release a waiting tool without a valid server grant', async (t) => {
  const h = setup(t);
  const call = requireAccess(h.server, h.dataDir);
  await until(() => h.state.polls > 0);
  h.state.allowed = false;
  const state = h.saved();
  state.verified = true;
  delete state.challengeId;
  writeFileSync(join(h.dataDir, 'access.json'), JSON.stringify(state));
  assert.match((await call)!.content[0].text, /did not grant access/);
  assert.equal(h.saved().verified, false);
  assert.ok(h.state.validations > 0);
});

test('notification transport errors do not prevent verified access', async (t) => {
  const h = setup(t);
  h.server.sendLoggingMessage = async () => { throw new Error('client disconnected'); };
  h.state.status = 'approved';
  assert.equal(await requireAccess(h.server, h.dataDir, {
    progressToken: 'request-1', sendNotification: async () => { throw new Error('client disconnected'); },
  }), null);
  assert.equal(h.saved().verified, true);
});

test('a real MCP tool call receives progress, a verification notification, and its original browser result', async (t) => {
  const h = setup(t);
  resetManagerForTesting();
  const policy = resolvePolicy({ allowDomains: ['example.com'] });
  const executor = new StubExecutor({ activeUrl: 'https://example.com' });
  let browserCalls = 0;
  const tabsList = executor.tabsList.bind(executor);
  executor.tabsList = async () => { browserCalls++; return tabsList(); };
  configureManager({ policy, makeExecutor: () => executor });
  const server = createServer('test', policy, (server, _dir, request) => requireAccess(server, h.dataDir, request));
  const client = new Client({ name: 'verification-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { email: 'user@example.com' } }));
  const notifications: unknown[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (message) => { notifications.push(message.params.data); });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  const progress: string[] = [];
  try {
    assert.deepEqual(client.getServerCapabilities()?.logging, {});
    const call = client.callTool({ name: 'tabs_list', arguments: {} }, undefined, {
      onprogress: (value) => { if (value.message) progress.push(value.message); },
    });
    await until(() => h.state.polls > 0);
    assert.equal(browserCalls, 0, 'the browser cannot be used before verification');
    h.state.status = 'approved';
    const response = await call;
    assert.notEqual(response.isError, true);
    const content = response.content as Array<{ type: string; text: string }>;
    assert.match(content[0].text, /Email verified/);
    assert.match(content[1].text, /https:\/\/example.com/);
    assert.ok(browserCalls > 0);
    assert.ok(progress.some((message) => message.includes('Email verified')));
    assert.ok(notifications.some((value) => (value as { status?: string }).status === 'verified'));
  } finally {
    await client.close();
    await server.close();
    resetManagerForTesting();
  }
});
