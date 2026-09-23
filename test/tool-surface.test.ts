/**
 * The advertised tool surface: the `--tools` allowlist (what is listed, what is
 * callable, what a typo does) and a byte budget on the `tools/list` payload,
 * which every connected host re-sends to the model on every turn.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  TOOL_NAMES,
  disabledCapabilities,
  dispatchToolCall,
  enabledToolNames,
  isToolEnabled,
  isToolPolicyUsable,
  setToolAllowlist,
} from '../src/mcp/tools';
import { createServer } from '../src/mcp/server';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy, type Policy } from '../src/security/policy';
import { parseArgs } from '../src/config';

const OPEN = { allowDomains: ['*'], enableMutations: true, allowEval: true };

function configure(): void {
  resetManagerForTesting();
  configureManager({ policy: resolvePolicy(OPEN), makeExecutor: () => new StubExecutor() });
}

/** Every text block, joined — `batch` reports each op's error in its own block. */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
}

/** Every tool the server advertises over a real MCP `tools/list`. */
async function listTools(policy?: Policy): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  const server = createServer('test', policy);
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  try {
    const res = await client.listTools();
    return res.tools as Array<{ name: string; description?: string; inputSchema: unknown }>;
  } finally {
    await client.close();
    await server.close();
  }
}

test('no allowlist: the whole catalog is advertised and callable', () => {
  setToolAllowlist(null);
  assert.deepEqual([...enabledToolNames()], [...TOOL_NAMES]);
  assert.equal(isToolEnabled('click'), true);
  assert.equal(isToolEnabled('upload_file'), true);
});

test('--tools hides everything else from tools/list', async () => {
  setToolAllowlist(['tabs_list', 'navigate', 'get_text']);
  try {
    const tools = await listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['get_text', 'navigate', 'tabs_list'],
    );
  } finally {
    setToolAllowlist(null);
  }
});

