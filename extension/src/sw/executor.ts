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
import { collectSnapshot } from '../../../shared/snapshot';

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

/** Resolve a CSS selector from `selector`, or a `ref` (minted by snapshot) to its data attribute. */
function resolveSelector(cmd: CommandFrame): string | undefined {
  const s = cmd.params.selector;
  if (typeof s === 'string' && s.length > 0) return s;
  const ref = cmd.params.ref;
  if (typeof ref === 'string' && ref.length > 0) return `[data-mcp-ref="${ref.replace(/["\\]/g, '\\$&')}"]`;
  return undefined;
}

function selectorOf(cmd: CommandFrame): string | undefined {
  return resolveSelector(cmd);
}

/** Poll the page for a selector so click/type/hover don't fail on not-yet-rendered elements. */
async function waitForSelector(tabId: number, selector: string, timeoutMs = 5_000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const present = await execInTab(tabId, (s) => !!document.querySelector(s as string), [selector]);
    if (present) return true;
    if (Date.now() - start > timeoutMs) return false;
    await delay(120);
  }
}

/** Attach the debugger for one trusted-input op, always detaching (clears the banner). */
async function withDebugger<T>(tabId: number, fn: (target: chrome.debugger.Debuggee) => Promise<T>): Promise<T> {
  const target: chrome.debugger.Debuggee = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    return await fn(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => undefined);
  }
}

