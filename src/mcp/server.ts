/**
 * src/mcp/server.ts — MCP server bootstrap over stdio.
 *
 * Wires the SDK `Server` to a `StdioServerTransport` so an MCP host (Claude)
 * drives chrome-mcp over JSON-RPC on stdin/stdout. CRITICAL: in stdio mode
 * NOTHING may be written to stdout except the JSON-RPC stream — all diagnostics
 * go to stderr via `logErr`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools';

const SERVER_NAME = 'chrome-mcp';
const SERVER_VERSION = '0.1.0';

let server: Server | null = null;
let transport: StdioServerTransport | null = null;

/** stderr only — never stdout in stdio mode. */
export function logErr(message: string): void {
  process.stderr.write(`[chrome-mcp] ${message}\n`);
}

/** Build a fresh `Server` with the full tool surface registered (no transport). */
export function createServer(): Server {
  const srv = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(srv);
  srv.onerror = (err: unknown): void => {
    logErr(`server error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  };
  return srv;
}

/** Start over stdio. Idempotent. */
export async function startMcpServer(): Promise<void> {
  if (server) {
    logErr('startMcpServer called but already running; ignoring.');
    return;
  }
  const srv = createServer();
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
  logErr(`${SERVER_NAME} v${SERVER_VERSION} connected over stdio.`);
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

export function isMcpServerRunning(): boolean {
  return server !== null;
}