test('an excluded tool is refused, not silently dispatched', async () => {
  configure();
  setToolAllowlist(['tabs_list']);
  try {
    const res = await dispatchToolCall('eval', { expression: '1+1' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /not enabled on this server \(--tools\)/);
    assert.match(textOf(res), /eval/);
  } finally {
    setToolAllowlist(null);
  }
});

test('batch cannot reach a tool kept off the surface', async () => {
  configure();
  setToolAllowlist(['batch', 'tabs_list']);
  try {
    const res = await dispatchToolCall('batch', {
      ops: [{ tool: 'tabs_list' }, { tool: 'eval', args: { expression: '1+1' } }],
      mode: 'serial',
    });
    const body = textOf(res);
    assert.match(body, /not enabled on this server \(--tools\): eval/);
    // The allowlisted op in the same batch still ran.
    assert.match(body, /"tool": "tabs_list",\n\s*"status": "ok"/);
  } finally {
    setToolAllowlist(null);
  }
});

test('a typo in --tools fails loudly and names the catalog', () => {
  assert.throws(() => setToolAllowlist(['navigate', 'clcik']), /unknown tool "clcik"/);
  assert.throws(() => setToolAllowlist(['clcik']), /Known tools: /);
  // A failed call leaves the previous surface untouched.
  assert.equal(isToolEnabled('upload_file'), true);
});

test('parseArgs: --tools is repeatable, comma-separated, deduped', () => {
  assert.equal(parseArgs([]).tools, undefined);
  assert.deepEqual(parseArgs(['--tools', 'navigate,get_text']).tools, ['navigate', 'get_text']);
  assert.deepEqual(
    parseArgs(['--tools', 'navigate', '--tools', 'get_text,navigate']).tools,
    ['navigate', 'get_text'],
  );
  assert.throws(() => parseArgs(['--tools', ' , ']), /requires at least one tool name/);
});

test('tools/list stays within its byte budget', async () => {
  setToolAllowlist(null);
  const tools = await listTools();
  const bytes = Buffer.byteLength(JSON.stringify(tools));
  // 0.9.3 shipped 32747 B (~8.2k tokens) for 39 tools. This budget is a ratchet:
  // it is the cost paid on EVERY turn by every host with this server connected,
  // so a new tool or a wordier field description has to be worth its bytes.
  assert.ok(
    bytes <= 28_000,
    `tools/list is ${bytes} B for ${tools.length} tools, over the 28000 B budget`,
  );
});

// ---------------------------------------------------------------------------
// Policy-filtered catalog
// ---------------------------------------------------------------------------

/** The six tools whose capability is off under the default deny-all policy. */
const CAPABILITY_TOOLS = ['eval', 'download_file', 'upload_file', 'console_logs', 'network_log', 'dialogs'];

test('no policy passed: the whole catalog is advertised (back-compat)', async () => {
  const tools = await listTools();
  assert.equal(tools.length, TOOL_NAMES.length);
});

test('a capability that is off drops its tools from tools/list', async () => {
  // Domains open and mutations on, but every optional capability off — the
  // shape of the README's own recommended command line.
  const policy = resolvePolicy({ allowDomains: ['*'], enableMutations: true });
  const names = (await listTools(policy)).map((t) => t.name);
  for (const n of CAPABILITY_TOOLS) {
    assert.equal(names.includes(n), false, `${n} should not be advertised when its capability is off`);
  }
  // The tools that DO work are all still there.
  assert.equal(names.includes('click'), true);
  assert.equal(names.includes('get_text'), true);
  assert.equal(names.includes('batch'), true);
});

test('turning a capability on brings its tools back', async () => {
  const open = resolvePolicy({
    allowDomains: ['*'],
    enableMutations: true,
    allowEval: true,
    allowDownloads: true,
    allowUploads: true,
    allowObservers: true,
  });
  const names = (await listTools(open)).map((t) => t.name);
  for (const n of CAPABILITY_TOOLS) {
    assert.equal(names.includes(n), true, `${n} should be advertised once its capability is on`);
  }
  assert.equal(names.length, TOOL_NAMES.length);
});

test('mutations off drops the acting tools but keeps the reads', async () => {
  const readOnly = resolvePolicy({ allowDomains: ['*'] });
  const names = (await listTools(readOnly)).map((t) => t.name);
  for (const n of ['click', 'type', 'navigate', 'tab_new', 'fill_form', 'scroll']) {
    assert.equal(names.includes(n), false, `${n} is mutating and should be hidden`);
  }
  for (const n of ['get_text', 'get_html', 'snapshot', 'tabs_list', 'chrome_status']) {
    assert.equal(names.includes(n), true, `${n} is a read and should stay`);
  }
});

test('an empty domain allowlist does NOT hide tools', async () => {
  // Deliberate: a domain is per-page, so another tab may well be allowlisted.
  // Only absolute capability gates prune the catalog.
  const policy = resolvePolicy({ enableMutations: true });
  const names = (await listTools(policy)).map((t) => t.name);
  assert.equal(names.includes('get_text'), true);
  assert.equal(names.includes('click'), true);
});

test('isToolPolicyUsable matches what tools/list advertises', async () => {
  const policy = resolvePolicy({ allowDomains: ['*'], enableMutations: true });
  const advertised = new Set((await listTools(policy)).map((t) => t.name));
  for (const n of TOOL_NAMES) {
    assert.equal(
      isToolPolicyUsable(n, policy),
      advertised.has(n),
      `${n}: predicate and advertised catalog disagree`,
    );
  }
});

test('the filtered catalog is meaningfully smaller', async () => {
  const full = Buffer.byteLength(JSON.stringify(await listTools()));
  const policy = resolvePolicy({ allowDomains: ['*'], enableMutations: true });
  const filtered = Buffer.byteLength(JSON.stringify(await listTools(policy)));
  assert.ok(
    filtered < full * 0.9,
    `expected the filtered catalog to save >10%; full ${full} B, filtered ${filtered} B`,
  );
});

// ---------------------------------------------------------------------------
// chrome_status names what the policy switched off
// ---------------------------------------------------------------------------

test('disabledCapabilities: default policy names every flag and the tools it hides', () => {
  setToolAllowlist(null);
  const off = disabledCapabilities(resolvePolicy({}));
  const byCap = new Map(off.map((c) => [c.capability, c]));
  assert.deepEqual([...byCap.keys()], ['mutations', 'eval', 'downloads', 'uploads', 'observers']);
  const mutations = byCap.get('mutations')!;
  assert.equal(mutations.flag, '--enable-mutations');
  for (const n of ['navigate', 'click', 'type', 'fill_form', 'tab_new']) {
    assert.equal(mutations.hiddenTools.includes(n), true, `${n} should be listed under mutations`);
  }
  assert.deepEqual(byCap.get('observers')!.hiddenTools, ['console_logs', 'network_log', 'dialogs']);
});

test('disabledCapabilities agrees with what tools/list hides', async () => {
  setToolAllowlist(null);
  const policy = resolvePolicy({ allowDomains: ['*'] });
  const advertised = new Set((await listTools(policy)).map((t) => t.name));
  const listed = disabledCapabilities(policy).flatMap((c) => c.hiddenTools);
  assert.deepEqual(
    listed.sort(),
    TOOL_NAMES.filter((n) => !advertised.has(n)).sort(),
  );
});

test('disabledCapabilities: everything on reports nothing', () => {
  setToolAllowlist(null);
  const open = resolvePolicy({
    allowDomains: ['*'],
    enableMutations: true,
    allowEval: true,
    allowDownloads: true,
    allowUploads: true,
    allowObservers: true,
  });
  assert.deepEqual(disabledCapabilities(open), []);
});

test('disabledCapabilities skips tools the --tools allowlist already removed', () => {
  setToolAllowlist(['get_text', 'click']);
  try {
    const off = disabledCapabilities(resolvePolicy({}));
    assert.deepEqual(off, [{ capability: 'mutations', flag: '--enable-mutations', hiddenTools: ['click'] }]);
  } finally {
    setToolAllowlist(null);
  }
});

test('chrome_status reports switched-off capabilities with their flags', async () => {
  setToolAllowlist(null);
  resetManagerForTesting();
  configureManager({ policy: resolvePolicy({ allowDomains: ['*'] }), makeExecutor: () => new StubExecutor() });
  const j = JSON.parse(textOf(await dispatchToolCall('chrome_status', {})));
  assert.equal(j.disabledCapabilities[0].capability, 'mutations');
  assert.equal(j.disabledCapabilities[0].flag, '--enable-mutations');
  assert.equal(j.disabledCapabilities[0].hiddenTools.includes('navigate'), true);
  assert.match(j.capabilityHint, /flag/);
});

test('chrome_status omits the capability fields when nothing is off', async () => {
  setToolAllowlist(null);
  resetManagerForTesting();
  configureManager({
    policy: resolvePolicy({
      allowDomains: ['*'],
      enableMutations: true,
      allowEval: true,
      allowDownloads: true,
      allowUploads: true,
      allowObservers: true,
    }),
    makeExecutor: () => new StubExecutor(),
  });
  const j = JSON.parse(textOf(await dispatchToolCall('chrome_status', {})));
  assert.equal('disabledCapabilities' in j, false);
  assert.equal('capabilityHint' in j, false);
});
