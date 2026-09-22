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
  WIRE_CAP_TAB_URL,
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
const LONG_METHODS: ReadonlySet<WireMethod> = new Set(['screenshot', 'wait_for', 'navigate', 'download_file', 'fill_form']);

function defaultTimeoutFor(method: WireMethod): number {
  return LONG_METHODS.has(method) ? 60_000 : 30_000;
}

/** Map a wire error code onto a local ExecutorError code (the wire enum is a
 *  near-superset; unknown codes degrade to CDP_ERROR while keeping the message). */
export function mapWireErrorCode(code: string): ExecutorErrorCodeLocal {
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

/** Commands that can change WHICH tab is active, invalidating a cached URL. */
const ACTIVE_TAB_CHANGERS: ReadonlySet<WireMethod> = new Set(['tab_select', 'tab_new', 'tab_close']);

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: WireMethod;
  /** The command carried no explicit tabId, so any URL it reports is the ACTIVE
   *  tab's. A URL from an explicitly-targeted tab says nothing about the active
   *  one and must never be cached as if it did. */
  activeTab: boolean;
  /** The explicit wire tab id the command targeted, if any — the key a reported
   *  URL is cached under. */
  tabId?: string;
}

/** Bound on the per-tab URL cache; entries beyond it are evicted oldest-first. */
const MAX_TAB_URL_ENTRIES = 256;

export interface ConnectionDeps {
  ws: WebSocket;
  extId: string;
  sessionId: string;
  heartbeatMs: number;
  /** Capabilities from `hello` (see WIRE_CAP_TAB_URL). Old builds send none. */
  caps?: string[];
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
  /** Whether this extension reports `tabUrl` and gates fail-closed. */
  private readonly reportsTabUrl: boolean;
  /** Every capability the extension advertised in `hello`. */
  private readonly caps: ReadonlySet<string>;
  /** Last URL the ACTIVE tab reported, with the wall-clock it arrived. */
  private activeUrl: { url: string; at: number } | null = null;
  /** Last URL each explicitly-targeted tab reported, keyed by wire tab id. A
   *  `tabs_list` result fills this for EVERY tab at once, which is what lets a
   *  parallel batch over N tabs gate on one round-trip instead of N. */
  private readonly tabUrls = new Map<string, { url: string; at: number }>();
  private readonly onEvent?: ConnectionDeps['onEvent'];
  private readonly onClose?: ConnectionDeps['onClose'];
  private readonly onLog?: ConnectionDeps['onLog'];

  constructor(deps: ConnectionDeps) {
    this.ws = deps.ws;
    this.extId = deps.extId;
    this.sessionId = deps.sessionId;
    this.caps = new Set(deps.caps ?? []);
    this.reportsTabUrl = this.caps.has(WIRE_CAP_TAB_URL);
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
    // Anything that reshuffles tabs makes the cached URL a claim about a tab that
    // may no longer be the active one. Drop it before the command, not after, so
    // a failure mid-flight can't leave a stale entry behind.
    if (ACTIVE_TAB_CHANGERS.has(method)) this.activeUrl = null;
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
      this.pending.set(id, { resolve, reject, timer, method, activeTab: opts?.tabId === undefined, tabId: opts?.tabId });

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
      this.rememberActiveUrl(p, frame);
      this.rememberTabUrls(p, frame);
      p.resolve(frame.data);
    } else {
      // A failed command tells us nothing reliable about where the tab ended up.
      if (p.activeTab) this.activeUrl = null;
      if (p.tabId) this.tabUrls.delete(p.tabId);
      p.reject(new ExecutorError(mapWireErrorCode(frame.error.code), frame.error.message));
    }
  }

  /**
   * Per-tab cache. Two feeds: a result for an explicitly-targeted tab carries
   * that tab's landing URL; a `tabs_list` result carries every tab's URL, so one
   * listing primes the gate for every op of a batch that follows it. A closed
   * tab is forgotten; a blank URL (Chrome hiding it) is forgotten too, never kept.
   */
  private rememberTabUrls(p: Pending, frame: ResultFrame): void {
    if (!this.reportsTabUrl) return;
    const now = Date.now();
    if (p.method === 'tab_close' && p.tabId) {
      this.tabUrls.delete(p.tabId);
      return;
    }
    if (p.method === 'tabs_list' && Array.isArray(frame.data)) {
      for (const t of frame.data as Array<{ tabId?: unknown; url?: unknown }>) {
        if (typeof t.tabId !== 'string') continue;
        if (typeof t.url === 'string' && t.url) this.tabUrls.set(t.tabId, { url: t.url, at: now });
        else this.tabUrls.delete(t.tabId);
      }
    } else if (p.tabId) {
      if (frame.tabUrl) this.tabUrls.set(p.tabId, { url: frame.tabUrl, at: now });
      else this.tabUrls.delete(p.tabId);
    }
    // Map iteration is insertion-ordered; drop the oldest until bounded.
    while (this.tabUrls.size > MAX_TAB_URL_ENTRIES) {
      const oldest = this.tabUrls.keys().next().value;
      if (oldest === undefined) break;
      this.tabUrls.delete(oldest);
    }
  }

  /** A specific tab's last reported URL if younger than `maxAgeMs`, else null. */
  lastTabUrl(tabId: string, maxAgeMs: number): string | null {
    const hit = this.tabUrls.get(tabId);
    if (!hit) return null;
    return Date.now() - hit.at <= maxAgeMs ? hit.url : null;
  }

  /**
   * Cache the URL a result rode home with — but ONLY when it describes the active
   * tab (no explicit tabId) and actually resolved. A blank `tabUrl` means the
   * extension couldn't read it (closed tab, restricted page), which is a reason
   * to forget what we knew, never to keep believing it.
   */
  private rememberActiveUrl(p: Pending, frame: ResultFrame): void {
    if (!this.reportsTabUrl || !p.activeTab) return;
    if (ACTIVE_TAB_CHANGERS.has(p.method)) return; // already invalidated; re-caching would race
    this.activeUrl = frame.tabUrl ? { url: frame.tabUrl, at: Date.now() } : null;
  }

  /** Whether the extension advertised `cap` in its `hello`. */
  hasCap(cap: string): boolean {
    return this.caps.has(cap);
  }

  /**
   * The active tab's last reported URL if it is younger than `maxAgeMs`, else
   * null — the caller then resolves it the slow way. Never returns a guess.
   */
  lastActiveUrl(maxAgeMs: number): string | null {
    if (!this.activeUrl) return null;
    return Date.now() - this.activeUrl.at <= maxAgeMs ? this.activeUrl.url : null;
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
