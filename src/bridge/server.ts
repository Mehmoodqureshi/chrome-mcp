/**
 * src/bridge/server.ts — the localhost WebSocket bridge.
 *
 * The server is the WS SERVER; the extension dials in as the single privileged
 * CLIENT. The token is the ONLY trust boundary (the loopback bind is merely
 * defense-in-depth; Origin is NOT a gate). Flow:
 *   1. Accept any loopback upgrade.
 *   2. Require a valid `hello` (matching version + token) within HELLO_TIMEOUT;
 *      otherwise send `unauthorized` and close 4401.
 *   3. On success, send `welcome` and file the connection under its profile
 *      (superseding only that profile's prior one — a security-relevant
 *      displacement event).
 * Other chrome-mcp servers (one per Claude session) may join the same port as
 * peers with `peer_hello` and relay their commands through us; see ./peer.
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
import { readHandshake, tokensMatch } from './auth';
import { evictPortOwner } from './evict';
import { sanitizeName } from '../config';
import { ProfileRegistry, isValidInstallId } from './profiles';
import { HubLink, relayError, type HubToPeerFrame, type PeerHelloFrame, type PeerToHubFrame } from './peer';

/** The routing label for a hello with no/blank profile — the back-compat default. */
const DEFAULT_PROFILE = 'default';

/** Where a live connection's profile name came from. */
export type ProfileNaming = 'options' | 'auto' | 'legacy';

/** One paired browser, as reported by chrome_status. */
export interface PairedProfile {
  name: string;
  /** options = typed in the extension's Options; auto = assigned by the server
   *  (renamable with profile_rename); legacy = an older extension, "default". */
  naming: ProfileNaming;
  /** The browser's active tab when it last reported one — a hint for telling
   *  auto-named browsers apart. */
  activeUrl?: string;
}

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
  /**
   * Called whenever this server takes a role on the port: 'hub' when it binds
   * it (publish the handshake + pairing files then), 'peer' when it joins the
   * chrome-mcp already holding it. Fires again after a failover.
   */
  onRole?: (role: BridgeRole, info: { port: number; token: string; hubPid?: number }) => void;
}

