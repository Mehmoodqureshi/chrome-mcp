/**
 * src/remote/http.ts — serve MCP over Streamable HTTP, for clients that are not
 * on this computer (claude.ai, ChatGPT, Claude Code elsewhere, cloud agents).
 *
 * Binds 127.0.0.1 only; reaching it from the internet is the tunnel's job. Every
 * request must carry the remote key, either in the path (`/mcp/<key>`, for
 * connectors that cannot send headers) or as `Authorization: Bearer <key>` on
 * `/mcp`. Anything else gets a bare 404, so a scanner learns nothing.
 *
 * Each client session gets its own MCP server instance; they share the one
 * browser bridge, the policy, and the active profile, like several stdio
 * sessions sharing a hub.
 */

import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { createServer } from '../mcp/server';
import type { Policy } from '../security/policy';
import { keyMatches } from './key';

/** Largest JSON-RPC body accepted; tool calls are small, uploads go by path. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpMcpOptions {
  port: number;
  key: string;
  version: string;
  policy: Policy;
  log: (message: string) => void;
}

export interface HttpMcp {
  port: number;
  /** Open client sessions. */
  sessions(): number;
  close(): Promise<void>;
}

/** The key a request presents, if any: `/mcp/<key>` or a Bearer header on `/mcp`. */
export function presentedKey(req: Pick<IncomingMessage, 'url' | 'headers'>): string | undefined {
  const path = (req.url ?? '').split('?')[0];
  const inPath = /^\/mcp\/([^/]+)\/?$/.exec(path);
  if (inPath) return decodeURIComponent(inPath[1]);
  if (path === '/mcp' || path === '/mcp/') {
    const auth = req.headers.authorization;
    const bearer = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth) : null;
    return bearer?.[1];
  }
  return undefined;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined);
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string): void {
  reply(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

export async function startHttpMcp(opts: HttpMcpOptions): Promise<HttpMcp> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!keyMatches(presentedKey(req), opts.key)) return reply(res, 404);

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (err) {
        return rpcError(res, 400, err instanceof Error ? err.message : 'bad request');
      }
      if (existing) return existing.handleRequest(req, res, body);
      if (sessionId !== undefined) return rpcError(res, 404, 'unknown session; initialize again');
      if (!isInitializeRequest(body)) return rpcError(res, 400, 'no session; send initialize first');

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          opts.log(`remote client connected (${transports.size} open)`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const server = createServer(opts.version, opts.policy);
      await server.connect(transport);
      return transport.handleRequest(req, res, body);
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) return rpcError(res, 404, 'unknown session');
      return existing.handleRequest(req, res);
    }
    res.setHeader('allow', 'GET, POST, DELETE');
    return reply(res, 405);
  };

  const http: Server = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      opts.log(`remote request failed: ${err instanceof Error ? err.message : String(err)}`);
      rpcError(res, 500, 'internal error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Couldn't start: port ${opts.port} is in use. Pass --http-port <n> to pick another.`)
          : err,
      ),
    );
    http.listen(opts.port, '127.0.0.1', () => resolve());
  });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    port,
    sessions: () => transports.size,
    close: async () => {
      await Promise.allSettled([...transports.values()].map((t) => t.close()));
      transports.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
