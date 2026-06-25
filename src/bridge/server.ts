/**
 * src/bridge/server.ts — the localhost WebSocket bridge.
 *
 * The server is the WS SERVER; the extension dials in as the single privileged
 * CLIENT. The token is the ONLY trust boundary (the loopback bind is merely
 * defense-in-depth; Origin is NOT a gate). Flow:
 *   1. Accept any loopback upgrade.
 *   2. Require a valid `hello` (matching version + token) within HELLO_TIMEOUT;
 *      otherwise send `unauthorized` and close 4401.
 *   3. On success, send `welcome`, promote to the single ACTIVE connection
 *      (superseding any prior one — a security-relevant displacement event).
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

import {
  BRIDGE_HOST,
  CLOSE_SUPERSEDED,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  type HelloFrame,
  type ServerFrame,
  type UnauthFrame,
  type WelcomeFrame,
  type WireEvent,
  type WireMethod,
  type WirePolicy,
} from '../../shared/protocol';
import { DENY_ALL_WIRE_POLICY } from '../../shared/policy';
import { ExecutorError } from '../executor/types';
import { ExtensionConnection } from './connection';
import { tokensMatch } from './auth';

const HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
/** Max pre-auth frames a socket may send before a valid hello (anti-idle-hold). */
const MAX_PREAUTH_FRAMES = 10;
/** How long to wait for a just-replaced instance to release a fixed port before giving up. */
const PORT_WAIT_MS = 4_000;
/** Pause between port-bind retries while waiting for the old listener to exit. */
const PORT_RETRY_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A friendly, actionable message for the rare case the port stays busy past PORT_WAIT_MS. */
function portBusyMessage(host: string, port: number): string {
  return (
    `Couldn't start: another program is already using ${host}:${port}.\n` +
    `This is almost always a previous chrome-mcp that didn't shut down. To fix it:\n` +
    `  1. Fully quit/restart your MCP host (e.g. Claude Code), or\n` +
    `  2. Stop the leftover process, then reconnect:\n` +
    `       macOS/Linux:  lsof -nP -iTCP:${port} -sTCP:LISTEN   then  kill <PID>\n` +
    `  3. Or run chrome-mcp with a different port:  --port <number>`
  );
}

export interface DisplacementInfo {
  oldExtId: string;
  newExtId: string;
  /** True when a DIFFERENT extension id supplanted the active one (suspicious). */
  differentId: boolean;
}

export interface BridgeOptions {
  token: string;
  serverVersion: string;
  /** Active policy, sent to the extension in `welcome` so it mirrors the gate.
   *  Defaults to deny-all if omitted. */
  policy?: WirePolicy;
  port?: number;
  host?: string;
  heartbeatMs?: number;
  /** Diagnostics — MUST never receive the token (a test asserts this). */
  onLog?: (message: string) => void;
  onDisplacement?: (info: DisplacementInfo) => void;
  onEvent?: (event: WireEvent, data: Record<string, unknown>) => void;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private active: ExtensionConnection | null = null;
  private boundPort = 0;
  private readonly heartbeatMs: number;

  constructor(private readonly opts: BridgeOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  /** Bind and start listening. Returns the actual port (useful with port 0). */
  async start(): Promise<number> {
    if (this.wss) return this.boundPort;
    const host = this.opts.host ?? BRIDGE_HOST;
    const port = this.opts.port ?? 0;

    // A fixed port can be briefly held by a just-replaced instance of ourselves
    // (e.g. on a host "Reconnect"). Rather than crash with a cryptic EADDRINUSE,
    // wait-and-retry for a few seconds so the old process can release it; only if
    // it never frees up do we surface a plain-English, actionable error.
    const deadline = Date.now() + PORT_WAIT_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        const wss = await this.listenOnce(host, port);
        const addr = wss.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
        this.wss = wss;
        this.log(`bridge listening on ${host}:${this.boundPort}`);
        return this.boundPort;
      } catch (err) {
        const inUse = (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE';
        if (!inUse || port === 0 || Date.now() >= deadline) {
          if (inUse) throw new Error(portBusyMessage(host, port));
          throw err;
        }
        if (attempt === 1) this.log(`port ${host}:${port} busy — waiting for the previous instance to release it…`);
        await delay(PORT_RETRY_MS);
      }
    }
  }

