/**
 * extension/src/sw/background.ts — the MV3 service-worker entry.
 *
 * MV3 reality: a service worker is evicted after ~30s idle and an open
 * WebSocket does NOT keep it alive. So:
 *   - ALL listeners are registered synchronously at top level (so a wake always
 *     re-arms them),
 *   - config + connection intent live in chrome.storage (not SW memory),
 *   - while connected, a 25s alarm + an awaited storage.get keep the worker warm,
 *     and the alarm is also the reconnect driver,
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
  /** Routing label this browser pairs as (default "default"). */
  profile: string;
}

const KEEPALIVE_ALARM = 'chrome-mcp-keepalive';

/** The policy delivered by the server in `welcome`; the router mirrors the gate
 *  against it. Null until a welcome arrives (commands only flow after welcome). */
let currentPolicy: WirePolicy | null = null;

// The executor reads the live policy so a frame-scoped command can be gated
// against the FRAME's origin, not just the tab's.
const executor = new ChromeExecutor(() => currentPolicy);
const ws = new WsClient({
  onCommand: (cmd) => void router.dispatch(cmd),
  onState: (state) => {
    void persistState(state);
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

async function getConfig(): Promise<PairConfig | null> {
  const { wsPort, token, profile } = await chrome.storage.local.get(['wsPort', 'token', 'profile']);
  // wsPort must be > 0 — a stored 0 would dial ws://127.0.0.1:0 (ERR_UNSAFE_PORT).
  if (typeof wsPort === 'number' && wsPort > 0 && typeof token === 'string' && token.length > 0) {
    const name = typeof profile === 'string' && profile.trim() ? profile.trim() : 'default';
    return { wsPort, token, profile: name };
  }
  return null;
}

const BADGE: Record<ConnState, { text: string; color: string; title: string }> = {
  connected: { text: '●', color: '#16a34a', title: 'Chrome MCP — connected' },
  connecting: { text: '…', color: '#ca8a04', title: 'Chrome MCP — connecting' },
  unauthorized: { text: '!', color: '#dc2626', title: 'Chrome MCP — rejected (bad/stale token; re-pair)' },
  idle: { text: '○', color: '#6b7280', title: 'Chrome MCP — not connected (open options to pair)' },
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
  ws.connect(cfg.wsPort, cfg.token, cfg.profile);
}

// --- keepalive: an awaited extension-API call resets the 30s idle timer -----
async function keepalivePulse(): Promise<void> {
  await chrome.storage.local.get('connState'); // the await is what keeps us warm
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
    void ensureConnected();
  }
});

// Lets the options page trigger an immediate (re)connect after saving config.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'reconnect') {
    ws.close();
    ws.state = 'idle';
    void ensureConnected();
  }
});

async function bootstrap(): Promise<void> {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  // Zero-paste pairing: if this folder carries the server's pairing.json, adopt
  // it. When that writes storage, onChanged reconnects; otherwise connect now.
  if (!(await adoptBundledPairing())) await ensureConnected();
}

// Eager attempt on worker spin-up (covers wakes not covered by the events above).
void bootstrap();
