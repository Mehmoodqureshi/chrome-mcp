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
  WIRE_CAP_FILL_FORM,
  WIRE_CAP_TAB_URL,
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
  /** Receives the profile name the server paired this browser as. */
  onProfile?: (profile: string) => void;
  /** Receives the sites allowed at runtime from Options (null: the server can't take grants). */
  onGranted?: (granted: string[] | null) => void;
  /** The extension version bundled with the server (null: an older server that does not say). */
  onLatestExtension?: (version: string | null) => void;
  /** The server refused a call because `host` is not on the allowlist. */
  onBlocked?: (host: string, method: string) => void;
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

  connect(port: number, token: string, profile?: string, installId?: string, install?: string): void {
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
        installId,
        ...(install ? { install } : {}),
        // This build gates fail-closed and reports tab URLs on results, so the
        // server may skip its pre-flight tabs_list. An older build omits this and
        // the server keeps fetching the URL itself.
        caps: [WIRE_CAP_TAB_URL, WIRE_CAP_FILL_FORM],
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
          if (typeof frame.profile === 'string') this.deps.onProfile?.(frame.profile);
          this.deps.onGranted?.(Array.isArray(frame.granted) ? frame.granted : null);
          this.deps.onLatestExtension?.(typeof frame.latestExtension === 'string' ? frame.latestExtension : null);
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
        case 'policy':
          // A site was allowed or removed (from this browser's Options or another's).
          this.deps.onPolicy(frame.policy);
          this.deps.onGranted?.(Array.isArray(frame.granted) ? frame.granted : []);
          break;
        case 'blocked':
          if (typeof frame.host === 'string') this.deps.onBlocked?.(frame.host, String(frame.method ?? ''));
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
