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
import type { WirePolicy } from '../../../shared/protocol';

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
  $('allowed-note').textContent = res?.ok ? '' : 'Could not reach the chrome-mcp server. Is your AI client running?';
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
  $('unpaired').hidden = connected || state === 'connecting';

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
}

$('tab-border').addEventListener('change', (e) => {
  void chrome.storage.local.set({ tabBorder: (e.target as HTMLInputElement).checked });
});
$('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage());
$('pair').addEventListener('click', () => void chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.connState || changes.allowedSites || changes.grantedSites || changes.blockedSites || changes.pairedProfile) {
    void render();
  }
});

void render();
