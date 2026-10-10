/**
 * extension/src/popup/popup.ts — the panel that opens under the toolbar icon.
 *
 * At a glance: is this browser paired, may the agent touch the site you are
 * on (with a one-click Allow), which sites it was just refused, and which are
 * allowed. Everything it shows comes from chrome.storage.local, which the
 * service worker keeps current; Allow / Remove / Dismiss go to the worker,
 * which forwards grants to the local server. Pairing details stay on the
 * Options page, one click away.
 */

import { isDomainAllowed } from '../../../shared/policy';
import { STORE_EXTENSION_URL, type WirePolicy } from '../../../shared/protocol';
import { connectWithOneClick } from '../connect';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface BlockedSite {
  host: string;
  method: string;
  at: number;
}

/** Ask the worker to allow or remove a site; it forwards to the local server. */
async function grant(host: string, allow: boolean): Promise<void> {
  const res = (await chrome.runtime.sendMessage({ type: 'site_grant', host, allow }).catch(() => null)) as
    | { ok: boolean; error?: string }
    | null;
  $('allowed-note').textContent = res?.ok ? '' : 'Could not reach the MCP Browser Extension server. Is your AI client running?';
}

function button(label: string, onClick: () => void, kind: 'primary' | 'ghost' | '' = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (kind) b.className = kind;
  b.addEventListener('click', onClick);
  return b;
}

/** A stable, pleasant colour per site, so each one is recognisable at a glance
 *  without fetching its favicon (which would tell a third party what you visit). */
function hue(host: string): string {
  let h = 0;
  for (const c of host.replace(/^\*\./, '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 52%), hsl(${(h + 40) % 360} 70% 44%))`;
}

/** The letter badge for a site: its first letter, skipping www. and *. */
function badge(host: string, cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  const name = host.replace(/^(\*\.|www\.)/, '');
  d.textContent = name.charAt(0) || '?';
  d.style.background = hue(name);
  return d;
}

function tag(text: string): HTMLSpanElement {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = text;
  return t;
}

function row(host: string, extra: HTMLElement[]): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'row';
  const name = document.createElement('span');
  name.className = 'host';
  name.textContent = host;
  name.title = host;
  li.append(badge(host, 'mini'), name, ...extra);
  return li;
}

/** The host of the tab you are looking at, if it is an ordinary web page. */
async function currentHost(): Promise<string | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null;
  } catch {
    return null;
  }
}

