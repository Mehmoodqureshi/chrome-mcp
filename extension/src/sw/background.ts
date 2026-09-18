/**
 * extension/src/sw/background.ts — the MV3 service-worker entry.
 *
 * MV3 reality: a service worker is evicted after ~30s idle and an open
 * WebSocket does NOT keep it alive. So:
 *   - ALL listeners are registered synchronously at top level (so a wake always
 *     re-arms them),
 *   - config + connection intent live in chrome.storage (not SW memory),
 *   - while connected, a 30s alarm + an awaited storage.get keep the worker warm
 *     (the server's 15s ping/pong also resets the idle timer on Chrome >= 116),
 *   - a dropped socket is redialled on a short backoff (1s, 2s, 4s, 8s, 10s...)
 *     while the worker is alive, so a server restart costs seconds, not the
 *     next alarm tick; the alarm remains the fallback if the worker is evicted,
 *   - on any wake we call ensureConnected().
 */

import { WsClient, type ConnState } from './ws-client';
import { CommandRouter } from './router';
import { ChromeExecutor } from './executor';
import { syncObserverScript } from './observers';
import type { WirePolicy } from '../../../shared/protocol';

interface PairConfig {
  wsPort: number;
  token: string;
  /** Routing label typed into Options; empty lets the server name this browser. */
  profile: string;
  /** Stable random id for this install (one per Chrome profile). */
  installId: string;
}

const KEEPALIVE_ALARM = 'chrome-mcp-keepalive';

/** The policy delivered by the server in `welcome`; the router mirrors the gate
 *  against it. Null until a welcome arrives (commands only flow after welcome). */
let currentPolicy: WirePolicy | null = null;

// The executor reads the live policy so a frame-scoped command can be gated
// against the FRAME's origin, not just the tab's.
const executor = new ChromeExecutor(() => currentPolicy);
// --- reconnect backoff --------------------------------------------------------
// Waiting for the 30s keepalive alarm after a drop (server restart, laptop
// wake) made the first tool call after it stall for up to half a minute. Redial
// promptly instead, backing off so a server that is genuinely down is not hammered.
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureConnected();
  }, delay);
}

function clearReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
}

const ws = new WsClient({
  onCommand: (cmd) => void router.dispatch(cmd),
  onState: (state) => {
    void persistState(state);
    if (state === 'connected') clearReconnect();
    // 'idle' after a dial = the socket closed or the dial failed: redial soon.
    else if (state === 'idle') scheduleReconnect();
    // A reject with an auto-adopted token usually means the server rotated it
    // (no --persist-token) and rewrote pairing.json — re-read and retry once.
    if (state === 'unauthorized') void adoptBundledPairing();
  },
  onPolicy: (policy) => {
    currentPolicy = policy;
    // The observer hook is registered from the policy, so it covers exactly the
    // allowlisted sites and only when the operator opted in.
    void syncObserverScript(policy, (m) => console.debug('[chrome-mcp]', m));
  },
  // Shown on the Options page, so you can tell which name this browser got.
  onProfile: (profile) => void chrome.storage.local.set({ pairedProfile: profile }),
  log: (m) => console.debug('[chrome-mcp]', m),
});
const router = new CommandRouter({
  exec: executor,
  send: (frame) => ws.send(frame),
  getPolicy: () => currentPolicy,
  log: (m) => console.debug('[chrome-mcp]', m),
});

/** Shape of the auto-pairing file the server writes next to this extension. */
interface BundledPairing {
  wsPort: number;
  token: string;
}

/**
 * Read `pairing.json` from this extension's own folder. The chrome-mcp server
 * writes it into its bundled `extension-dist/` on every boot, so an extension
 * loaded unpacked from that folder can pair with no Options-page paste. Absent
 * (a copied folder, a read-only install, or the server never ran) → null.
 */
