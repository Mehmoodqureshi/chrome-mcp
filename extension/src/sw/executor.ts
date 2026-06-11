/**
 * extension/src/sw/executor.ts — executes wire commands against the real Chrome
 * using chrome.tabs + chrome.scripting (NOT chrome.debugger).
 *
 * Why scripting and not debugger: no "is being debugged" banner, no conflict
 * with other CDP clients, and reads run in an ISOLATED world so page CSP can't
 * block them. Trade-off: clicks/typing are synthetic DOM events, not OS-level
 * trusted input. A trusted-input chrome.debugger backend is a documented future
 * upgrade (see docs/BLUEPRINT.md §10).
 *
 * Tab handles are minted `ext:<session>:<chromeTabId>` so a handle from a prior
 * service-worker session is rejected (STALE/TARGET_GONE) rather than mis-routed.
 */

import { type CommandFrame, type ExecutorErrorCode, type WireMethod } from '../../../shared/protocol';
import { sanitizeDownloadName } from '../../../shared/download';

/** A command failure carrying a wire error code. */
export class CmdError extends Error {
  constructor(
    public readonly code: ExecutorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const SESSION = crypto.randomUUID();
const CONTENT_SCHEME = /^(https?|file):/i;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mint(tabId: number): string {
  return `ext:${SESSION}:${tabId}`;
}

function parseTabId(wire: string): number {
  const parts = wire.split(':');
  if (parts.length !== 3 || parts[0] !== 'ext') throw new CmdError('TARGET_GONE', `malformed tab handle: ${wire}`);
  if (parts[1] !== SESSION) throw new CmdError('TARGET_GONE', 'tab handle is from a previous session; call tabs_list again');
  const id = Number(parts[2]);
  if (!Number.isInteger(id)) throw new CmdError('TARGET_GONE', `bad tab id: ${wire}`);
  return id;
}

async function currentTabId(): Promise<number> {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== undefined) return active.id;
  const [any] = await chrome.tabs.query({ active: true });
  if (any?.id !== undefined) return any.id;
  throw new CmdError('NO_TARGET', 'no active tab to operate on');
}

async function targetTab(cmd: CommandFrame): Promise<number> {
  return cmd.tabId ? parseTabId(cmd.tabId) : currentTabId();
}

async function execInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = [],
  world?: 'MAIN' | 'ISOLATED',
): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: func as (...a: unknown[]) => unknown,
    args,
    world,
  });
  return res?.result as T;
}

async function waitComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return;
    if (Date.now() - start > timeoutMs) return;
    await delay(100);
  }
}

function selectorOf(cmd: CommandFrame): string | undefined {
  const s = cmd.params.selector;
  return typeof s === 'string' ? s : undefined;
}

async function tabInfo(tab: chrome.tabs.Tab, index = 0): Promise<Record<string, unknown>> {
  return {
    tabId: mint(tab.id ?? -1),
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active ?? false,
    index: tab.index ?? index,
  };
}

export const HANDLED: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'tabs_list', 'tab_select', 'tab_new', 'tab_close',
  'navigate', 'back', 'forward', 'reload',
  'click', 'type', 'press', 'hover', 'scroll',
  'screenshot', 'get_text', 'get_html', 'eval', 'wait_for',
  'download_file', 'ping_probe',
]);

