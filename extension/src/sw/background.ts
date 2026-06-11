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

interface PairConfig {
  wsPort: number;
  token: string;
}

const KEEPALIVE_ALARM = 'chrome-mcp-keepalive';

const executor = new ChromeExecutor();
const ws = new WsClient({
  onCommand: (cmd) => void router.dispatch(cmd),
  onState: (state) => void persistState(state),
  log: (m) => console.debug('[chrome-mcp]', m),
});
const router = new CommandRouter({
  exec: executor,
  send: (frame) => ws.send(frame),
  log: (m) => console.debug('[chrome-mcp]', m),
});

async function getConfig(): Promise<PairConfig | null> {
  const { wsPort, token } = await chrome.storage.local.get(['wsPort', 'token']);
  if (typeof wsPort === 'number' && typeof token === 'string' && token.length > 0) {
    return { wsPort, token };
  }
  return null;
}

async function persistState(state: ConnState): Promise<void> {
  await chrome.storage.local.set({ connState: state });
}

/** Connect if we have config and aren't already connected (and weren't rejected). */
async function ensureConnected(): Promise<void> {
  if (ws.isConnected() || ws.state === 'unauthorized') return;
  const cfg = await getConfig();
  if (!cfg) return;
  ws.connect(cfg.wsPort, cfg.token);
}

// --- keepalive: an awaited extension-API call resets the 30s idle timer -----
async function keepalivePulse(): Promise<void> {
  await chrome.storage.local.get('connState'); // the await is what keeps us warm
  await ensureConnected();
}

// --- top-level listeners (synchronous registration) -------------------------
chrome.runtime.onInstalled.addListener(() => void bootstrap());
chrome.runtime.onStartup.addListener(() => void bootstrap());

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void keepalivePulse();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.wsPort || changes.token)) {
    // New pairing config (e.g. from the options page) → clear any prior reject and connect.
    if (ws.state === 'unauthorized') ws.state = 'idle';
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
  await ensureConnected();
}

// Eager attempt on worker spin-up (covers wakes not covered by the events above).
void bootstrap();
