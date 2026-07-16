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
import { evictPortOwner } from './evict';
import { sanitizeName } from '../config';

/** The routing label for a hello with no/blank profile — the back-compat default. */
const DEFAULT_PROFILE = 'default';

/** Reduce a hello's profile label to a safe routing key; blank/invalid → "default". */
function routeKey(profile: string | undefined): string {
  if (!profile || !profile.trim()) return DEFAULT_PROFILE;
  try {
    return sanitizeName(profile, 'profile');
  } catch {
    return DEFAULT_PROFILE;
  }
}

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
    `A stale chrome-mcp is reclaimed automatically, so this is some OTHER program.\n` +
    `To fix it:\n` +
    `  1. Stop whatever owns the port, then reconnect:\n` +
    `       macOS/Linux:  lsof -nP -iTCP:${port} -sTCP:LISTEN   then  kill <PID>\n` +
    `       Windows:      netstat -ano | findstr :${port}        then  taskkill /PID <PID> /F\n` +
    `  2. Or run chrome-mcp with a different port:  --port <number>`
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
  /** Data dir holding the handshake. Enables reclaiming a pinned port from a
   *  stale chrome-mcp (see ./evict). Omit to disable eviction entirely. */
  dataDir?: string;
  /** Diagnostics — MUST never receive the token (a test asserts this). */
  onLog?: (message: string) => void;
  onDisplacement?: (info: DisplacementInfo) => void;
  onEvent?: (event: WireEvent, data: Record<string, unknown>) => void;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  /** Profile routing key → its live connection. Multiple browsers stay paired at
   *  once; a command is routed to the connection for its target profile. A new
   *  hello for the SAME profile supersedes that profile's connection only. */
  private conns = new Map<string, ExtensionConnection>();
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
    let evicted = false;
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
        if (!inUse || port === 0) throw inUse ? new Error(portBusyMessage(host, port)) : err;

        // A live chrome-mcp from another session will never release the port on
        // its own, so waiting it out is futile — take it over (once). Only a
        // verified chrome-mcp is ever killed; anything else falls through to the
        // wait-and-retry below, which covers our own just-replaced instance.
        if (!evicted && this.opts.dataDir) {
          evicted = true;
          if (await evictPortOwner(this.opts.dataDir, port, (m) => this.log(m))) {
            continue;
          }
        }
        if (Date.now() >= deadline) throw new Error(portBusyMessage(host, port));
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
    for (const conn of this.conns.values()) conn.close(1001, 'server stopping');
    this.conns.clear();
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  get port(): number {
    return this.boundPort;
  }

  /** True when ANY browser is paired (used as the selector's cheap gate). */
  hasActiveExtension(): boolean {
    for (const conn of this.conns.values()) if (conn.isOpen()) return true;
    return false;
  }

  /** True when the given profile has a live connection. */
  hasConnection(profile: string): boolean {
    const conn = this.conns.get(routeKey(profile));
    return !!conn && conn.isOpen();
  }

  /** Profiles with a live connection right now. */
  connectedProfiles(): string[] {
    const out: string[] = [];
    for (const [profile, conn] of this.conns) if (conn.isOpen()) out.push(profile);
    return out;
  }

  /**
   * Send a command to the connection for `opts.profile` (default "default").
   * Rejects with an actionable message if that profile has no live browser.
   */
  async sendCommand(
    method: WireMethod,
    params: Record<string, unknown>,
    opts?: { tabId?: string; timeoutMs?: number; profile?: string },
  ): Promise<unknown> {
    const profile = routeKey(opts?.profile);
    const conn = this.conns.get(profile);
    if (!conn || !conn.isOpen()) {
      throw new ExecutorError('EXTENSION_DISCONNECTED', this.noPairMessage(profile));
    }
    return conn.sendCommand(method, params, opts);
  }

  private noPairMessage(profile: string): string {
    return (
      `No browser is paired for profile "${profile}". In that Chrome's chrome-mcp ` +
      `extension Options, set Port ${this.boundPort}, paste the token, set Profile to ` +
      `"${profile}", and Save — then it joins without disturbing your other profiles.`
    );
  }

  status(): { extensionConnected: boolean; port: number; connectedProfiles: string[] } {
    return {
      extensionConnected: this.hasActiveExtension(),
      port: this.boundPort,
      connectedProfiles: this.connectedProfiles(),
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
      // Authenticated. Hand the socket to an ExtensionConnection under its profile.
      authed = true;
      clearTimeout(helloTimer);
      ws.off('message', onMessage);
      this.promote(ws, frame.ext ?? { id: 'unknown', version: '0', chrome: '0' }, routeKey(frame.profile));
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

  private promote(ws: WebSocket, ext: HelloFrame['ext'], profile: string): void {
    const sessionId = randomUUID();

    // Supersede only the SAME profile's connection (a re-pair). Other profiles
    // keep their live connections, so several browsers stay paired at once.
    const prev = this.conns.get(profile);
    if (prev && prev.isOpen()) {
      const differentId = prev.extId !== ext.id;
      this.log(
        `extension "${ext.id}" superseded profile "${profile}" connection "${prev.extId}"` +
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
        // Only clear if a newer re-pair hasn't already replaced this slot.
        if (this.conns.get(profile)?.sessionId === sessionId) this.conns.delete(profile);
      },
    });
    this.conns.set(profile, conn);

    const welcome: WelcomeFrame = {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      serverVersion: this.opts.serverVersion,
      sessionId,
      heartbeatMs: this.heartbeatMs,
      policy: this.opts.policy ?? DENY_ALL_WIRE_POLICY,
    };
    this.send(ws, welcome);
    this.log(`extension paired (profile "${profile}", session ${sessionId}, id "${ext.id}")`);
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
