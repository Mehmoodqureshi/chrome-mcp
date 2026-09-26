/**
 * extension/src/options/options.ts — the manual pairing UI. Persists {wsPort,
 * token} to chrome.storage.local (which the background SW watches) and asks it
 * to (re)connect. Also reflects the live connection state.
 */

import { DEFAULT_WS_PORT } from '../../../shared/protocol';

const portEl = document.getElementById('port') as HTMLInputElement;
const tokenEl = document.getElementById('token') as HTMLInputElement;
const profileEl = document.getElementById('profile') as HTMLInputElement;
const saveEl = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const sourceEl = document.getElementById('source') as HTMLParagraphElement;
const pairedAsEl = document.getElementById('paired-as') as HTMLParagraphElement;
const borderEl = document.getElementById('tab-border') as HTMLInputElement;

// Takes effect at once: the service worker clears every border when this turns off.
void chrome.storage.local.get('tabBorder').then(({ tabBorder }) => (borderEl.checked = tabBorder !== false));
borderEl.addEventListener('change', () => void chrome.storage.local.set({ tabBorder: borderEl.checked }));

function renderPairedAs(name: unknown): void {
  pairedAsEl.textContent = typeof name === 'string' && name ? `This browser is paired as "${name}".` : '';
}

async function loadExisting(): Promise<void> {
  const { wsPort, profile, connState, pairingSource, pairedProfile } = await chrome.storage.local.get([
    'wsPort',
    'profile',
    'connState',
    'pairingSource',
    'pairedProfile',
  ]);
  renderPairedAs(pairedProfile);
  sourceEl.textContent =
    pairingSource === 'auto'
      ? 'Paired automatically from the pairing.json the server wrote into this extension folder. Saving here overrides it.'
      : pairingSource === 'manual'
        ? 'Paired by hand. Saved values take precedence over the bundled pairing.json.'
        : typeof wsPort === 'number' && wsPort > 0 && connState !== 'idle'
          ? 'Paired with values saved by an earlier version. Saving here keeps them manual.'
          : 'Not paired yet. If you loaded this extension from the chrome-mcp package folder, start the server once and it pairs itself; otherwise paste the values below.';
  // Prefill a real value (not just the placeholder) so an empty Save can never
  // store port 0 → ws://127.0.0.1:0 → ERR_UNSAFE_PORT. Defaults to the server's port.
  portEl.value = typeof wsPort === 'number' && wsPort > 0 ? String(wsPort) : String(DEFAULT_WS_PORT);
  profileEl.value = typeof profile === 'string' ? profile : '';
  render(typeof connState === 'string' ? connState : 'idle');
}

function render(state: string): void {
  const labels: Record<string, string> = {
    connected: '✅ connected',
    connecting: '… connecting',
    unauthorized: '⛔ rejected (bad/stale token — re-paste)',
    idle: '○ not connected',
  };
  statusEl.textContent = `Status: ${labels[state] ?? state}`;
}

saveEl.addEventListener('click', async () => {
  const wsPort = Number(portEl.value);
  // The token field is never prefilled (it's a secret), so a blank one means
  // "keep the token I already have" — e.g. when only the Profile changes.
  const stored = await chrome.storage.local.get('token');
  const token = tokenEl.value.trim() || (typeof stored.token === 'string' ? stored.token : '');
  // Blank = let the server name this browser ("default", "profile-2", ...).
  const profile = profileEl.value.trim();
  if (!Number.isInteger(wsPort) || wsPort <= 0 || !token) {
    statusEl.textContent = 'Status: enter a valid port (> 0) and token';
    return;
  }
  await chrome.storage.local.set({ wsPort, token, profile, pairingSource: 'manual' });
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => undefined);
  statusEl.textContent = 'Status: … connecting';
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.connState) render(String(changes.connState.newValue));
  if (area === 'local' && changes.pairedProfile) renderPairedAs(changes.pairedProfile.newValue);
});

void loadExisting();