  /** One bind attempt. Resolves with a listening server or rejects with the listen error. */
  private listenOnce(host: string, port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host, port });
      const onError = (err: Error): void => {
        wss.off('listening', onListening);
        // Close so the failed server doesn't linger and leak a handle on retry.
        try {
          wss.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const onListening = (): void => {
        wss.off('error', onError);
        wss.on('connection', (ws) => this.handleConnection(ws));
        resolve(wss);
      };
      wss.once('error', onError);
      wss.once('listening', onListening);
    });
  }

  async stop(): Promise<void> {
    this.active?.close(1001, 'server stopping');
    this.active = null;
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  get port(): number {
    return this.boundPort;
  }

  hasActiveExtension(): boolean {
    return this.active?.isOpen() ?? false;
  }

  /** Send a command to the active extension, or reject if none is connected. */
  async sendCommand(
    method: WireMethod,
    params: Record<string, unknown>,
    opts?: { tabId?: string; timeoutMs?: number },
  ): Promise<unknown> {
    if (!this.active || !this.active.isOpen()) {
      throw new ExecutorError('EXTENSION_DISCONNECTED', 'no extension is paired');
    }
    return this.active.sendCommand(method, params, opts);
  }

  status(): { extensionConnected: boolean; port: number; sessionId: string | null } {
    return {
      extensionConnected: this.hasActiveExtension(),
      port: this.boundPort,
      sessionId: this.active?.sessionId ?? null,
    };
  }

  // -- internals ----------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    let authed = false;
    // Cap pre-auth frames so a peer can't hold a socket idle by streaming
    // non-hello noise until HELLO_TIMEOUT_MS.
    let preAuthFrames = 0;
    const helloTimer = setTimeout(() => {
      if (authed) return;
      this.reject(ws, 'timeout');
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    const onMessage = (raw: import('ws').RawData): void => {
      if (authed) return;
      if (++preAuthFrames > MAX_PREAUTH_FRAMES) {
        clearTimeout(helloTimer);
        this.reject(ws, 'bad_token');
        return;
      }
      let frame: Partial<HelloFrame>;
      try {
        frame = JSON.parse(raw.toString()) as Partial<HelloFrame>;
      } catch {
        clearTimeout(helloTimer);
        this.reject(ws, 'bad_token');
        return;
      }
      if (frame.type !== 'hello') return; // ignore noise until a hello arrives
      if (frame.v !== PROTOCOL_VERSION) {
        clearTimeout(helloTimer);
        this.reject(ws, 'bad_version');
        return;
      }
      if (typeof frame.token !== 'string' || !tokensMatch(frame.token, this.opts.token)) {
        clearTimeout(helloTimer);
        this.reject(ws, 'bad_token');
        return;
      }
      // Authenticated. Hand the socket to an ExtensionConnection.
      authed = true;
      clearTimeout(helloTimer);
      ws.off('message', onMessage);
      this.promote(ws, frame.ext ?? { id: 'unknown', version: '0', chrome: '0' });
    };

    ws.on('message', onMessage);
    ws.on('error', () => {
      /* pre-auth socket errors are non-fatal; the close will clean up */
    });
  }

  private reject(ws: WebSocket, reason: UnauthFrame['reason']): void {
    this.send(ws, { type: 'unauthorized', v: PROTOCOL_VERSION, reason });
    this.log(`rejected a connection: ${reason}`);
    try {
      ws.close(CLOSE_UNAUTHORIZED, reason);
    } catch {
      /* ignore */
    }
  }

  private promote(ws: WebSocket, ext: HelloFrame['ext']): void {
    const sessionId = randomUUID();

    if (this.active && this.active.isOpen()) {
      const prev = this.active;
      const differentId = prev.extId !== ext.id;
      this.log(
        `extension "${ext.id}" superseded active connection "${prev.extId}"` +
          (differentId ? ' (DIFFERENT id — possible hijack; surfaced to status)' : ''),
      );
      try {
        this.opts.onDisplacement?.({ oldExtId: prev.extId, newExtId: ext.id, differentId });
      } catch {
        // A throwing displacement callback must not take down the bridge.
        this.log('onDisplacement callback threw; ignored');
      }
      prev.close(CLOSE_SUPERSEDED, 'superseded');
    }

    const conn = new ExtensionConnection({
      ws,
      extId: ext.id,
      sessionId,
      heartbeatMs: this.heartbeatMs,
      onEvent: this.opts.onEvent,
      onLog: (m) => this.log(m),
      onClose: () => {
        if (this.active?.sessionId === sessionId) this.active = null;
      },
    });
    this.active = conn;

    const welcome: WelcomeFrame = {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      serverVersion: this.opts.serverVersion,
      sessionId,
      heartbeatMs: this.heartbeatMs,
      policy: this.opts.policy ?? DENY_ALL_WIRE_POLICY,
    };
    this.send(ws, welcome);
    this.log(`extension paired (session ${sessionId}, id "${ext.id}")`);
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* socket already gone */
    }
  }

  private log(message: string): void {
    this.opts.onLog?.(message);
  }
}
