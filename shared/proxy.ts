/**
 * shared/proxy.ts — the proxy setting a person saves on the Options page.
 *
 * Pure parsing, no Chrome deps, so the extension (which applies it) and the
 * tests share one definition. The setting lives in the extension's
 * chrome.storage.local under PROXY_STORAGE_KEY and never travels on the wire.
 */

export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxyConfig {
  enabled: boolean;
  scheme: ProxyScheme;
  host: string;
  port: number;
  username: string;
  password: string;
}

export const PROXY_STORAGE_KEY = 'proxy';
const SCHEMES: readonly ProxyScheme[] = ['http', 'https', 'socks4', 'socks5'];

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** Parse whatever is in storage into a config, or null when it is unusable. */
export function parseProxyConfig(raw: unknown): ProxyConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const scheme = SCHEMES.includes(r.scheme as ProxyScheme) ? (r.scheme as ProxyScheme) : 'http';
  const host = typeof r.host === 'string' ? r.host.trim() : '';
  const port = Number(r.port);
  if (!host || !validPort(port)) return null;
  return {
    enabled: r.enabled === true,
    scheme,
    host,
    port,
    username: typeof r.username === 'string' ? r.username : '',
    password: typeof r.password === 'string' ? r.password : '',
  };
}

/**
 * Split the one-line form proxy providers hand out — `host:port` or
 * `host:port:user:pass`, optionally with a `scheme://` prefix — into fields.
 * The password may itself contain colons. Null when the line has no valid port.
 */
export function parseProxyLine(
  line: string,
): { scheme?: ProxyScheme; host: string; port: number; username?: string; password?: string } | null {
  const m = /^([a-z0-9]+):\/\//i.exec(line.trim());
  const scheme = m && SCHEMES.includes(m[1].toLowerCase() as ProxyScheme) ? (m[1].toLowerCase() as ProxyScheme) : undefined;
  const parts = line.trim().slice(m ? m[0].length : 0).split(':');
  const port = Number(parts[1]);
  if (parts.length < 2 || !parts[0] || !/^\d+$/.test(parts[1]) || !validPort(port)) return null;
  return {
    ...(scheme ? { scheme } : {}),
    host: parts[0],
    port,
    ...(parts.length >= 4 ? { username: parts[2], password: parts.slice(3).join(':') } : {}),
  };
}
