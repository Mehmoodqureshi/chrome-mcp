/**
 * shared/policy.ts — the PURE policy decision, imported VERBATIM by both the
 * server (src/security/policy.ts wraps it to throw ExecutorError) and the
 * extension (router mirrors it to throw CmdError). Keeping the decision in one
 * shared module is what makes the two ends provably agree — the gate is then
 * genuinely enforced "at both ends" (server dispatch AND extension router).
 *
 * No throwing, no Node/Chrome deps: returns a verdict the caller renders into
 * whatever error type it uses.
 */

import type { WireMethod, WirePolicy } from './protocol';

// ---------------------------------------------------------------------------
// Method classification
// ---------------------------------------------------------------------------

/** Methods that read page CONTENT (the exfil payload) — URL-gated. */
const READ_CONTENT: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'get_text',
  'get_html',
  'screenshot',
  'wait_for',
]);

/** Content-mutating actions — URL-gated AND mutation-gated. */
const MUTATE_CONTENT: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'click',
  'type',
  'press',
  'hover',
  'scroll',
]);

/** Navigation — URL-gated by the DESTINATION url, and mutation-gated. */
const NAVIGATION: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'navigate',
  'back',
  'forward',
  'reload',
]);

/** Tab management — mutation-gated, but not content-URL-gated. */
const TAB_MUTATE: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'tab_select',
  'tab_new',
  'tab_close',
]);

export function isReadMethod(method: WireMethod): boolean {
  return READ_CONTENT.has(method) || method === 'tabs_list';
}

/** Everything in the mutating tool set that safe-mode disables. `eval` is gated
 *  separately via `allowEval`; `download_file` separately via `allowDownloads`. */
export function isMutatingMethod(method: WireMethod): boolean {
  return MUTATE_CONTENT.has(method) || NAVIGATION.has(method) || TAB_MUTATE.has(method);
}

/** Whether the method touches a specific URL that must be allowlisted. */
export function isUrlGated(method: WireMethod): boolean {
  return (
    READ_CONTENT.has(method) ||
    MUTATE_CONTENT.has(method) ||
    NAVIGATION.has(method) ||
    method === 'eval' ||
    method === 'upload_file'
  );
}

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

/** Parse a host out of a URL string; '' if it has none (about:blank, data:, …). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAboutBlank(url: string): boolean {
  return url === 'about:blank' || url === '' || url.startsWith('about:');
}

/**
 * Reduce an allowlist entry to the bare host it constrains. Users routinely paste
 * a full URL ("https://example.com/app") or a "host:port/path" instead of a bare
 * host; those forms would never equal a hostname and so silently match nothing.
 * We strip the scheme, userinfo, port, and path/query/fragment, preserving a
 * leading "*." wildcard and the two catch-all forms. Returns '' for a pattern
 * that carries no host (which then matches nothing).
 */
function normalizeDomainPattern(pattern: string): string {
  let p = pattern.trim().toLowerCase();
  if (p === '*' || p === '*://*/*') return '*';
  // Strip a leading scheme ("https://", "http://", any "scheme://").
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Drop everything from the first path/query/fragment separator onward.
  p = p.replace(/[/?#].*$/, '');
  // Strip userinfo ("user:pass@") then a trailing port (":8080").
  p = p.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  return p;
}

/** Convert a single domain glob to a predicate. '*' matches everything;
 *  '*.example.com' matches example.com and any subdomain; otherwise exact host.
 *  URL/port/path forms are normalized to their bare host first. */
function globMatches(host: string, pattern: string): boolean {
  const p = normalizeDomainPattern(pattern);
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return p !== '' && host === p;
}

export function isDomainAllowed(url: string, policy: WirePolicy): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return policy.allowDomains.some((pat) => globMatches(host, pat));
}

// ---------------------------------------------------------------------------
// The gate (pure)
// ---------------------------------------------------------------------------

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether `method` against `url` is permitted by `policy`. `url` is the
 * DESTINATION for navigation, otherwise the current tab URL. Pure: returns a
 * verdict; the caller throws its own error type on `{ ok: false }`.
 */
export function evaluatePolicy(url: string, method: WireMethod, policy: WirePolicy): PolicyVerdict {
  // -- capability gates (independent of URL) --
  if (method === 'eval' && !policy.allowEval) {
    return { ok: false, reason: 'eval is disabled (safe-mode). Pass --unsafe-enable-eval to allow it.' };
  }
  if (method === 'download_file' && !policy.allowDownloads) {
    return { ok: false, reason: 'downloads are disabled. Pass --enable-downloads or set allowDownloads.' };
  }
  if (method === 'upload_file' && !policy.allowUploads) {
    return {
      ok: false,
      reason:
        'uploads are disabled (sending local files to a page is an exfiltration risk). ' +
        'Pass --enable-uploads or set allowUploads.',
    };
  }
  if (isMutatingMethod(method) && !policy.enableMutations) {
    return {
      ok: false,
      reason: `mutating tool "${method}" is disabled (safe-mode). Pass --enable-mutations to allow it.`,
    };
  }

  // Methods that don't carry a content URL pass once the gates above are clear.
  if (!isUrlGated(method)) return { ok: true };

  // Navigating to a blank page is always fine.
  if (isAboutBlank(url) && NAVIGATION.has(method)) return { ok: true };

  if (!isDomainAllowed(url, policy)) {
    const host = hostOf(url) || url;
    return { ok: false, reason: blockedDomainMessage(method, host, policy) };
  }
  return { ok: true };
}

/**
 * A plain-English, actionable message for a blocked domain. Tells the user what
 * happened, why it's blocked (safety, not a bug), which sites ARE allowed, and
 * the exact one-line change to permit this one — so a non-technical user is never
 * left at a dead end. Never includes the token or any other secret.
 */
export function blockedDomainMessage(method: string, host: string, policy: WirePolicy): string {
  const allowed = policy.allowDomains.filter((d) => d !== '*');
  const allowedLine = allowed.length
    ? `Currently allowed: ${allowed.join(', ')}.`
    : `Right now no sites are allowed.`;
  return (
    `Blocked: "${method}" can't run on ${host} because it isn't on this browser tool's allowed-sites list. ` +
    `This is a safety limit (the tool drives your real, logged-in browser, so it only touches sites you've approved) — not an error. ` +
    `${allowedLine} ` +
    `To allow ${host}, add it to the chrome-mcp settings as: --allow-domain "${host}" (or "*.${host}" to include subdomains), ` +
    `then restart/reconnect. To allow every site (less safe), use --unsafe-all-domains.`
  );
}

/** A wire policy that allows nothing — the safe default when none was delivered. */
export const DENY_ALL_WIRE_POLICY: WirePolicy = {
  allowDomains: [],
  allowEval: false,
  allowDownloads: false,
  allowUploads: false,
  allowAllTabs: false,
  enableMutations: false,
};
