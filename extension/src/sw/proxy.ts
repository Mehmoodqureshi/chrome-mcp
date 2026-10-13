/**
 * extension/src/sw/proxy.ts — route this Chrome profile through a proxy.
 *
 * Chrome has no per-tab proxy: `chrome.proxy` sets one proxy for the whole
 * profile. So the proxy is a per-profile setting a person makes on the Options
 * page (one Chrome profile per IP), stored in this profile's chrome.storage.local.
 * The agent can only read the status through `proxy_status`; it can never set
 * the proxy, and the password never leaves the extension.
 *
 * Fail closed: `fixed_servers` has no direct fallback, so a dead proxy shows a
 * proxy error page instead of quietly sending traffic from the real IP.
 */

import type { ProxyWireStatus } from '../../../shared/protocol';
import { PROXY_STORAGE_KEY, parseProxyConfig } from '../../../shared/proxy';

export { PROXY_STORAGE_KEY };

/**
 * Never proxied: the loopback socket to the MCP server (proxying it would cut
 * the extension off its own server) and the local network.
 */
const BYPASS = ['127.0.0.1', 'localhost', '[::1]', '<local>'];

/** Exit-IP lookups, tried in order. Only fetched when `proxy_status` asks. */
const IP_LOOKUPS: ReadonlyArray<{ url: string; read: (j: Record<string, unknown>) => Pick<ProxyWireStatus, 'exitIp' | 'country' | 'city'> }> = [
  {
    url: 'https://ipinfo.io/json',
    read: (j) => ({
      exitIp: typeof j.ip === 'string' ? j.ip : null,
      ...(typeof j.country === 'string' ? { country: j.country } : {}),
      ...(typeof j.city === 'string' ? { city: j.city } : {}),
    }),
  },
  { url: 'https://api.ipify.org?format=json', read: (j) => ({ exitIp: typeof j.ip === 'string' ? j.ip : null }) },
];
const IP_LOOKUP_TIMEOUT_MS = 8_000;

export async function loadProxyConfig(): Promise<ReturnType<typeof parseProxyConfig>> {
  const stored = await chrome.storage.local.get(PROXY_STORAGE_KEY);
  return parseProxyConfig(stored[PROXY_STORAGE_KEY]);
}

async function hasPrivacyPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['privacy'] });
  } catch {
    return false;
  }
}

/**
 * WebRTC talks UDP straight past an HTTP proxy and can reveal the real IP. With
 * the optional `privacy` permission granted, keep it on proxied paths only.
 */
async function setWebrtcProtection(on: boolean): Promise<void> {
  if (!(await hasPrivacyPermission())) return;
  const setting = chrome.privacy.network.webRTCIPHandlingPolicy;
  if (on) await setting.set({ value: 'disable_non_proxied_udp' });
  else await setting.clear({});
}

/** Apply the stored config to Chrome: set the proxy when enabled, clear it otherwise. */
export async function applyProxy(log: (m: string) => void): Promise<void> {
  const cfg = await loadProxyConfig();
  if (cfg?.enabled) {
    await chrome.proxy.settings.set({
      value: {
        mode: 'fixed_servers',
        rules: { singleProxy: { scheme: cfg.scheme, host: cfg.host, port: cfg.port }, bypassList: BYPASS },
      },
      scope: 'regular',
    });
    await setWebrtcProtection(true);
    log(`proxy on: ${cfg.scheme}://${cfg.host}:${cfg.port}`);
  } else {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await setWebrtcProtection(false);
    log('proxy off');
  }
}

/** Proxy auth attempts per request, so a wrong password fails once instead of looping. */
const authTries = new Map<string, number>();

/**
 * Answer the proxy's 407 with the stored username and password. Chrome ignores
 * credentials written into the proxy address, so this is the only way to log in.
 * Registered at top level of the service worker so a wake re-arms it.
 */
export function onProxyAuth(
  details: chrome.webRequest.WebAuthenticationChallengeDetails,
  callback?: (response: chrome.webRequest.BlockingResponse) => void,
): void {
  const reply = callback ?? (() => undefined);
  if (!details.isProxy) {
    reply({});
    return;
  }
  void loadProxyConfig().then((cfg) => {
    const tries = authTries.get(details.requestId) ?? 0;
    const ours = cfg?.enabled && cfg.username && details.challenger?.host === cfg.host;
    if (!ours || tries >= 1) {
      // Not our proxy, or our credentials were already refused: let Chrome fail it.
      authTries.delete(details.requestId);
      reply(ours ? { cancel: true } : {});
      return;
    }
    authTries.set(details.requestId, tries + 1);
    if (authTries.size > 500) authTries.clear();
    reply({ authCredentials: { username: cfg.username, password: cfg.password } });
  });
}

/** Ask an IP-echo service what address sites see. Goes through the profile's proxy. */
async function lookupExitIp(): Promise<Pick<ProxyWireStatus, 'exitIp' | 'country' | 'city' | 'error'>> {
  let lastError = 'lookup failed';
  for (const svc of IP_LOOKUPS) {
    try {
      const res = await fetch(svc.url, { cache: 'no-store', signal: AbortSignal.timeout(IP_LOOKUP_TIMEOUT_MS) });
      if (!res.ok) {
        lastError = `${new URL(svc.url).host} answered HTTP ${res.status}`;
        continue;
      }
      const out = svc.read((await res.json()) as Record<string, unknown>);
      if (out.exitIp) return out;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { exitIp: null, error: `could not reach an IP lookup service (${lastError}); the proxy may be down or refusing the login` };
}

/** A ChromeSetting's current value and who controls it. The bundled
 *  @types/chrome types the promise form of `get` as void, so wrap the callback. */
function readSetting(setting: chrome.types.ChromeSetting, details: chrome.types.ChromeSettingGetDetails): Promise<chrome.types.ChromeSettingGetResultDetails> {
  return new Promise((resolve) => setting.get(details, resolve));
}

/** What `proxy_status` reports. Never includes the username or password. */
export async function proxyStatus(): Promise<ProxyWireStatus> {
  const cfg = await loadProxyConfig();
  const current = await readSetting(chrome.proxy.settings, { incognito: false });
  const webrtcProtected =
    (await hasPrivacyPermission()) &&
    (await readSetting(chrome.privacy.network.webRTCIPHandlingPolicy, {})).value === 'disable_non_proxied_udp';
  return {
    enabled: cfg?.enabled === true,
    server: cfg ? `${cfg.scheme}://${cfg.host}:${cfg.port}` : null,
    auth: Boolean(cfg?.username),
    control: current.levelOfControl,
    webrtcProtected,
    ...(await lookupExitIp()),
  };
}
