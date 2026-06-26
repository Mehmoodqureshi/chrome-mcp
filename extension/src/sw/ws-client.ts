/**
 * extension/src/sw/ws-client.ts — the WebSocket CLIENT half of the bridge.
 *
 * Dials the server, performs the hello/welcome token handshake, replies to
 * pings, and surfaces command frames + connection-state changes to the
 * background. Holds NO authoritative state of its own — the background owns
 * config (in chrome.storage) and drives (re)connection.
 */

import {
  PROTOCOL_VERSION,
  type CommandFrame,
  type HelloFrame,
  type ServerFrame,
  type WirePolicy,
} from '../../../shared/protocol';

export type ConnState = 'idle' | 'connecting' | 'connected' | 'unauthorized';

export interface WsClientDeps {
  onCommand: (cmd: CommandFrame) => void;
  onState: (state: ConnState, detail?: string) => void;
  /** Receives the policy the server delivers in `welcome`, for extension-side gating. */
  onPolicy: (policy: WirePolicy) => void;
  log: (message: string) => void;
}

function chromeVersion(): string {
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return m ? m[1] : '0';
}

export class WsClient {
  private ws: WebSocket | null = null;
  state: ConnState = 'idle';

  constructor(private readonly deps: WsClientDeps) {}

  isConnected(): boolean {
    return this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(port: number, token: string, profile?: string): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (err) {
      this.setState('idle', `dial failed: ${String(err)}`);
      return;
    }
    this.ws = ws;

    ws.onopen = (): void => {
      const hello: HelloFrame = {
        type: 'hello',
        v: PROTOCOL_VERSION,
        token,
        ext: { id: chrome.runtime.id, version: chrome.runtime.getManifest().version, chrome: chromeVersion() },
        profile: profile && profile.trim() ? profile.trim() : undefined,
      };
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (ev): void => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerFrame;
      } catch {
        return;
      }
      switch (frame.type) {
        case 'welcome':
          this.deps.onPolicy(frame.policy);
          this.setState('connected');
          this.deps.log('paired with server');
          break;
        case 'unauthorized':
          this.setState('unauthorized', frame.reason);
          this.deps.log(`pairing rejected: ${frame.reason}`);
          break;
        case 'ping':
          this.send({ type: 'pong', v: PROTOCOL_VERSION, ts: frame.ts });
          break;
        case 'command':
          this.deps.onCommand(frame);
          break;
      }
    };

    ws.onclose = (): void => {
      if (this.ws === ws) this.ws = null;
      if (this.state !== 'unauthorized') this.setState('idle');
    };
    ws.onerror = (): void => {
      // 'close' will follow; nothing to do.
    };
  }

  /** Send any extension→server frame (result/error/event/pong). */
  send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private setState(state: ConnState, detail?: string): void {
    this.state = state;
    this.deps.onState(state, detail);
  }
}
