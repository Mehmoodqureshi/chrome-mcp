/**
 * extension/src/options/options.ts — the manual pairing UI. Persists {wsPort,
 * token} to chrome.storage.local (which the background SW watches) and asks it
 * to (re)connect. Also reflects the live connection state.
 */

import { DEFAULT_WS_PORT } from '../../../shared/protocol';
import { connectWithOneClick } from '../connect';

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
          : 'Not paired yet. If you loaded this extension from the MCP Browser Extension package folder, start the server once and it pairs itself; otherwise paste the values below.';
  // Prefill a real value (not just the placeholder) so an empty Save can never
  // store port 0 → ws://127.0.0.1:0 → ERR_UNSAFE_PORT. Defaults to the server's port.
  portEl.value = typeof wsPort === 'number' && wsPort > 0 ? String(wsPort) : String(DEFAULT_WS_PORT);
  profileEl.value = typeof profile === 'string' ? profile : '';
  render(typeof connState === 'string' ? connState : 'idle');
}

const quickEl = document.getElementById('quick') as HTMLDivElement;
const connectEl = document.getElementById('connect') as HTMLButtonElement;
const connectMsgEl = document.getElementById('connect-msg') as HTMLParagraphElement;

connectEl.addEventListener('click', async () => {
  connectEl.disabled = true;
  connectEl.textContent = 'Connecting…';
  const res = await connectWithOneClick();
  connectEl.disabled = false;
  connectEl.textContent = 'Connect';
  connectMsgEl.className = res.ok ? 'hint' : 'hint error';
  connectMsgEl.textContent = res.ok ? 'Connecting…' : (res.message ?? 'Could not connect.');
});

function render(state: string): void {
  // Always offered: "Connect" while unpaired, "Connect again" to re-pair on purpose.
  quickEl.hidden = false;
  if (!connectEl.disabled) connectEl.textContent = state === 'connected' ? 'Connect again' : 'Connect';
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

// -- allowed sites ------------------------------------------------------------

const blockedWrapEl = document.getElementById('blocked-wrap') as HTMLDivElement;
const blockedEl = document.getElementById('blocked') as HTMLUListElement;
const allowedEl = document.getElementById('allowed') as HTMLUListElement;
const sitesNoteEl = document.getElementById('sites-note') as HTMLParagraphElement;
const newSiteEl = document.getElementById('new-site') as HTMLInputElement;
const addSiteEl = document.getElementById('add-site') as HTMLButtonElement;

interface BlockedSite {
  host: string;
  method: string;
  at: number;
}

/** Send an Allow / Remove to the server through the service worker. */
async function grant(host: string, allow: boolean): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'site_grant', host, allow }).catch(() => null)) as
    | { ok: boolean; error?: string }
    | null;
  sitesNoteEl.textContent = res?.ok
    ? ''
    : `Could not reach the MCP Browser Extension server${res?.error ? ` (${res.error})` : ''}. Is your AI client running?`;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function siteRow(host: string, extra: Array<HTMLElement>): HTMLLIElement {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.textContent = host;
  li.append(name, ...extra);
  return li;
}

function tag(text: string): HTMLSpanElement {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

async function renderSites(): Promise<void> {
  const { allowedSites, grantedSites, blockedSites, connState } = await chrome.storage.local.get([
    'allowedSites',
    'grantedSites',
    'blockedSites',
    'connState',
  ]);
  const allowed = Array.isArray(allowedSites) ? (allowedSites as string[]) : [];
  // null = a server too old to take grants from here.
  const granted = Array.isArray(grantedSites) ? (grantedSites as string[]) : null;
  const blocked = Array.isArray(blockedSites) ? (blockedSites as BlockedSite[]) : [];

  blockedEl.replaceChildren(
    ...blocked.map((b) =>
      siteRow(b.host, [
        tag(b.method ? `blocked ${b.method}` : 'blocked'),
        button('Allow', () => void grant(b.host, true)),
        button('Dismiss', () => void chrome.runtime.sendMessage({ type: 'dismiss_blocked', host: b.host })),
      ]),
    ),
  );
  blockedWrapEl.hidden = blocked.length === 0 || granted === null;

  allowedEl.replaceChildren(
    ...allowed.map((host) =>
      host === '*'
        ? siteRow('Every site', [tag('--unsafe-all-domains')])
        : granted?.includes(host)
          ? siteRow(host, [button('Remove', () => void grant(host, false))])
          : siteRow(host, [tag('set by server flags')]),
    ),
  );
  if (connState !== 'connected') {
    sitesNoteEl.textContent = 'Connect to the MCP Browser Extension server to see and change the allowed sites.';
  } else if (granted === null) {
    sitesNoteEl.textContent =
      'This MCP Browser Extension server does not take sites from here (it is older, or runs with --no-site-grants). Use --allow-domain instead.';
  } else if (allowed.length === 0) {
    sitesNoteEl.textContent = 'No sites are allowed yet.';
  } else {
    sitesNoteEl.textContent = '';
  }
  const canGrant = connState === 'connected' && granted !== null;
  addSiteEl.disabled = !canGrant;
  newSiteEl.disabled = !canGrant;
}

addSiteEl.addEventListener('click', () => {
  const host = newSiteEl.value.trim();
  if (!host) return;
  newSiteEl.value = '';
  void grant(host, true);
});
newSiteEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSiteEl.click();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.connState) render(String(changes.connState.newValue));
  if (area === 'local' && changes.pairedProfile) renderPairedAs(changes.pairedProfile.newValue);
  if (area === 'local' && (changes.allowedSites || changes.grantedSites || changes.blockedSites || changes.connState)) {
    void renderSites();
  }
});

void renderSites();

void loadExisting();
