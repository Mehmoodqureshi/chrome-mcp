/**
 * src/bridge/connection.ts — one authenticated extension connection.
 *
 * Owns the pending-request table: each `sendCommand` mints an id, sends a
 * CommandFrame, and parks a {resolve,reject,timer} until the matching
 * result/error frame arrives. Guarantees:
 *   - method-aware per-request timeout that rejects the ONE call (never closes
 *     the socket),
 *   - reject-ALL-pending with EXTENSION_DISCONNECTED on close,
 *   - backpressure rejection (screenshots are large; never queue unboundedly),
 *   - app-level ping/pong heartbeat (optional; disabled when heartbeatMs<=0).
 */

import type { WebSocket, RawData } from 'ws';

import {
  PROTOCOL_VERSION,
  type CommandFrame,
  type ErrorFrame,
  type EventFrame,
  type ExtensionFrame,
  type ResultFrame,
  type WireEvent,
  type WireMethod,
} from '../../shared/protocol';
import { ExecutorError, type ExecutorErrorCodeLocal } from '../executor/types';

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const LONG_METHODS: ReadonlySet<WireMethod> = new Set(['screenshot', 'wait_for', 'navigate', 'download_file']);

function defaultTimeoutFor(method: WireMethod): number {
  return LONG_METHODS.has(method) ? 60_000 : 30_000;
}

/** Map a wire error code onto a local ExecutorError code (the wire enum is a
 *  near-superset; unknown codes degrade to CDP_ERROR while keeping the message). */
function mapWireErrorCode(code: string): ExecutorErrorCodeLocal {
  const known: Record<string, ExecutorErrorCodeLocal> = {
    TIMEOUT: 'TIMEOUT',
    POLICY_DENIED: 'POLICY_DENIED',
    DETACHED: 'DETACHED',
    DEVTOOLS_OPEN: 'DEVTOOLS_OPEN',
    TARGET_GONE: 'TARGET_GONE',
    SELECTOR_NOT_FOUND: 'SELECTOR_NOT_FOUND',
    REF_EXPIRED: 'REF_EXPIRED',
    DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
    EVAL_THREW: 'EVAL_FAILED',
  };
  return known[code] ?? 'TARGET_GONE';
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: WireMethod;
}

export interface ConnectionDeps {
  ws: WebSocket;
  extId: string;
  sessionId: string;
  heartbeatMs: number;
  onEvent?: (event: WireEvent, data: Record<string, unknown>) => void;
  onClose?: (code: number) => void;
  onLog?: (message: string) => void;
}

export class ExtensionConnection {
  readonly extId: string;
  readonly sessionId: string;
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private readonly onEvent?: ConnectionDeps['onEvent'];
  private readonly onClose?: ConnectionDeps['onClose'];
  private readonly onLog?: ConnectionDeps['onLog'];

  constructor(deps: ConnectionDeps) {
    this.ws = deps.ws;
    this.extId = deps.extId;
    this.sessionId = deps.sessionId;
    this.onEvent = deps.onEvent;
    this.onClose = deps.onClose;
    this.onLog = deps.onLog;

    this.ws.on('message', (raw) => this.handleMessage(raw));
    this.ws.on('close', (code) => this.handleClose(code));
    this.ws.on('error', () => this.handleClose(1006));

    if (deps.heartbeatMs > 0) this.startHeartbeat(deps.heartbeatMs);
  }

  /** Send a command and await its result (or reject on error/timeout/disconnect). */
  sendCommand(
    method: WireMethod,
    params: Record<string, unknown>,
    opts?: { tabId?: string; timeoutMs?: number },
  ): Promise<unknown> {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) {
      return Promise.reject(new ExecutorError('EXTENSION_DISCONNECTED', 'extension is not connected'));
    }
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      return Promise.reject(new ExecutorError('BACKPRESSURE', 'bridge send buffer is full; try again'));
    }

    const id = String(++this.seq);
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutFor(method);
    const frame: CommandFrame = {
      type: 'command',
      v: PROTOCOL_VERSION,
      id,
      method,
      params,
      tabId: opts?.tabId,
      timeoutMs,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExecutorError('TIMEOUT', `"${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });

      try {
        this.ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ExecutorError('EXTENSION_DISCONNECTED', `send failed: ${String(err)}`));
      }
    });
  }

  close(code: number, reason?: string): void {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
    this.handleClose(code);
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  // -- internals ----------------------------------------------------------

  private handleMessage(raw: RawData): void {
    let frame: ExtensionFrame;
    try {
      frame = JSON.parse(raw.toString()) as ExtensionFrame;
    } catch {
      this.onLog?.('dropped a non-JSON frame from the extension');
      return;
    }

    switch (frame.type) {
      case 'result':
        this.settle((frame as ResultFrame).id, frame as ResultFrame);
        break;
      case 'error':
        this.settle((frame as ErrorFrame).id, frame as ErrorFrame);
        break;
      case 'event': {
        const ev = frame as EventFrame;
        this.onEvent?.(ev.event, ev.data);
        break;
      }
      case 'pong':
        this.missedPongs = 0;
        break;
      default:
        // hello arrives only pre-auth (handled by the server); ignore here.
        break;
    }
  }

  private settle(id: string, frame: ResultFrame | ErrorFrame): void {
    const p = this.pending.get(id);
    if (!p) return; // already timed out / unknown id
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (frame.type === 'result') {
      p.resolve(frame.data);
    } else {
      p.reject(new ExecutorError(mapWireErrorCode(frame.error.code), frame.error.message));
    }
  }

  private handleClose(code: number): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    const pendings = [...this.pending.values()];
    this.pending.clear();
    for (const p of pendings) {
      clearTimeout(p.timer);
      p.reject(new ExecutorError('EXTENSION_DISCONNECTED', `connection closed (code ${code})`));
    }
    this.onClose?.(code);
  }

  private startHeartbeat(ms: number): void {
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      if (this.missedPongs >= 2) {
        this.onLog?.('extension missed 2 heartbeats; terminating connection');
        this.close(1001, 'heartbeat lost');
        return;
      }
      this.missedPongs++;
      try {
        this.ws.send(JSON.stringify({ type: 'ping', v: PROTOCOL_VERSION, ts: Date.now() }));
      } catch {
        this.close(1006, 'heartbeat send failed');
      }
    }, ms);
    this.heartbeat.unref?.();
  }
}