async function readBundledPairing(): Promise<BundledPairing | null> {
  try {
    const res = await fetch(chrome.runtime.getURL('pairing.json'), { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { port?: unknown; token?: unknown };
    if (typeof j.port === 'number' && j.port > 0 && typeof j.token === 'string' && j.token.length > 0) {
      return { wsPort: j.port, token: j.token };
    }
  } catch {
    /* no bundled file — manual pairing only */
  }
  return null;
}

/**
 * Adopt the bundled pairing unless the user pinned values by hand in Options
 * (`pairingSource: 'manual'`). Only writes when something actually changed, so
 * a stale reject retries exactly once per new file — never in a loop. Returns
 * true when storage was updated (the onChanged listener then reconnects).
 */
async function adoptBundledPairing(): Promise<boolean> {
  const { wsPort, token, pairingSource } = await chrome.storage.local.get(['wsPort', 'token', 'pairingSource']);
  if (pairingSource === 'manual') return false;
  const bundled = await readBundledPairing();
  if (!bundled) return false;
  if (bundled.wsPort === wsPort && bundled.token === token) return false;
  await chrome.storage.local.set({ wsPort: bundled.wsPort, token: bundled.token, pairingSource: 'auto' });
  return true;
}

/**
 * Self-update for unpacked installs. The server mirrors a new extension build
 * into this folder on every boot; Chrome keeps running the old one until the
 * extension is reloaded. An unpacked extension reads its own files from disk,
 * so compare the manifest on disk with the one Chrome loaded and reload once
 * per new version. A packed (Web Store) install always sees its own manifest,
 * so this is a no-op there. Guarded by storage so a broken manifest on disk
 * cannot cause a reload loop.
 */
async function reloadIfFilesChanged(): Promise<void> {
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return;
    const onDisk = (await res.json()) as { version?: unknown };
    const loaded = chrome.runtime.getManifest().version;
    if (typeof onDisk.version !== 'string' || onDisk.version === loaded) return;
    const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
    if (reloadedFor === onDisk.version) return; // already tried this version once
    await chrome.storage.local.set({ reloadedFor: onDisk.version });
    console.info(`[chrome-mcp] extension files updated on disk (${loaded} -> ${onDisk.version}); reloading`);
    chrome.runtime.reload();
  } catch {
    /* packed install, or the folder is unreadable — nothing to do */
  }
}

/**
 * This install's id, created on first use. chrome.storage.local is per Chrome
 * profile, so each profile's copy of the extension gets its own — the server
 * names browsers from it, since Chrome won't tell an extension which profile
 * it is running in.
 */
async function ensureInstallId(installId: unknown): Promise<string> {
  if (typeof installId === 'string' && installId.length > 0) return installId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}

async function getConfig(): Promise<PairConfig | null> {
  const { wsPort, token, profile, installId } = await chrome.storage.local.get([
    'wsPort',
    'token',
    'profile',
    'installId',
  ]);
  // wsPort must be > 0 — a stored 0 would dial ws://127.0.0.1:0 (ERR_UNSAFE_PORT).
  if (typeof wsPort === 'number' && wsPort > 0 && typeof token === 'string' && token.length > 0) {
    const label = typeof profile === 'string' ? profile.trim() : '';
    return { wsPort, token, profile: label, installId: await ensureInstallId(installId) };
  }
  return null;
}

const BADGE: Record<ConnState, { text: string; color: string; title: string }> = {
  connected: { text: '●', color: '#16a34a', title: 'MCP Extension for Chrome — connected' },
  connecting: { text: '…', color: '#ca8a04', title: 'MCP Extension for Chrome — connecting' },
  unauthorized: { text: '!', color: '#dc2626', title: 'MCP Extension for Chrome — rejected (bad/stale token; re-pair)' },
  idle: { text: '○', color: '#6b7280', title: 'MCP Extension for Chrome — not connected (open options to pair)' },
};

function reflectBadge(state: ConnState): void {
  const b = BADGE[state] ?? BADGE.idle;
  // Best-effort: chrome.action may be unavailable in some contexts.
  try {
    void chrome.action.setBadgeText({ text: b.text });
    void chrome.action.setBadgeBackgroundColor({ color: b.color });
    void chrome.action.setTitle({ title: b.title });
  } catch {
    /* no action surface */
  }
}

async function persistState(state: ConnState): Promise<void> {
  reflectBadge(state);
  await chrome.storage.local.set({ connState: state });
}

/** Connect if we have config and aren't already connected (and weren't rejected). */
async function ensureConnected(): Promise<void> {
  if (ws.isConnected() || ws.state === 'unauthorized') return;
  const cfg = await getConfig();
  if (!cfg) return;
  ws.connect(cfg.wsPort, cfg.token, cfg.profile, cfg.installId);
}

// --- keepalive: an awaited extension-API call resets the 30s idle timer -----
async function keepalivePulse(): Promise<void> {
  await chrome.storage.local.get('connState'); // the await is what keeps us warm
  await reloadIfFilesChanged();
  // Not paired yet (extension loaded before the server first ran)? The server
  // may have written pairing.json since — pick it up without a reload.
  if (!ws.isConnected() && !(await getConfig())) await adoptBundledPairing();
  await ensureConnected();
}

// --- top-level listeners (synchronous registration) -------------------------
chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void keepalivePulse();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.wsPort || changes.token || changes.profile)) {
    // New pairing config (e.g. from the options page) → clear any prior reject and
    // reconnect so a changed profile re-pairs under the new routing label.
    if (ws.state === 'unauthorized') ws.state = 'idle';
    if (changes.profile) ws.close(); // force a fresh hello with the new profile
    clearReconnect();
    void ensureConnected();
  }
});

// Lets the options page trigger an immediate (re)connect after saving config.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'reconnect') {
    clearReconnect();
    ws.close();
    ws.state = 'idle';
    void ensureConnected();
  }
});

async function bootstrap(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  await reloadIfFilesChanged();
  // Zero-paste pairing: if this folder carries the server's pairing.json, adopt
  // it. When that writes storage, onChanged reconnects; otherwise connect now.
  if (!(await adoptBundledPairing())) await ensureConnected();
}

// Eager attempt on worker spin-up (covers wakes not covered by the events above).
void bootstrap();
