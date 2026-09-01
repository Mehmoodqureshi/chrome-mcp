/**
 * shared/observers.ts — the record shapes produced by the in-page observer hook
 * (`extension/src/page/hook.ts`) and consumed by the `console_logs`,
 * `network_log` and `dialogs` tools.
 *
 * Why an in-page hook rather than the CDP `Log`/`Console`/`Network` domains: the
 * executor attaches `chrome.debugger` for the duration of ONE op and detaches in
 * `finally` (that is what keeps the "being debugged" banner off the user's
 * browser and keeps other CDP clients working). Observing console and network
 * needs a session that spans commands, which that model cannot provide. A
 * MAIN-world hook installed at document_start costs no attach, survives the
 * service worker being recycled (the buffers live in the page), and captures
 * exactly what page code did — which is what an agent debugging a page is
 * asking about.
 *
 * The trade-off, stated plainly: `network_log` sees `fetch` and
 * `XMLHttpRequest` — the calls page code makes — plus whatever the Resource
 * Timing API reports for everything else. It does not see the document request,
 * redirects, or request/response headers.
 */

import { normalizeDomainPattern } from './policy';
import type { WirePolicy } from './protocol';

/** Bumped when the hook's on-page state shape changes. */
export const OBSERVER_HOOK_VERSION = 1 as const;

/** The MAIN-world global the hook installs its state on. */
export const OBSERVER_GLOBAL = '__chromeMcpObservers' as const;

/** Ring-buffer ceilings, enforced in-page so a chatty site cannot grow unbounded. */
export const MAX_CONSOLE_ENTRIES = 500;
export const MAX_NETWORK_ENTRIES = 300;
export const MAX_DIALOG_ENTRIES = 50;

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'exception';

export interface ConsoleEntry {
  /** Monotonic per-page sequence, so a caller can poll for "what is new". */
  seq: number;
  ts: number;
  level: ConsoleLevel;
  text: string;
  /** Present for `exception`: the error's stack, trimmed. */
  stack?: string;
  url?: string;
}

export interface NetworkEntry {
  seq: number;
  ts: number;
  /** 'fetch' | 'xhr' | 'resource' (the Resource Timing fallback). */
  via: 'fetch' | 'xhr' | 'resource';
  method: string;
  url: string;
  status?: number;
  ok?: boolean;
  durationMs?: number;
  /** Set when the request rejected (network error, CORS, abort). */
  error?: string;
  /** Resource Timing only: the initiator type Chrome reports (script, img, css…). */
  initiator?: string;
  bytes?: number;
}

export type DialogKind = 'alert' | 'confirm' | 'prompt' | 'beforeunload';

export interface DialogEntry {
  seq: number;
  ts: number;
  kind: DialogKind;
  message: string;
  /** What the hook answered on the page's behalf. */
  answered: string;
}

/**
 * How the hook answers a native dialog. `dismiss` is the default: it is what a
 * blocked renderer would eventually be told anyway, and it never confirms a
 * destructive action the agent did not ask for. `accept` is opt-in per tab.
 */
export type DialogPolicy = 'dismiss' | 'accept';

export interface ObserverReadResult {
  /** Absent hook (observers disabled, or the page loaded before it registered). */
  installed: boolean;
  hookVersion?: number;
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  dialogs?: DialogEntry[];
  dialogPolicy?: DialogPolicy;
  /** True when the ring buffer dropped older entries before this read. */
  dropped?: boolean;
}

/**
 * Runs IN THE PAGE (MAIN world), serialized to source — so it must be
 * self-contained and takes the global's name rather than importing the constant.
 *
 * Draining is explicit: `clear` empties the buffers it returned, and `sinceSeq`
 * lets a caller poll for only what is new. Nothing here reaches out; it reads
 * what the hook already recorded on this page.
 */
export function readObservers(
  globalName: string,
  opts: {
    console?: boolean;
    network?: boolean;
    dialogs?: boolean;
    sinceSeq?: number;
    limit?: number;
    clear?: boolean;
    setPolicy?: string | null;
    promptText?: string | null;
    includeResources?: boolean;
  },
): unknown {
  interface State {
    v: number;
    seq: number;
    console: Array<{ seq: number }>;
    network: Array<{ seq: number }>;
    dialogs: Array<{ seq: number }>;
    dialogPolicy: string;
    promptText: string;
    dropped: boolean;
    resourceCursor: number;
  }
  const state = (window as unknown as Record<string, State | undefined>)[globalName];
  if (!state) return { installed: false };

  if (opts.setPolicy === 'dismiss' || opts.setPolicy === 'accept') state.dialogPolicy = opts.setPolicy;
  if (typeof opts.promptText === 'string') state.promptText = opts.promptText;

  const since = typeof opts.sinceSeq === 'number' ? opts.sinceSeq : 0;
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : 200;
  const take = <T extends { seq: number }>(buf: T[]): T[] => {
    const picked = buf.filter((e) => e.seq > since);
    return picked.length > limit ? picked.slice(picked.length - limit) : picked;
  };

  // Resource Timing covers what the fetch/XHR patches structurally cannot see
  // (documents, scripts, images, styles). It carries no status code, so those
  // entries report timing and size only — stated, not implied.
  if (opts.network && opts.includeResources) {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (let i = state.resourceCursor; i < entries.length; i++) {
        const r = entries[i];
        state.network.push({
          seq: ++state.seq,
          ts: Math.round(performance.timeOrigin + r.startTime),
          via: 'resource',
          method: 'GET',
          url: r.name.length > 2000 ? `${r.name.slice(0, 2000)}…` : r.name,
          durationMs: Math.round(r.duration),
          initiator: r.initiatorType,
          bytes: r.transferSize || undefined,
        } as unknown as { seq: number });
      }
      state.resourceCursor = entries.length;
    } catch {
      /* Resource Timing unavailable — the fetch/XHR records still stand */
    }
  }

  const out: Record<string, unknown> = {
    installed: true,
    hookVersion: state.v,
    dialogPolicy: state.dialogPolicy,
    dropped: state.dropped,
  };
  if (opts.console) out.console = take(state.console);
  if (opts.network) out.network = take(state.network);
  if (opts.dialogs) out.dialogs = take(state.dialogs);

  if (opts.clear) {
    if (opts.console) state.console.length = 0;
    if (opts.network) state.network.length = 0;
    if (opts.dialogs) state.dialogs.length = 0;
    state.dropped = false;
  }
  return out;
}

/**
 * Translate the domain allowlist into Chrome match patterns for registering the
 * hook as a content script. A bare host becomes `*://host/*`; `*.host` becomes
 * `*://*.host/*` (which Chrome reads as the host AND its subdomains, matching
 * how the allowlist itself behaves); `*` becomes `<all_urls>`. Entries carrying
 * no host are dropped rather than widened — the page the tool may not read is
 * also the page it must not instrument.
 */
export function observerMatches(policy: WirePolicy): string[] {
  if (policy.allowObservers !== true) return [];
  const out = new Set<string>();
  for (const raw of policy.allowDomains ?? []) {
    const p = normalizeDomainPattern(raw);
    if (!p) continue;
    if (p === '*') return ['<all_urls>'];
    out.add(`*://${p}/*`);
  }
  return [...out];
}
