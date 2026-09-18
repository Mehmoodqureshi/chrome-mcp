/**
 * src/bridge/peer.ts — let several chrome-mcp servers share one Chrome.
 *
 * Every MCP host session (each Claude terminal/tab) spawns its own chrome-mcp,
 * but a browser's extension dials exactly one port. So the first server to bind
 * the port is the HUB: it owns the extension connections. A later server that
 * finds the port held by a live chrome-mcp joins it as a PEER over the same
 * port and relays its commands through the hub, instead of killing it. If the
 * hub exits, its peers race to bind the port; the winner becomes the new hub
 * (with the same token, so the extension re-pairs on its own) and the rest join
 * it.
 *
 * Peers authenticate with the same token the extension uses — the handshake
 * file is 0600, so only the same OS user can read it — and speak a small
 * server-to-server protocol that the extension never sees:
 *   peer → hub:  peer_hello, relay (a wire command), peer_rename
 *   hub → peer:  peer_welcome, peer_state (paired browsers), relay_result
 */

import { WebSocket } from 'ws';

import { PROTOCOL_VERSION, type WireMethod } from '../../shared/protocol';
import { ExecutorError, type ExecutorErrorCodeLocal } from '../executor/types';
import type { PairedProfile } from './server';

/** How long a joining server waits for the hub's welcome before giving up. */
export const JOIN_TIMEOUT_MS = 2_000;
/** Slack on top of the hub's own command timeout, so the hub always answers first. */
const RELAY_GRACE_MS = 5_000;
/** Upper bound for a relayed command whose caller gave no timeout. */
const RELAY_DEFAULT_TIMEOUT_MS = 65_000;

export interface PeerHelloFrame {
  type: 'peer_hello';
  v: typeof PROTOCOL_VERSION;
  token: string;
  pid: number;
}
export interface RelayFrame {
  type: 'relay';
  id: string;
  method: WireMethod;
  params: Record<string, unknown>;
  opts?: { tabId?: string; timeoutMs?: number; profile?: string };
}
export interface PeerRenameFrame {
  type: 'peer_rename';
  id: string;
  from: string;
  to: string;
}
export type PeerToHubFrame = PeerHelloFrame | RelayFrame | PeerRenameFrame;

export interface PeerWelcomeFrame {
  type: 'peer_welcome';
  hubPid: number;
}
export interface PeerStateFrame {
  type: 'peer_state';
  profiles: PairedProfile[];
}
export interface RelayResultFrame {
  type: 'relay_result';
  id: string;
  ok: boolean;
  data?: unknown;
  /** Set when the hub failed with an ExecutorError, so the peer rethrows the same code. */
  code?: string;
  message?: string;
}
export type HubToPeerFrame = PeerWelcomeFrame | PeerStateFrame | RelayResultFrame;

/** Encode a hub-side failure so the peer can rethrow it with its code intact. */
export function relayError(id: string, err: unknown): RelayResultFrame {
  return {
    type: 'relay_result',
    id,
    ok: false,
    ...(err instanceof ExecutorError ? { code: err.code } : {}),
    message: err instanceof Error ? err.message : String(err),
  };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A peer's connection to the hub. Mirrors the hub's paired-browser list (pushed
 * on every change) so the synchronous `hasConnection` checks stay synchronous,
 * and relays commands as request/response pairs.
 */
export class HubLink {
  profiles: PairedProfile[] = [];
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    readonly hubPid: number,
    private readonly onClose: () => void,
  ) {
    ws.on('message', (raw) => this.handleMessage(raw.toString()));
    ws.on('close', () => this.handleClose());
    ws.on('error', () => this.handleClose());
  }

  /**
   * Join the hub on `port` with `token`. Resolves null when nothing answers as a
   * chrome-mcp hub in time: a wrong token, an older server that doesn't speak
   * the peer protocol (it ignores the frame and times us out), or no listener.
   */
  static join(host: string, port: number, token: string, onClose: () => void): Promise<HubLink | null> {
    return new Promise((resolve) => {
      let settled = false;
      const ws = new WebSocket(`ws://${host}:${port}`);
      const done = (link: HubLink | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.off('message', onFirst);
        if (!link) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
        }
        resolve(link);
      };
      const timer = setTimeout(() => done(null), JOIN_TIMEOUT_MS);
      timer.unref?.();
      const onFirst = (raw: import('ws').RawData): void => {
        let frame: { type?: string; hubPid?: number; profiles?: PairedProfile[] };
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return done(null);
        }
        if (frame.type !== 'peer_welcome') return done(null); // 'unauthorized' or anything else
        done(new HubLink(ws, typeof frame.hubPid === 'number' ? frame.hubPid : 0, onClose));
      };
      ws.on('message', onFirst);
      ws.once('open', () => {
        const hello: PeerHelloFrame = { type: 'peer_hello', v: PROTOCOL_VERSION, token, pid: process.pid };
        ws.send(JSON.stringify(hello));
      });
      ws.once('error', () => done(null));
      ws.once('close', () => done(null));
    });
  }

  isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  relay(method: WireMethod, params: Record<string, unknown>, opts?: RelayFrame['opts']): Promise<unknown> {
    const timeoutMs = (opts?.timeoutMs ?? RELAY_DEFAULT_TIMEOUT_MS - RELAY_GRACE_MS) + RELAY_GRACE_MS;
    return this.request({ type: 'relay', id: '', method, params, ...(opts ? { opts } : {}) }, timeoutMs);
  }

  rename(from: string, to: string): Promise<unknown> {
    return this.request({ type: 'peer_rename', id: '', from, to }, JOIN_TIMEOUT_MS * 2);
  }

  close(): void {
    try {
      this.ws.close(1001, 'peer stopping');
    } catch {
      /* ignore */
    }
    this.handleClose();
  }

  private request(frame: RelayFrame | PeerRenameFrame, timeoutMs: number): Promise<unknown> {
    if (!this.isOpen()) {
      return Promise.reject(new ExecutorError('EXTENSION_DISCONNECTED', 'the shared chrome-mcp hub is not reachable'));
    }
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ExecutorError('TIMEOUT', `the shared chrome-mcp hub did not answer ${frame.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...frame, id }));
    });
  }

  private handleMessage(raw: string): void {
    let frame: HubToPeerFrame;
    try {
      frame = JSON.parse(raw) as HubToPeerFrame;
    } catch {
      return;
    }
    if (frame.type === 'peer_state') {
      this.profiles = Array.isArray(frame.profiles) ? frame.profiles : [];
      return;
    }
    if (frame.type !== 'relay_result') return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if (frame.ok) p.resolve(frame.data);
    else if (frame.code) p.reject(new ExecutorError(frame.code as ExecutorErrorCodeLocal, frame.message ?? 'hub error'));
    else p.reject(new Error(frame.message ?? 'hub error'));
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.profiles = [];
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      // Retryable: the dispatcher re-runs idempotent calls once, by which time a
      // surviving server has usually taken the port over.
      p.reject(new ExecutorError('EXTENSION_DISCONNECTED', 'the shared chrome-mcp hub went away mid-call'));
    }
    this.pending.clear();
    this.onClose();
  }
}
