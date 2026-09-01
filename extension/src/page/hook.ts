/**
 * extension/src/page/hook.ts — the MAIN-world observer, registered at
 * document_start for allowlisted sites when `--enable-observers` is on.
 *
 * It does three things the rest of the tool surface structurally cannot:
 *   1. records `console.*` output and uncaught errors, so an agent can see WHY a
 *      page broke instead of only what the DOM looks like afterwards,
 *   2. records `fetch`/`XMLHttpRequest` traffic, so a failing API call is
 *      visible,
 *   3. intercepts `alert`/`confirm`/`prompt`/`beforeunload`, which otherwise
 *      block the renderer — a click that opens a `confirm()` used to hang every
 *      injected script on the page until the command timed out, and reported
 *      that as TIMEOUT with nothing to point at.
 *
 * House rules, because this runs inside the user's real, logged-in pages:
 *   - every patch calls through to the original,
 *   - every hook body is wrapped so a fault here can never break the page,
 *   - installation is idempotent (a second injection is a no-op),
 *   - buffers are bounded ring buffers, so a chatty site cannot grow them.
 *
 * NOTHING here is sent anywhere on its own. The buffers sit in the page until a
 * `console_logs` / `network_log` / `dialogs` tool call reads them, and that read
 * goes through the same domain policy gate as any other page read.
 */

import {
  MAX_CONSOLE_ENTRIES,
  MAX_DIALOG_ENTRIES,
  MAX_NETWORK_ENTRIES,
  OBSERVER_GLOBAL,
  OBSERVER_HOOK_VERSION,
  type ConsoleEntry,
  type ConsoleLevel,
  type DialogEntry,
  type DialogKind,
  type DialogPolicy,
  type NetworkEntry,
} from '../../../shared/observers';

interface ObserverState {
  v: number;
  seq: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  dialogs: DialogEntry[];
  dialogPolicy: DialogPolicy;
  promptText: string;
  dropped: boolean;
  resourceCursor: number;
}

declare global {
  interface Window {
    [OBSERVER_GLOBAL]?: ObserverState;
  }
}