/** hub = owns the port and the browser connections; peer = relays through the hub. */
export type BridgeRole = 'hub' | 'peer';

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  /** Profile routing key → its live connection. Multiple browsers stay paired at
   *  once; a command is routed to the connection for its target profile. A new
   *  hello for the SAME profile supersedes that profile's connection only. */
  private conns = new Map<string, ExtensionConnection>();
  /** Profile routing key → how that live connection got its name, and the
   *  install behind it (absent for extensions too old to send one). */
  private origins = new Map<string, { naming: ProfileNaming; installId?: string }>();
  /** Remembers which name each extension install was given. */
  private registry: ProfileRegistry;
  private boundPort = 0;
  private readonly heartbeatMs: number;
  /** The pairing secret. Starts as ours; a peer adopts the hub's, so if it
   *  later takes the port over the extension re-pairs without a new token. */
  private token: string;
  /** Peer role: the link to the hub that owns the browsers. */
  private hub: HubLink | null = null;
  /** Hub role: the other chrome-mcp servers relaying through us. */
  private readonly peers = new Set<WebSocket>();
  private stopped = false;

  constructor(private readonly opts: BridgeOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.registry = new ProfileRegistry(opts.dataDir);
    this.token = opts.token;
  }

  /** 'hub' or 'peer' once started; null before start and between roles. */
  get role(): BridgeRole | null {
    return this.wss ? 'hub' : this.hub ? 'peer' : null;
  }

  /**
   * Bind and start listening, or — when a pinned port is held by another live
   * chrome-mcp — join it as a peer. Returns the port (useful with port 0).
   */
  async start(): Promise<number> {
    if (this.wss || this.hub) return this.boundPort;
    this.stopped = false;
    return this.claim();
  }

  private async claim(): Promise<number> {
    const host = this.opts.host ?? BRIDGE_HOST;
    const port = this.opts.port ?? 0;

    // A fixed port can be briefly held by a just-replaced instance of ourselves
    // (e.g. on a host "Reconnect"). Rather than crash with a cryptic EADDRINUSE,
    // wait-and-retry for a few seconds so the old process can release it; only if
    // it never frees up do we surface a plain-English, actionable error.
    const deadline = Date.now() + PORT_WAIT_MS;
    let evicted = false;
    let triedJoin = false;
    for (let attempt = 1; ; attempt++) {
      try {
        const wss = await this.listenOnce(host, port);
        const addr = wss.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
        this.wss = wss;
        // A peer promoted by failover picks up names the old hub assigned since.
        this.registry = new ProfileRegistry(this.opts.dataDir);
        this.log(`bridge listening on ${host}:${this.boundPort}`);
        this.opts.onRole?.('hub', { port: this.boundPort, token: this.token });
        return this.boundPort;
      } catch (err) {
        const inUse = (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE';
        if (!inUse || port === 0) throw inUse ? new Error(portBusyMessage(host, port)) : err;

        // Another Claude session's chrome-mcp owns the port: share it rather
        // than kill it, so every session keeps working at once.
        if (!triedJoin) {
          triedJoin = true;
          if (await this.joinHub(host, port)) return this.boundPort;
        }

        // Still busy after a failed join: an older chrome-mcp that can't share,
        // or a hung one. It will never release the port on its own, so take it
        // over (once). Only a verified chrome-mcp is ever killed; anything else
        // falls through to the wait-and-retry below.
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

  /**
   * Join the chrome-mcp holding `port` as a peer. Tries the token in the
   * handshake it published first (sessions without --persist-token each mint
   * their own), then ours.
   */
  private async joinHub(host: string, port: number): Promise<boolean> {
    const tokens = new Set<string>();
    const published = this.publishedToken(port);
    if (published) tokens.add(published);
    tokens.add(this.token);
    for (const token of tokens) {
      const link = await HubLink.join(host, port, token, () => this.onHubLost());
      if (!link) continue;
      if (this.stopped) {
        link.close();
        return false;
      }
      this.hub = link;
      this.token = token;
      this.boundPort = port;
      this.log(`port ${host}:${port} is held by chrome-mcp pid ${link.hubPid || '?'} — sharing its browsers as a peer`);
      this.opts.onRole?.('peer', { port, token, hubPid: link.hubPid });
      return true;
    }
    return false;
  }

  /** The token the port's current owner published, if its handshake describes that port. */
  private publishedToken(port: number): string | null {
    if (!this.opts.dataDir) return null;
    try {
      const h = readHandshake(this.opts.dataDir);
      return h.port === port && h.pid !== process.pid && typeof h.token === 'string' ? h.token : null;
    } catch {
      return null;
    }
  }

  /** The hub exited (its session ended): race the other peers for the port. */
  private onHubLost(): void {
    this.hub = null;
    if (this.stopped) return;
    this.log('the chrome-mcp sharing its browsers with us went away — taking over the port');
    void this.failover();
  }

  private async failover(): Promise<void> {
    // Stagger so surviving peers don't all bind at once; the losers join the winner.
    await delay(50 + Math.floor(Math.random() * 250));
    for (let attempt = 1; !this.stopped && !this.wss && !this.hub; attempt++) {
      try {
        await this.claim();
        return;
      } catch (err) {
        this.log(`failover attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
        await delay(1_000);
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
    this.stopped = true;
    this.hub?.close();
    this.hub = null;
    for (const peer of this.peers) peer.close(1001, 'server stopping');
    this.peers.clear();
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
    if (this.hub) return this.hub.profiles.length > 0;
    for (const conn of this.conns.values()) if (conn.isOpen()) return true;
    return false;
  }

  /** True when the given profile has a live connection. */
  hasConnection(profile: string): boolean {
    if (this.hub) return this.hub.profiles.some((p) => p.name === routeKey(profile));
    const conn = this.conns.get(routeKey(profile));
    return !!conn && conn.isOpen();
  }

  /** Profiles with a live connection right now. */
  connectedProfiles(): string[] {
    if (this.hub) return this.hub.profiles.map((p) => p.name);
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
    if (this.hub) return this.hub.relay(method, params, opts);
    const profile = routeKey(opts?.profile);
    const conn = this.conns.get(profile);
    if (!conn || !conn.isOpen()) {
      throw new ExecutorError('EXTENSION_DISCONNECTED', this.noPairMessage(profile));
    }
    return conn.sendCommand(method, params, opts);
  }

  /** Whether the browser paired as `profile` advertised capability `cap`. A peer
   *  cannot see the hub's handshake, so it answers false (the conservative path). */
  hasCap(profile: string | undefined, cap: string): boolean {
    if (this.hub) return false;
    const conn = this.conns.get(routeKey(profile));
    return !!conn?.isOpen() && conn.hasCap(cap);
  }

  /**
   * The active tab's URL for `profile` as last reported by the extension, if it
   * is younger than `maxAgeMs`. Null means "ask properly" — an extension too old
   * to report URLs, a tab shuffle since, or simply nothing recent enough.
   */
  lastActiveUrl(profile: string | undefined, maxAgeMs: number): string | null {
    if (this.hub) return null; // a peer has no cache; the caller asks properly
    const conn = this.conns.get(routeKey(profile));
    return conn?.isOpen() ? conn.lastActiveUrl(maxAgeMs) : null;
  }

  /** Same, for an explicitly-targeted tab (wire id) — see ExtensionConnection.lastTabUrl. */
  lastTabUrl(profile: string | undefined, tabId: string, maxAgeMs: number): string | null {
    if (this.hub) return null;
    const conn = this.conns.get(routeKey(profile));
    return conn?.isOpen() ? conn.lastTabUrl(tabId, maxAgeMs) : null;
  }

  /** How to pair a browser for `profile` — surfaced whenever that profile has no live connection. */
  noPairMessage(profile: string): string {
    return (
      `No browser is paired for profile "${profile}". In that Chrome's chrome-mcp ` +
      `extension Options, set Port ${this.boundPort}, paste the token, set Profile to ` +
      `"${profile}", and Save — then it joins without disturbing your other profiles.`
    );
  }

  /** Every paired browser with how it was named — for chrome_status. */
  pairedProfiles(): PairedProfile[] {
    if (this.hub) return [...this.hub.profiles];
    const out: PairedProfile[] = [];
    for (const [name, conn] of this.conns) {
      if (!conn.isOpen()) continue;
      const activeUrl = conn.lastActiveUrl(Number.POSITIVE_INFINITY) ?? undefined;
      out.push({ name, naming: this.origins.get(name)?.naming ?? 'legacy', ...(activeUrl ? { activeUrl } : {}) });
    }
    return out;
  }

  /**
   * Rename an automatically named browser. The new name sticks across restarts
   * (it's stored against the extension install); a live connection is re-keyed
   * in place, so it keeps working without re-pairing.
   */
  async renameProfile(from: string, to: string): Promise<string> {
    if (this.hub) return String(await this.hub.rename(from, to));
    const src = routeKey(from);
    const live = this.conns.get(src);
    if (live?.isOpen() && this.origins.get(src)?.naming === 'options') {
      throw new Error(
        `Profile "${src}" was named in that Chrome's extension Options — change it there ` +
          `(clear the field to let the server name it).`,
      );
    }
    const target = sanitizeName(to, 'profile');
    if (target !== src && this.conns.get(target)?.isOpen()) {
      throw new Error(`profile "${target}" already has a paired browser`);
    }
    const name = this.registry.rename(src, target);
    if (name !== src && live) {
      this.conns.delete(src);
      this.conns.set(name, live);
      const origin = this.origins.get(src);
      this.origins.delete(src);
      if (origin) this.origins.set(name, origin);
      this.log(`profile "${src}" renamed to "${name}"`);
      this.broadcastState();
    }
    return name;
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
      if ((frame.type as string) === 'peer_hello') {
        // Another chrome-mcp (a second Claude session) joining to share our browsers.
        const peer = frame as unknown as Partial<PeerHelloFrame>;
        clearTimeout(helloTimer);
        if (peer.v !== PROTOCOL_VERSION) return this.reject(ws, 'bad_version');
        if (typeof peer.token !== 'string' || !tokensMatch(peer.token, this.token)) return this.reject(ws, 'bad_token');
        authed = true;
        ws.off('message', onMessage);
        this.acceptPeer(ws, peer.pid);
        return;
      }
      if (frame.type !== 'hello') return; // ignore noise until a hello arrives
      if (frame.v !== PROTOCOL_VERSION) {
        clearTimeout(helloTimer);
        this.reject(ws, 'bad_version');
        return;
      }
      if (typeof frame.token !== 'string' || !tokensMatch(frame.token, this.token)) {
        clearTimeout(helloTimer);
        this.reject(ws, 'bad_token');
        return;
      }
      // Authenticated. Hand the socket to an ExtensionConnection under its profile.
      authed = true;
      clearTimeout(helloTimer);
      ws.off('message', onMessage);
      const { profile, naming, installId } = this.nameFor(frame);
      this.promote(
        ws,
        frame.ext ?? { id: 'unknown', version: '0', chrome: '0' },
        profile,
        Array.isArray(frame.caps) ? frame.caps : undefined,
        { naming, installId },
      );
    };

    ws.on('message', onMessage);
    ws.on('error', () => {
      /* pre-auth socket errors are non-fatal; the close will clean up */
    });
  }

  /**
   * Pick the routing key for an authenticated hello. A Profile typed into the
   * Options wins; otherwise an install keeps the name the registry gave it, and
   * a new install gets the first free one — never a name another browser holds,
   * so a second blank-profile Chrome joins instead of knocking the first off.
   * An extension too old to send an installId pairs as "default", as before.
   */
  private nameFor(frame: Partial<HelloFrame>): { profile: string; naming: ProfileNaming; installId?: string } {
    const installId = isValidInstallId(frame.installId) ? frame.installId : undefined;
    if (frame.profile && frame.profile.trim()) return { profile: routeKey(frame.profile), naming: 'options', installId };
    if (!installId) return { profile: DEFAULT_PROFILE, naming: 'legacy' };
    const heldByOther = (name: string): boolean => {
      const conn = this.conns.get(name);
      return !!conn && conn.isOpen() && this.origins.get(name)?.installId !== installId;
    };
    return { profile: this.registry.assign(installId, heldByOther), naming: 'auto', installId };
  }

  /** Hub side: serve a joined peer's relayed commands against our browsers. */
  private acceptPeer(ws: WebSocket, pid: number | undefined): void {
    this.peers.add(ws);
    this.log(`chrome-mcp pid ${pid ?? '?'} joined as a peer (${this.peers.size} sharing these browsers)`);
    this.sendPeer(ws, { type: 'peer_welcome', hubPid: process.pid });
    this.sendPeer(ws, { type: 'peer_state', profiles: this.pairedProfiles() });
    ws.on('message', (raw) => this.handlePeerFrame(ws, raw.toString()));
    ws.on('close', () => this.peers.delete(ws));
    ws.on('error', () => {
      /* the close that follows cleans up */
    });
  }

  private handlePeerFrame(ws: WebSocket, raw: string): void {
    let frame: PeerToHubFrame;
    try {
      frame = JSON.parse(raw) as PeerToHubFrame;
    } catch {
      return;
    }
    const answer = (id: string, work: Promise<unknown>): void => {
      work.then(
        (data) => this.sendPeer(ws, { type: 'relay_result', id, ok: true, data }),
        (err) => this.sendPeer(ws, relayError(id, err)),
      );
    };
    if (frame.type === 'relay') answer(frame.id, this.sendCommand(frame.method, frame.params ?? {}, frame.opts));
    else if (frame.type === 'peer_rename') answer(frame.id, this.renameProfile(frame.from, frame.to));
  }

  /** Tell every peer which browsers are paired — on each pair, unpair and rename. */
  private broadcastState(): void {
    if (this.peers.size === 0) return;
    const state: HubToPeerFrame = { type: 'peer_state', profiles: this.pairedProfiles() };
    for (const peer of this.peers) this.sendPeer(peer, state);
  }

  private sendPeer(ws: WebSocket, frame: HubToPeerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* peer already gone */
    }
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

  private promote(
    ws: WebSocket,
    ext: HelloFrame['ext'],
    profile: string,
    caps: string[] | undefined,
    origin: { naming: ProfileNaming; installId?: string },
  ): void {
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
      caps,
      onEvent: this.opts.onEvent,
      onLog: (m) => this.log(m),
      onClose: () => {
        // Only clear if a newer re-pair hasn't already replaced this slot. Look it
        // up by session: profile_rename may have re-keyed the slot since.
        for (const [key, c] of this.conns) {
          if (c.sessionId !== sessionId) continue;
          this.conns.delete(key);
          this.origins.delete(key);
        }
        this.broadcastState();
      },
    });
    this.conns.set(profile, conn);
    this.origins.set(profile, origin);
    this.broadcastState();

    const welcome: WelcomeFrame = {
      type: 'welcome',
      v: PROTOCOL_VERSION,
      serverVersion: this.opts.serverVersion,
      sessionId,
      heartbeatMs: this.heartbeatMs,
      policy: this.opts.policy ?? DENY_ALL_WIRE_POLICY,
      profile,
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