/** Real keystrokes via CDP Input.insertText — works on React/Vue controlled inputs. */
async function trustedType(tabId: number, selector: string, text: string, clear: boolean): Promise<boolean> {
  const focused = await execInTab(
    tabId,
    (s, doClear) => {
      const el = document.querySelector(s as string) as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return false;
      el.focus();
      if (doClear) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        setter ? setter.call(el, '') : (el.value = '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    },
    [selector, clear],
  );
  if (!focused) return false;
  await withDebugger(tabId, (t) => chrome.debugger.sendCommand(t, 'Input.insertText', { text }));
  return true;
}

/** A real mouse click via CDP Input.dispatchMouseEvent at the element's center. */
async function trustedClick(tabId: number, selector: string): Promise<boolean> {
  const pt = await execInTab(
    tabId,
    (s) => {
      const el = document.querySelector(s as string) as HTMLElement | null;
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    [selector],
  );
  if (!pt) return false;
  await withDebugger(tabId, async (t) => {
    const base = { x: (pt as { x: number }).x, y: (pt as { y: number }).y, button: 'left' as const, clickCount: 1 };
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base });
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base });
  });
  return true;
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
  'screenshot', 'get_text', 'get_html', 'snapshot',
  'select_option', 'get_cookies', 'storage', 'eval', 'wait_for',
  'download_file', 'upload_file', 'ping_probe',
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
        // Reuse an existing blank tab (about:blank / new-tab page) instead of
        // spawning a fresh one, so callers don't pile up tabs. `reused: true`
        // tells the caller to RESET (not close) the tab when finished.
        const BLANK = /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i;
        const blank = (await chrome.tabs.query({})).find(
          (t) => t.id !== undefined && (BLANK.test(t.url ?? '') || (t.url ?? '') === '' || t.pendingUrl === 'about:blank'),
        );
        if (blank?.id !== undefined) {
          if (url) { await chrome.tabs.update(blank.id, { url }); await waitComplete(blank.id); }
          return { ...(await tabInfo(await chrome.tabs.get(blank.id))), reused: true };
        }
        const t = await chrome.tabs.create({ url, active: false });
        return { ...(await tabInfo(t)), reused: false };
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

      // -- accessibility snapshot (tags elements with data-mcp-ref so refs work) --
      case 'snapshot': {
        const id = await targetTab(cmd);
        const interactiveOnly = cmd.params.interactiveOnly !== false;
        const max = typeof cmd.params.max === 'number' ? cmd.params.max : 200;
        const raw = await execInTab(
          id,
          collectSnapshot as unknown as (...a: unknown[]) => unknown,
          [interactiveOnly, max],
        );
        return raw ?? { url: '', title: '', nodes: [], truncated: false };
      }

      // -- <select> option(s) by value or visible label --
      case 'select_option': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        const values = Array.isArray(cmd.params.values) ? cmd.params.values.map(String) : [];
        await waitForSelector(id, sel);
        const matched = await execInTab(
          id,
          (s, vals) => {
            const el = document.querySelector(s as string) as HTMLSelectElement | null;
            if (!el || !el.options) return false;
            const set = new Set(vals as string[]);
            let hit = false;
            for (const opt of Array.from(el.options)) {
              const on = set.has(opt.value) || set.has(opt.label) || set.has(opt.text);
              opt.selected = on;
              if (on) hit = true;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return hit;
          },
          [sel, values],
        );
        if (!matched) throw new CmdError('SELECTOR_NOT_FOUND', `no <select> option matched for ${sel}`);
        return { ok: true };
      }

      // -- cookies for the tab's URL (chrome.cookies; needs "cookies" permission) --
      case 'get_cookies': {
        const id = await targetTab(cmd);
        const t = await chrome.tabs.get(id);
        const url = typeof cmd.params.url === 'string' ? cmd.params.url : t.url;
        if (!url) throw new CmdError('BAD_ARGS', 'no url to read cookies for');
        const cookies = await chrome.cookies.getAll({ url });
        return {
          cookies: cookies.map((c) => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly, expires: c.expirationDate,
          })),
        };
      }

      // -- localStorage / sessionStorage (isolated world) --
      case 'storage': {
        const id = await targetTab(cmd);
        const op = String(cmd.params.op);
        const key = typeof cmd.params.key === 'string' ? cmd.params.key : null;
        const value = typeof cmd.params.value === 'string' ? cmd.params.value : null;
        const session = cmd.params.session === true;
        const res = await execInTab(
          id,
          (o, k, v, s) => {
            const store = s ? window.sessionStorage : window.localStorage;
            if (o === 'set') { store.setItem(String(k), String(v ?? '')); return { ok: true }; }
            if (o === 'remove') { store.removeItem(String(k)); return { ok: true }; }
            if (o === 'clear') { store.clear(); return { ok: true }; }
            if (k) return { ok: true, value: store.getItem(k as string) };
            const entries: Record<string, string> = {};
            for (let i = 0; i < store.length; i++) {
              const kk = store.key(i);
              if (kk) entries[kk] = store.getItem(kk) ?? '';
            }
            return { ok: true, entries };
          },
          [op, key, value, session],
        );
        return res ?? { ok: false };
      }

      // -- interaction (synthetic events in the isolated world) --
      case 'click': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        if (!(await waitForSelector(id, sel))) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        if (cmd.params.trusted === true) {
          if (!(await trustedClick(id, sel))) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
          return { ok: true };
        }
        const found = await execInTab(
          id,
          (s) => {
            const el = document.querySelector(s as string) as HTMLElement | null;
            if (!el) return false;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          },
          [sel],
        );
        if (!found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        return { ok: true };
      }
      case 'type': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        const text = String(cmd.params.text ?? '');
        const clear = cmd.params.clear === true;
        if (!(await waitForSelector(id, sel))) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        if (cmd.params.trusted === true) {
          // Trusted keystrokes: works on React/Vue controlled inputs that ignore direct value-sets.
          if (!(await trustedType(id, sel, text, clear))) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
          if (cmd.params.pressEnter === true) {
            await withDebugger(id, async (t) => {
              for (const type of ['keyDown', 'keyUp'] as const) {
                await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
              }
            });
          }
          return { ok: true };
        }
        const found = await execInTab(
          id,
          (s, value, doClear) => {
            const el = document.querySelector(s as string) as HTMLInputElement | HTMLTextAreaElement | null;
            if (!el) return false;
            el.focus();
            // Use the native value setter so React/Vue see the change (they patch the instance setter).
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
            const next = (doClear ? '' : (el.value ?? '')) + value;
            setter ? setter.call(el, next) : (el.value = next);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
          [sel, text, clear],
        );
        if (!found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
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
        const sel = requireSelector(cmd);
        await waitForSelector(id, sel);
        await execInTab(
          id,
          (s) => {
            const el = document.querySelector(s as string);
            el?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
            el?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          },
          [sel],
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

      // -- screenshot (captureVisibleTab grabs the ACTIVE visible tab, so activate the target first) --
      case 'screenshot': {
        const id = await targetTab(cmd);
        let t = await chrome.tabs.get(id);
        if (!t.active) {
          await chrome.tabs.update(id, { active: true });
          await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
          await delay(150); // let the activated tab paint
          t = await chrome.tabs.get(id);
        }
        const dims = await execInTab(
          id,
          () => ({ w: window.innerWidth, h: window.innerHeight, full: document.documentElement.scrollHeight }),
          [],
        ) as { w: number; h: number; full: number } | undefined;
        const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
        const fullPage = cmd.params.fullPage === true;
        const viewportH = dims?.h ?? 0;
        const fullH = dims?.full ?? viewportH;
        return {
          dataBase64: dataUrl.split(',')[1] ?? '',
          mimeType: 'image/png',
          width: dims?.w ?? 0,
          height: viewportH,
          // The scripting backend can only capture the viewport; flag when a fullPage was asked but clipped.
          truncated: fullPage && fullH > viewportH,
          fullHeight: fullPage ? fullH : undefined,
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

      // -- upload: set local file(s) on a file <input> via CDP DOM.setFileInputFiles --
      case 'upload_file': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        const files = Array.isArray(cmd.params.files) ? cmd.params.files.map(String) : [];
        if (files.length === 0) throw new CmdError('BAD_ARGS', 'upload_file requires a non-empty "files" array');
        if (!(await waitForSelector(id, sel))) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        await withDebugger(id, async (t) => {
          const doc = (await chrome.debugger.sendCommand(t, 'DOM.getDocument', { depth: 0 })) as { root?: { nodeId: number } };
          const rootId = doc.root?.nodeId;
          if (!rootId) throw new CmdError('CDP_ERROR', 'could not read the document root');
          const found = (await chrome.debugger.sendCommand(t, 'DOM.querySelector', { nodeId: rootId, selector: sel })) as { nodeId?: number };
          if (!found.nodeId) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
          await chrome.debugger.sendCommand(t, 'DOM.setFileInputFiles', { files, nodeId: found.nodeId });
        });
        return { ok: true };
      }

      default:
        throw new CmdError('UNKNOWN_METHOD', `unhandled method: ${cmd.method}`);
    }
  }
}

function requireSelector(cmd: CommandFrame): string {
  const sel = resolveSelector(cmd);
  if (!sel) {
    throw new CmdError('BAD_ARGS', 'this command needs a "selector" or a "ref" from snapshot()');
  }
  return sel;
}