(function install(): void {
  try {
    const w = window as unknown as Window & Record<string, unknown>;
    if (w[OBSERVER_GLOBAL]) return; // already installed on this page

    const state: ObserverState = {
      v: OBSERVER_HOOK_VERSION,
      seq: 0,
      console: [],
      network: [],
      dialogs: [],
      dialogPolicy: 'dismiss',
      promptText: '',
      dropped: false,
      resourceCursor: 0,
    };
    Object.defineProperty(w, OBSERVER_GLOBAL, { value: state, writable: true, enumerable: false, configurable: true });

    /** Append with a ceiling; note when the ring starts dropping. */
    const push = <T>(buf: T[], entry: T, max: number): void => {
      buf.push(entry);
      if (buf.length > max) {
        buf.splice(0, buf.length - max);
        state.dropped = true;
      }
    };

    /** Render one console argument without ever throwing or unbounded growth. */
    const render = (value: unknown, depth = 0): string => {
      try {
        if (value === null) return 'null';
        if (value === undefined) return 'undefined';
        const t = typeof value;
        if (t === 'string') return value as string;
        if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
        if (t === 'function') return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
        if (value instanceof Error) return `${value.name}: ${value.message}`;
        if (value instanceof Element) return `<${value.tagName.toLowerCase()}>`;
        if (depth >= 2) return Array.isArray(value) ? '[Array]' : '[Object]';
        if (Array.isArray(value)) {
          return `[${value.slice(0, 20).map((v) => render(v, depth + 1)).join(', ')}${value.length > 20 ? ', …' : ''}]`;
        }
        const entries = Object.entries(value as Record<string, unknown>).slice(0, 20);
        return `{${entries.map(([k, v]) => `${k}: ${render(v, depth + 1)}`).join(', ')}}`;
      } catch {
        return '[unrenderable]';
      }
    };

    const CAP = 2_000;
    const clamp = (s: string): string => (s.length > CAP ? `${s.slice(0, CAP)}…[${s.length} chars]` : s);

    const record = (level: ConsoleLevel, text: string, extra?: { stack?: string }): void => {
      push<ConsoleEntry>(
        state.console,
        {
          seq: ++state.seq,
          ts: Date.now(),
          level,
          text: clamp(text),
          ...(extra?.stack ? { stack: clamp(extra.stack) } : {}),
          url: location.href,
        },
        MAX_CONSOLE_ENTRIES,
      );
    };

    // -- 1. console + uncaught errors ---------------------------------------
    const LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of LEVELS) {
      const original = (console as unknown as Record<string, ((...a: unknown[]) => void) | undefined>)[level];
      if (typeof original !== 'function') continue;
      (console as unknown as Record<string, (...a: unknown[]) => void>)[level] = function patched(...args: unknown[]): void {
        try {
          record(level, args.map((v) => render(v)).join(' '));
        } catch {
          /* observing must never break logging */
        }
        original.apply(console, args);
      };
    }

    window.addEventListener(
      'error',
      (e: ErrorEvent) => {
        try {
          const err = e.error as Error | undefined;
          const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
          record('exception', `${e.message}${where}`, { stack: err?.stack });
        } catch {
          /* ignore */
        }
      },
      true,
    );

    window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
      try {
        const r = e.reason as { message?: string; stack?: string } | undefined;
        record('exception', `Unhandled rejection: ${r?.message ?? render(e.reason)}`, { stack: r?.stack });
      } catch {
        /* ignore */
      }
    });

    // -- 2. network ---------------------------------------------------------
    const netStart = (via: NetworkEntry['via'], method: string, url: string): NetworkEntry => {
      const entry: NetworkEntry = { seq: ++state.seq, ts: Date.now(), via, method, url };
      push(state.network, entry, MAX_NETWORK_ENTRIES);
      return entry;
    };

    const absolute = (url: string): string => {
      try {
        return new URL(url, location.href).href;
      } catch {
        return url;
      }
    };

    const originalFetch = w.fetch as typeof fetch | undefined;
    if (typeof originalFetch === 'function') {
      w.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        let entry: NetworkEntry | null = null;
        let began = 0;
        try {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url ?? String(input);
          const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
          began = Date.now();
          entry = netStart('fetch', method, clamp(absolute(url)));
        } catch {
          /* observing must never break the request */
        }
        return originalFetch.call(w, input as RequestInfo, init).then(
          (res) => {
            if (entry) {
              entry.status = res.status;
              entry.ok = res.ok;
              entry.durationMs = Date.now() - began;
            }
            return res;
          },
          (err: unknown) => {
            if (entry) {
              entry.error = clamp(err instanceof Error ? err.message : String(err));
              entry.durationMs = Date.now() - began;
            }
            throw err;
          },
        );
      } as typeof fetch;
    }

    const XHR = w.XMLHttpRequest as typeof XMLHttpRequest | undefined;
    if (typeof XHR === 'function') {
      const open = XHR.prototype.open;
      const send = XHR.prototype.send;
      const MARK = '__chromeMcpEntry';
      XHR.prototype.open = function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
        try {
          (this as unknown as Record<string, unknown>)[MARK] = {
            method: String(method ?? 'GET').toUpperCase(),
            url: absolute(String(url)),
          };
        } catch {
          /* ignore */
        }
        return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
      } as typeof XHR.prototype.open;
      XHR.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        let entry: NetworkEntry | null = null;
        const began = Date.now();
        try {
          const meta = (this as unknown as Record<string, { method: string; url: string } | undefined>)[MARK];
          if (meta) entry = netStart('xhr', meta.method, clamp(meta.url));
          this.addEventListener('loadend', () => {
            if (!entry) return;
            entry.durationMs = Date.now() - began;
            if (this.status === 0) entry.error = 'network error or aborted';
            else {
              entry.status = this.status;
              entry.ok = this.status >= 200 && this.status < 400;
            }
          });
        } catch {
          /* ignore */
        }
        return (send as (...a: unknown[]) => void).call(this, body);
      } as typeof XHR.prototype.send;
    }

    // -- 3. dialogs ---------------------------------------------------------
    const noteDialog = (kind: DialogKind, message: string, answered: string): void => {
      push<DialogEntry>(
        state.dialogs,
        { seq: ++state.seq, ts: Date.now(), kind, message: clamp(message), answered },
        MAX_DIALOG_ENTRIES,
      );
    };

    w.alert = function patchedAlert(message?: unknown): void {
      noteDialog('alert', message === undefined ? '' : String(message), 'dismissed');
    };
    w.confirm = function patchedConfirm(message?: unknown): boolean {
      const answer = state.dialogPolicy === 'accept';
      noteDialog('confirm', message === undefined ? '' : String(message), String(answer));
      return answer;
    };
    w.prompt = function patchedPrompt(message?: unknown, fallback?: unknown): string | null {
      const answer = state.dialogPolicy === 'accept' ? state.promptText || String(fallback ?? '') : null;
      noteDialog('prompt', message === undefined ? '' : String(message), answer === null ? 'null' : answer);
      return answer;
    };

    // A capture-phase listener runs before the page's own, and
    // stopImmediatePropagation keeps those from ever setting returnValue — which
    // is what raises the "Leave site?" bar that strands an automated navigation.
    window.addEventListener(
      'beforeunload',
      (e: BeforeUnloadEvent) => {
        try {
          if (state.dialogPolicy !== 'dismiss') return;
          noteDialog('beforeunload', 'page asked to confirm leaving', 'suppressed');
          e.stopImmediatePropagation();
          delete (e as unknown as Record<string, unknown>).returnValue;
        } catch {
          /* ignore */
        }
      },
      true,
    );
  } catch {
    /* an observer must never take the page down with it */
  }
})();