export class ChromeExecutor {
  async run(cmd: CommandFrame): Promise<unknown> {
    switch (cmd.method) {
      case 'ping_probe':
        return {};

      // -- tabs --
      case 'tabs_list': {
        const tabs = (await chrome.tabs.query({})).filter((t) => CONTENT_SCHEME.test(t.url ?? ''));
        return Promise.all(tabs.map((t, i) => tabInfo(t, i)));
      }
      case 'tab_select': {
        const id = parseTabId(String(cmd.tabId));
        const t = await chrome.tabs.update(id, { active: true });
        return tabInfo(t ?? (await chrome.tabs.get(id)));
      }
      case 'tab_new': {
        const url = typeof cmd.params.url === 'string' ? cmd.params.url : undefined;
        const t = await chrome.tabs.create({ url, active: false });
        return tabInfo(t);
      }
      case 'tab_close': {
        const id = parseTabId(String(cmd.tabId));
        await chrome.tabs.remove(id);
        return { closed: true, tabId: cmd.tabId };
      }

      // -- navigation --
      case 'navigate': {
        const id = await targetTab(cmd);
        const url = String(cmd.params.url);
        await chrome.tabs.update(id, { url });
        await waitComplete(id);
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? url, title: t.title ?? '' };
      }
      case 'back': {
        const id = await targetTab(cmd);
        await chrome.tabs.goBack(id).catch(() => undefined);
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? '', title: t.title ?? '' };
      }
      case 'forward': {
        const id = await targetTab(cmd);
        await chrome.tabs.goForward(id).catch(() => undefined);
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? '', title: t.title ?? '' };
      }
      case 'reload': {
        const id = await targetTab(cmd);
        await chrome.tabs.reload(id);
        await waitComplete(id);
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? '', title: t.title ?? '' };
      }

      // -- reads (isolated world; CSP-safe) --
      case 'get_text': {
        const id = await targetTab(cmd);
        const text = await execInTab(
          id,
          (sel) => {
            const el = sel ? document.querySelector(sel as string) : document.body;
            return el ? (el as HTMLElement).innerText : '';
          },
          [selectorOf(cmd) ?? null],
        );
        return { text: text ?? '' };
      }
      case 'get_html': {
        const id = await targetTab(cmd);
        const outer = cmd.params.outer === true;
        const html = await execInTab(
          id,
          (sel, isOuter) => {
            const el = sel ? document.querySelector(sel as string) : document.documentElement;
            if (!el) return '';
            return isOuter || !sel ? (el as Element).outerHTML : (el as HTMLElement).innerHTML;
          },
          [selectorOf(cmd) ?? null, outer],
        );
        return { html: html ?? '' };
      }

      // -- interaction (synthetic events in the isolated world) --
      case 'click': {
        const id = await targetTab(cmd);
        const found = await execInTab(
          id,
          (sel) => {
            const el = document.querySelector(sel as string) as HTMLElement | null;
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          },
          [requireSelector(cmd)],
        );
        if (!found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${requireSelector(cmd)}`);
        return { ok: true };
      }
      case 'type': {
        const id = await targetTab(cmd);
        const text = String(cmd.params.text ?? '');
        const clear = cmd.params.clear === true;
        const found = await execInTab(
          id,
          (sel, value, doClear) => {
            const el = document.querySelector(sel as string) as HTMLInputElement | HTMLTextAreaElement | null;
            if (!el) return false;
            el.focus();
            if (doClear) el.value = '';
            el.value = (el.value ?? '') + value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
          [requireSelector(cmd), text, clear],
        );
        if (!found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${requireSelector(cmd)}`);
        return { ok: true };
      }
      case 'press': {
        const id = await targetTab(cmd);
        const key = String(cmd.params.key ?? '');
        await execInTab(
          id,
          (k) => {
            const el = (document.activeElement as HTMLElement) ?? document.body;
            for (const type of ['keydown', 'keypress', 'keyup']) {
              el.dispatchEvent(new KeyboardEvent(type, { key: k as string, bubbles: true }));
            }
          },
          [key],
        );
        return { ok: true };
      }
      case 'hover': {
        const id = await targetTab(cmd);
        await execInTab(
          id,
          (sel) => {
            const el = document.querySelector(sel as string);
            el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          },
          [requireSelector(cmd)],
        );
        return { ok: true };
      }
      case 'scroll': {
        const id = await targetTab(cmd);
        await execInTab(
          id,
          (x, y, dx, dy) => {
            if (x != null || y != null) window.scrollTo((x as number) ?? 0, (y as number) ?? 0);
            else window.scrollBy((dx as number) ?? 0, (dy as number) ?? 0);
          },
          [cmd.params.x ?? null, cmd.params.y ?? null, cmd.params.deltaX ?? null, cmd.params.deltaY ?? null],
        );
        return { ok: true };
      }

      // -- screenshot (visible tab) --
      case 'screenshot': {
        const id = await targetTab(cmd);
        const t = await chrome.tabs.get(id);
        const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
        return {
          dataBase64: dataUrl.split(',')[1] ?? '',
          mimeType: 'image/png',
          width: 0,
          height: 0,
          truncated: false,
        };
      }

      // -- eval (MAIN world; may be blocked by strict page CSP) --
      case 'eval': {
        const id = await targetTab(cmd);
        const expr = String(cmd.params.expression ?? '');
        const result = await execInTab(
          id,
          (e) => {
            try {
              // eslint-disable-next-line no-eval
              const v = (0, eval)(e as string);
              return { ok: true, value: v, type: typeof v };
            } catch (err) {
              return { ok: false, error: String(err) };
            }
          },
          [expr],
          'MAIN',
        );
        return result ?? { ok: false, error: 'no result' };
      }

      // -- wait_for (poll the isolated world) --
      case 'wait_for': {
        const id = await targetTab(cmd);
        const timeout = typeof cmd.params.timeoutMs === 'number' ? cmd.params.timeoutMs : 30_000;
        const start = Date.now();
        for (;;) {
          const matched = await execInTab(
            id,
            (sel, text, gone) => {
              let present: boolean;
              if (sel) present = !!document.querySelector(sel as string);
              else if (text) present = (document.body?.innerText ?? '').includes(text as string);
              else present = true;
              return gone ? !present : present;
            },
            [cmd.params.selector ?? null, cmd.params.textContains ?? null, cmd.params.gone === true],
          );
          if (matched) return { matched: true, waitedMs: Date.now() - start };
          if (Date.now() - start > timeout) return { matched: false, waitedMs: Date.now() - start };
          await delay(150);
        }
      }

      // -- download (user's Downloads dir) --
      case 'download_file': {
        const url = typeof cmd.params.url === 'string' ? cmd.params.url : undefined;
        if (!url) throw new CmdError('DOWNLOAD_FAILED', 'the extension download path requires a url');
        const name = sanitizeDownloadName(
          typeof cmd.params.suggestedName === 'string' ? cmd.params.suggestedName : undefined,
        );
        const downloadId = await chrome.downloads.download({ url, filename: name });
        return { path: `(downloads)/${name}`, backend: 'extension', bytes: 0, suggestedName: name };
      }

      default:
        throw new CmdError('UNKNOWN_METHOD', `unhandled method: ${cmd.method}`);
    }
  }
}

function requireSelector(cmd: CommandFrame): string {
  const s = cmd.params.selector;
  if (typeof s !== 'string' || s.length === 0) {
    throw new CmdError('BAD_ARGS', 'this command needs a CSS selector (the scripting backend does not support refs)');
  }
  return s;
}
