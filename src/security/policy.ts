/**
 * src/security/policy.ts — the default-deny domain policy and capability gate.
 *
 * This is the real exfiltration firewall. Because this tool feeds untrusted page
 * text to an LLM that can call `eval`, prompt-injection-to-exfil is a PRIMARY
 * threat, so the policy:
 *   - is ON by default with a SAFE default (empty allowlist, no eval, no
 *     downloads, mutations disabled),
 *   - gates READS as well as writes (reads are the exfil payload),
 *   - is enforced at BOTH ends — the executor dispatch (server) AND the
 *     extension router — before any attach/navigate/eval/read.
 *
 * `assertUrlAllowed(url, method, policy)` is the single chokepoint. It throws an
 * `ExecutorError('POLICY_DENIED', …)` which the never-throw dispatch firewall
 * renders as a structured MCP error.
 */

import type { WireMethod } from '../../shared/protocol';
import { ExecutorError } from '../executor/types';

// ---------------------------------------------------------------------------
// Policy shape + defaults
// ---------------------------------------------------------------------------

export interface Policy {
  /** Glob domain allowlist, e.g. ['example.com', '*.example.com', '*']. Empty = deny all. */
  allowDomains: string[];
  /** Allow the `eval` primitive at all. */
  allowEval: boolean;
  /** Allow `download_file`. */
  allowDownloads: boolean;
  /** Allow acting on / reading tabs whose URL is not in `allowDomains` is governed
   *  by `allowDomains`; this flag instead relaxes tab *management* (list/select)
   *  to all tabs regardless of their URL. Default false. */
  allowAllTabs: boolean;
  /** Safe-mode master switch for the mutating tool set (click/type/navigate/…). */
  enableMutations: boolean;
}

/** The SAFE default: deny everything until the user opts in. */
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  allowDomains: [],
  allowEval: false,
  allowDownloads: false,
  allowAllTabs: false,
  enableMutations: false,
});

/** Merge a partial (from a policy file and/or CLI flags) over the safe default. */
export function resolvePolicy(partial?: Partial<Policy>): Policy {
  return {
    allowDomains: partial?.allowDomains ?? [...DEFAULT_POLICY.allowDomains],
    allowEval: partial?.allowEval ?? DEFAULT_POLICY.allowEval,
    allowDownloads: partial?.allowDownloads ?? DEFAULT_POLICY.allowDownloads,
    allowAllTabs: partial?.allowAllTabs ?? DEFAULT_POLICY.allowAllTabs,
    enableMutations: partial?.enableMutations ?? DEFAULT_POLICY.enableMutations,
  };
}

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

/** Tab management — mutation-gated, but not content-URL-gated (unless allowAllTabs is off). */
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
function isUrlGated(method: WireMethod): boolean {
  return READ_CONTENT.has(method) || MUTATE_CONTENT.has(method) || NAVIGATION.has(method) || method === 'eval';
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

/** Convert a single domain glob to a predicate. '*' matches everything;
 *  '*.example.com' matches example.com and any subdomain; otherwise exact host. */
function globMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === '*' || p === '*://*/*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === p;
}

export function isDomainAllowed(url: string, policy: Policy): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return policy.allowDomains.some((pat) => globMatches(host, pat));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Throw `POLICY_DENIED` unless `method` against `url` is permitted by `policy`.
 * `url` is the DESTINATION for navigation, otherwise the current tab URL.
 * Pure and side-effect-free so it can run identically on server and extension.
 */
export function assertUrlAllowed(url: string, method: WireMethod, policy: Policy): void {
  // -- capability gates (independent of URL) --
  if (method === 'eval' && !policy.allowEval) {
    throw new ExecutorError(
      'POLICY_DENIED',
      'eval is disabled (safe-mode). Pass --unsafe-enable-eval to allow it.',
    );
  }
  if (method === 'download_file' && !policy.allowDownloads) {
    throw new ExecutorError(
      'POLICY_DENIED',
      'downloads are disabled. Pass --enable-downloads or set allowDownloads.',
    );
  }
  if (isMutatingMethod(method) && !policy.enableMutations) {
    throw new ExecutorError(
      'POLICY_DENIED',
      `mutating tool "${method}" is disabled (safe-mode). Pass --enable-mutations to allow it.`,
    );
  }

  // -- tab management without allowAllTabs still needs the target tab's URL allowlisted,
  //    but list/select/close don't carry a content URL here; treat them as allowed once
  //    the mutation gate above has passed (URL-gating of their effect happens on the
  //    subsequent content op). --
  if (!isUrlGated(method)) return;

  // Navigating to a blank page is always fine.
  if (isAboutBlank(url) && NAVIGATION.has(method)) return;

  if (!isDomainAllowed(url, policy)) {
    const host = hostOf(url) || url;
    throw new ExecutorError(
      'POLICY_DENIED',
      `"${method}" denied: ${host} is not in the domain allowlist. ` +
        `Add it to allowDomains, or pass --unsafe-all-domains.`,
    );
  }
}
