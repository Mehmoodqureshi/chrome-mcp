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
  dispatchToolCall,
  enabledToolNames,
  isToolEnabled,
  setToolAllowlist,
} from '../src/mcp/tools';
import { createServer } from '../src/mcp/server';
import { configureManager, resetManagerForTesting } from '../src/executor/manager';
import { StubExecutor } from '../src/executor/stub-executor';
import { resolvePolicy } from '../src/security/policy';
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
async function listTools(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  const server = createServer('test');
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
