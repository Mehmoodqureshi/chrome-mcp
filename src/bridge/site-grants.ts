/**
 * src/bridge/site-grants.ts — sites allowed at runtime from the extension.
 *
 * The allowlist used to be fixed by flags at startup, so the first site a new
 * user tried was refused and the fix was "edit your MCP config, then restart the
 * client". Telemetry showed that wall in front of almost half the installs that
 * ever made a call. Now the person clicks Allow on the extension's Options page;
 * the hub adds the site to the LIVE policy (the same `allowDomains` array the
 * server gate and every welcome frame read), saves it to
 * `<dataDir>/allowed-sites.json` so it survives restarts, and pushes the new
 * policy to every paired browser and peer.
 *
 * Grants only ever ADD to the flags' list, and only grants can be removed again:
 * a site that came from `--allow-domain` stays until the flags change. A grant
 * is always one concrete host (or `*.host`), never the `*` catch-all — allowing
 * every site stays a deliberate flag (`--unsafe-all-domains`).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeDomainPattern } from '../../shared/policy';

export const GRANTS_FILE = 'allowed-sites.json';

/** A bound on how many sites can be granted, so the file and frames stay small. */
const MAX_GRANTS = 500;

interface GrantsFile {
  sites: string[];
}

/**
 * Reduce what the person typed (a host, a URL, `*.host`) to the pattern to
 * store, or null when it names no single site. Rejects the catch-alls and
 * anything that is not a plausible hostname.
 */
export function normalizeGrant(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const p = normalizeDomainPattern(input);
  if (!p || p === '*') return null;
  const host = p.startsWith('*.') ? p.slice(2) : p;
  if (host.length > 253 || host.includes('*')) return null;
  // Labels of letters, digits and hyphens, or an IPv4 address; `localhost` counts.
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) return null;
  return p;
}

export class SiteGrants {
  private sites: string[] = [];
  /** The flags' own entries (lower-cased): never granted, never revoked. */
  private readonly base: Set<string>;

  /**
   * `allowDomains` is the live policy array: grants are spliced into it in
   * place, so every reader of that array sees them at once. `base` is the
   * flags' own list, which a revoke never touches. `dataDir` undefined → kept
   * in memory only.
   */
  constructor(
    private readonly allowDomains: string[],
    private readonly dataDir?: string,
  ) {
    this.base = new Set(allowDomains.map((d) => d.toLowerCase()));
    for (const site of this.load()) this.add(site);
  }

  /** The sites granted at runtime, in the order they were added. */
  list(): string[] {
    return [...this.sites];
  }

  /**
   * Allow or remove a site. Returns the stored pattern when the live policy
   * changed, null when it did not (an invalid host, already in that state, a
   * flag-configured site, or the grant cap reached).
   */
  apply(input: unknown, allow: boolean, persist = true): string | null {
    const site = normalizeGrant(input);
    if (!site) return null;
    const changed = allow ? this.add(site) : this.remove(site);
    if (changed && persist) this.save();
    return changed ? site : null;
  }

  private add(site: string): boolean {
    if (this.sites.includes(site)) return false;
    if (this.sites.length >= MAX_GRANTS) return false;
    // Already allowed by the flags: nothing to grant, and nothing to remove later.
    if (this.base.has(site)) return false;
    this.sites.push(site);
    if (!this.allowDomains.includes(site)) this.allowDomains.push(site);
    return true;
  }

  private remove(site: string): boolean {
    const i = this.sites.indexOf(site);
    if (i < 0) return false;
    this.sites.splice(i, 1);
    if (!this.base.has(site)) {
      const j = this.allowDomains.indexOf(site);
      if (j >= 0) this.allowDomains.splice(j, 1);
    }
    return true;
  }

  private load(): string[] {
    if (!this.dataDir) return [];
    const path = join(this.dataDir, GRANTS_FILE);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GrantsFile>;
      return Array.isArray(parsed.sites) ? parsed.sites.map(normalizeGrant).filter((s): s is string => !!s) : [];
    } catch {
      // A corrupt file must not stop the server: start empty, rewrite on next grant.
      return [];
    }
  }

  private save(): void {
    if (!this.dataDir) return;
    const path = join(this.dataDir, GRANTS_FILE);
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ sites: this.sites } satisfies GrantsFile, null, 2), { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // Best-effort: the grant still holds for this run, it just won't persist.
    }
  }
}
