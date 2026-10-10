/**
 * src/mcp/server.ts — MCP server bootstrap over stdio.
 *
 * Wires the SDK `Server` to a `StdioServerTransport` so an MCP host (Claude)
 * drives chrome-mcp over JSON-RPC on stdin/stdout. CRITICAL: in stdio mode
 * NOTHING may be written to stdout except the JSON-RPC stream — all diagnostics
 * go to stderr via `logErr`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { logErr } from './log';
import { registerTools } from './tools';
import type { Policy } from '../security/policy';

// Re-exported so existing callers (and the CLI) keep importing the logger from
// here; the implementation lives in ./log to avoid a server↔tools import cycle.
export { getLogLevel, logDebug, logErr, setLogLevel } from './log';

const SERVER_NAME = 'chrome-mcp';
const SERVER_VERSION = '0.1.0';

/**
 * Sent to the host once, at initialize. It covers the two walls new users hit
 * before anything works: no paired browser, and a site not on the allowlist.
 * Both need the PERSON to act, so the agent's job is to relay the fix rather
 * than retry.
 */
export const SERVER_INSTRUCTIONS =
  "chrome-mcp drives the user's real, signed-in Chrome through the MCP Browser Extension. " +
  'Start with chrome_status. If it reports no paired browser (or any tool fails with NO_BACKEND), do not retry: ' +
  'give the user the steps in its `setup` field, which name what went wrong and how to fix it. ' +
  'If a tool fails with POLICY_DENIED because a site is not allowed, ask the user to allow it from the extension\'s ' +
  'toolbar icon (its popup has an Allow button). It applies at once, with no restart. You cannot approve a site yourself. ' +
  "Work in your own tab: tab_new opens one in the background, and calls without a tabId go to it, never to the tab the user is on. " +
  "To act on the user's current page, pass its tabId from tabs_list.";

/** Default version reported when no explicit version is passed in (legacy callers/tests). */
const DEFAULT_VERSION = SERVER_VERSION;

let server: McpServer | null = null;
let transport: StdioServerTransport | null = null;

/**
 * Build a fresh `Server` with the tool surface registered (no transport).
 *
 * `policy` is optional: pass it and tools whose capability the policy has
 * switched off are left out of the catalog (they could only answer
 * POLICY_DENIED, and the catalog is re-sent on every turn). Omit it and the
 * full catalog is advertised, which is what the tests want.
 */
export function createServer(version: string = DEFAULT_VERSION, policy?: Policy): McpServer {
  const srv = new McpServer(
    { name: SERVER_NAME, version },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(srv, policy);
  // `McpServer` wraps the low-level `Server`, which owns the `onerror` hook.
  srv.server.onerror = (err: unknown): void => {
    logErr(`server error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  };
  return srv;
}

/** Start over stdio. Idempotent. */
export async function startMcpServer(version: string = DEFAULT_VERSION, policy?: Policy): Promise<void> {
  if (server) {
    logErr('startMcpServer called but already running; ignoring.');
    return;
  }
  const srv = createServer(version, policy);
  const tx = new StdioServerTransport();
  try {
    await srv.connect(tx);
  } catch (err) {
    logErr(`failed to connect stdio transport: ${String(err)}`);
    server = null;
    transport = null;
    throw err;
  }
  server = srv;
  transport = tx;
  logErr(`${SERVER_NAME} v${version} connected over stdio.`);
}

/** Stop and release the transport. Idempotent, best-effort. */
export async function stopMcpServer(): Promise<void> {
  const srv = server;
  if (!srv) return;
  server = null;
  const tx = transport;
  transport = null;
  try {
    await srv.close();
  } catch (err) {
    logErr(`error closing server: ${String(err)}`);
  }
  try {
    await tx?.close();
  } catch (err) {
    logErr(`error closing transport: ${String(err)}`);
  }
  logErr('MCP server stopped.');
}

/** The MCP client this session serves, as it named itself at initialize (for analytics). */
export function mcpClientInfo(): { name?: string; version?: string } | undefined {
  const info = server?.server.getClientVersion();
  return info ? { name: info.name, version: info.version } : undefined;
}

export function isMcpServerRunning(): boolean {
  return server !== null;
}