async function render(): Promise<void> {
  const s = await chrome.storage.local.get([
    'connState',
    'pairedProfile',
    'allowedSites',
    'grantedSites',
    'blockedSites',
    'tabBorder',
    'latestExtension',
    'updateDismissedFor',
  ]);
  const state = typeof s.connState === 'string' ? s.connState : 'idle';
  const connected = state === 'connected';
  const allowed = Array.isArray(s.allowedSites) ? (s.allowedSites as string[]) : [];
  // null = a server too old for grants, or one run with --no-site-grants.
  const granted = Array.isArray(s.grantedSites) ? (s.grantedSites as string[]) : null;
  const blocked = Array.isArray(s.blockedSites) ? (s.blockedSites as BlockedSite[]) : [];
  const canGrant = connected && granted !== null;
  const policy = { allowDomains: allowed } as WirePolicy;

  // -- status --
  const labels: Record<string, [string, string]> = {
    connected: ['Connected', 'ok'],
    connecting: ['Connecting…', 'warn'],
    unauthorized: ['Token rejected', 'bad'],
    idle: ['Not connected', ''],
  };
  const [text, cls] = labels[state] ?? [state, ''];
  $('state-text').textContent = text;
  $('state').className = `pill ${cls}`;
  $('paired-as').textContent =
    connected && typeof s.pairedProfile === 'string' ? `Paired as ${s.pairedProfile}` : 'Lets your AI agent use this Chrome';
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  // The Connect button is always here: the main action while not connected,
  // a quiet "Reconnect" once connected (to re-pair after a server change).
  const btn = $('connect') as HTMLButtonElement;
  if (!btn.disabled) {
    btn.textContent = connected ? 'Reconnect' : state === 'unauthorized' ? 'Connect again' : 'Connect';
    btn.className = connected ? 'secondary' : 'primary';
  }
  $('connect-card').className = connected ? 'card connect done' : 'card connect';
  $('connect-text').textContent =
    state === 'unauthorized'
      ? 'The server has a new token. One click fetches it and reconnects.'
      : "One click: fetches the port and token from your AI client's server and connects.";

  // -- this site --
  const host = connected ? await currentHost() : null;
  $('this-site').hidden = !host;
  if (host) {
    const ok = isDomainAllowed(`https://${host}/`, policy);
    $('site-host').textContent = host;
    $('site-host').title = host;
    const avatar = $('site-avatar');
    const name = host.replace(/^www\./, '');
    avatar.textContent = name.charAt(0);
    avatar.style.background = hue(name);
    $('site-state').textContent = ok ? '● Agent can use this site' : '● Blocked for the agent';
    $('site-state').className = `chip ${ok ? 'ok' : 'warn'}`;
    $('site-allow').hidden = ok || !canGrant;
    $('site-allow').onclick = () => void grant(host, true);
  }

  // -- blocked just now --
  $('blocked').replaceChildren(
    ...blocked.map((b) =>
      row(b.host, [
        button('Dismiss', () => void chrome.runtime.sendMessage({ type: 'dismiss_blocked', host: b.host }), 'ghost'),
        button('Allow', () => void grant(b.host, true), 'primary'),
      ]),
    ),
  );
  $('blocked-section').hidden = !canGrant || blocked.length === 0;
  $('blocked-count').textContent = String(blocked.length);

  // -- allowed sites --
  $('allowed').replaceChildren(
    ...allowed.map((h) =>
      h === '*'
        ? row('Every site', [tag('--unsafe-all-domains')])
        : granted?.includes(h)
          ? row(h, [button('Remove', () => void grant(h, false), 'ghost')])
          : row(h, [tag('server flag')]),
    ),
  );
  $('allowed-section').hidden = !connected;
  $('allowed-count').textContent = allowed.includes('*') ? 'all' : String(allowed.length);
  if (connected && allowed.length === 0) $('allowed-note').textContent = 'No sites allowed yet.';
  else if (connected && granted === null) $('allowed-note').textContent = 'This server takes sites only from its flags.';

  ($('tab-border') as HTMLInputElement).checked = s.tabBorder !== false;
  void renderUpdate(typeof s.latestExtension === 'string' ? s.latestExtension : null, s.updateDismissedFor);
}

/** Compare dotted versions numerically: >0 when a is newer. */
function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * An unpacked copy never updates through Chrome. Point it at the store copy,
 * which does, saying so more firmly when it is already behind the server's.
 * "Not now" hides it until the next version comes out.
 */
async function renderUpdate(latest: string | null, dismissedFor: unknown): Promise<void> {
  const mine = chrome.runtime.getManifest().version;
  // Unpacked builds carry the store key, so ask Chrome how this copy was installed.
  const unpacked = await chrome.management
    .getSelf()
    .then((me) => me.installType === 'development')
    .catch(() => false);
  const behind = latest !== null && compareVersions(latest, mine) > 0;
  const key = latest ?? mine;
  $('update').hidden = !unpacked || dismissedFor === key;
  $('update-title').textContent = behind ? `Update available: ${latest}` : 'Get automatic updates';
  $('update-text').textContent = behind
    ? `You have ${mine}. This copy was loaded by hand and does not update itself. The Chrome Web Store copy updates automatically.`
    : 'This copy was loaded by hand and does not update itself. Install the Chrome Web Store copy to get every update automatically, then remove this one.';
  $('update-dismiss').onclick = () => void chrome.storage.local.set({ updateDismissedFor: key }).then(render);
}

$('update-store').addEventListener('click', () => void chrome.tabs.create({ url: STORE_EXTENSION_URL }));

$('tab-border').addEventListener('change', (e) => {
  void chrome.storage.local.set({ tabBorder: (e.target as HTMLInputElement).checked });
});
$('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('connect').addEventListener('click', async () => {
  const btn = $('connect') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  $('connect-msg').textContent = '';
  const res = await connectWithOneClick();
  btn.disabled = false;
  if (!res.ok) $('connect-msg').textContent = res.message ?? 'Could not connect.';
  void render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.connState || changes.allowedSites || changes.grantedSites || changes.blockedSites || changes.pairedProfile || changes.latestExtension) {
    void render();
  }
});

void render();
