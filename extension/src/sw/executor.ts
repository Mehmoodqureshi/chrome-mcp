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
import { planScreenshot, type ElementRect, type PageDims } from '../../../shared/screenshot';
import { KeyedMutex } from '../../../shared/mutex';

/** A command failure carrying a wire error code. */
export class CmdError extends Error {
  constructor(
    public readonly code: ExecutorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Max time we wait for a download to finish before reporting failure. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Resolve when download `id` reaches state `complete`; reject on `interrupted`
 * or timeout. We poll via `chrome.downloads.search` on every change (and once
 * immediately, in case a cached download finished before the listener attached).
 */
function waitForDownloadComplete(id: number): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => settle(() => reject(new CmdError('DOWNLOAD_FAILED', 'download timed out'))),
      DOWNLOAD_TIMEOUT_MS,
    );
    const check = async (): Promise<void> => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) return;
      if (item.state === 'complete') settle(() => resolve(item));
      else if (item.state === 'interrupted') {
        settle(() => reject(new CmdError('DOWNLOAD_FAILED', `download interrupted: ${item.error ?? 'unknown'}`)));
      }
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id === id) void check();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    void check();
  });
}

const SESSION = crypto.randomUUID();
const CONTENT_SCHEME = /^(https?|file):/i;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Serializes per-tab debugger sessions (key `dbg:<tabId>`) and the tab_new
 * blank-tab claim (key `tab_new`). Same key → one-at-a-time; different tabs run
 * in parallel.
 */
const locks = new KeyedMutex();

/** Tab ids already handed out by tab_new this SW session — excluded from blank
 *  reuse so two concurrent tab_new calls can never claim the same tab. */
const claimedTabs = new Set<number>();

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

/**
 * The URL the policy gate should evaluate for `cmd`: the DESTINATION for
 * `navigate`, otherwise the target/active tab's current URL. Returns '' if it
 * can't be resolved — the gate treats that as not-allowlisted (fail-closed).
 */
export async function urlForCommand(cmd: CommandFrame): Promise<string> {
  if (cmd.method === 'navigate') {
    const u = cmd.params.url;
    return typeof u === 'string' ? u : '';
  }
  try {
    const tabId = await targetTab(cmd);
    const t = await chrome.tabs.get(tabId);
    return t.url ?? '';
  } catch {
    return '';
  }
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

/** Poll the page for a selector so click/type/hover don't fail on not-yet-rendered
 *  elements. The poll runs INSIDE the page (one executeScript that resolves when the
 *  element appears or the deadline passes) instead of one round-trip per tick. */
async function waitForSelector(tabId: number, selector: string, timeoutMs = 5_000): Promise<boolean> {
  const found = await execInTab(
    tabId,
    ((s: string, timeout: number, interval: number) =>
      new Promise<boolean>((resolve) => {
        const deadline = Date.now() + timeout;
        const tick = (): void => {
          if (document.querySelector(s)) return resolve(true);
          if (Date.now() > deadline) return resolve(false);
          setTimeout(tick, interval);
        };
        tick();
      })) as unknown as (...a: unknown[]) => boolean,
    [selector, timeoutMs, 120],
  );
  return found === true;
}

/** Attach the debugger for one op, always detaching (clears the banner).
 *  Serialized per tab: a second attach on the same tab throws, and one op's
 *  detach in `finally` would yank the debugger from a concurrent op. Different
 *  tabs still run in parallel. */
async function withDebugger<T>(tabId: number, fn: (target: chrome.debugger.Debuggee) => Promise<T>): Promise<T> {
  return locks.run(`dbg:${tabId}`, async () => {
    const target: chrome.debugger.Debuggee = { tabId };
    await chrome.debugger.attach(target, '1.3');
    try {
      return await fn(target);
    } finally {
      await chrome.debugger.detach(target).catch(() => undefined);
    }
  });
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

/** Measure viewport + content dims, and (if a selector is given) the element's
 *  box in DOCUMENT coordinates. Returns null element when the selector is given
 *  but no element matches, so the caller can raise SELECTOR_NOT_FOUND. */
async function measurePage(
  tabId: number,
  selector?: string,
): Promise<{ dims: PageDims; element: ElementRect | null; missing: boolean } | undefined> {
  return execInTab(
    tabId,
    (sel) => {
      const d = document.documentElement;
      const dims = {
        w: window.innerWidth,
        h: window.innerHeight,
        fullW: Math.max(d.scrollWidth, d.clientWidth),
        fullH: Math.max(d.scrollHeight, d.clientHeight),
      };
      if (!sel) return { dims, element: null, missing: false };
      const el = document.querySelector(sel as string) as HTMLElement | null;
      if (!el) return { dims, element: null, missing: true };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      // viewport rect + scroll offset → document coordinates.
      return { dims, element: { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }, missing: false };
    },
    [selector ?? null],
  ) as Promise<{ dims: PageDims; element: ElementRect | null; missing: boolean } | undefined>;
}

/** Capture via CDP (no tab activation). Reports CSS-px logical dimensions. */
async function screenshotViaDebugger(
  tabId: number,
  fullPage: boolean,
  selector?: string,
): Promise<Record<string, unknown>> {
  const measured = await measurePage(tabId, selector);
  if (!measured) throw new CmdError('CDP_ERROR', 'could not read page dimensions');
  if (selector && measured.missing) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${selector}`);

  const plan = planScreenshot(measured.dims, { fullPage, element: measured.element });
  const params: Record<string, unknown> = { format: 'png', captureBeyondViewport: plan.captureBeyondViewport };
  if (plan.clip) params.clip = plan.clip;

  const data = await withDebugger(tabId, async (target) => {
    const res = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params)) as { data?: string };
    return res.data ?? '';
  });

  return {
    dataBase64: data,
    mimeType: 'image/png',
    width: plan.width,
    height: plan.height,
    truncated: plan.truncated,
    fullHeight: plan.fullHeight,
  };
}

/** Fallback: captureVisibleTab grabs the ACTIVE visible tab, so activate the
 *  target first. Used only when the debugger can't attach (reintroduces the
 *  focus change, but only on the rare fallback path). */
async function screenshotViaVisibleTab(tabId: number, fullPage: boolean): Promise<Record<string, unknown>> {
  let t = await chrome.tabs.get(tabId);
  if (!t.active) {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
    await delay(150); // let the activated tab paint
    t = await chrome.tabs.get(tabId);
  }
  const dims = (await execInTab(
    tabId,
    () => ({ w: window.innerWidth, h: window.innerHeight, full: document.documentElement.scrollHeight }),
    [],
  )) as { w: number; h: number; full: number } | undefined;
  const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
  const viewportH = dims?.h ?? 0;
  const fullH = dims?.full ?? viewportH;
  return {
    dataBase64: dataUrl.split(',')[1] ?? '',
    mimeType: 'image/png',
    width: dims?.w ?? 0,
    height: viewportH,
    truncated: fullPage && fullH > viewportH,
    fullHeight: fullPage ? fullH : undefined,
  };
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
        // Focus the new tab by default (so "open X" behaves like opening a link);
        // batch/parallel callers pass active:false to avoid fighting over focus.
        const active = cmd.params.active !== false;
        // Reuse an existing blank tab (about:blank / new-tab page) instead of
        // spawning a fresh one, so callers don't pile up tabs. `reused: true`
        // tells the caller to RESET (not close) the tab when finished.
        //
        // The claim (query → pick/create → mark) is serialized and tracked in
        // `claimedTabs`, so two concurrent tab_new calls can never collapse onto
        // the same tab. Navigation/activation happens AFTER releasing the lock.
        const BLANK = /^(about:blank|chrome:\/\/newtab|chrome:\/\/new-tab-page|edge:\/\/newtab)/i;
        const claim = await locks.run('tab_new', async () => {
          const tabs = await chrome.tabs.query({});
          // Prune ids that no longer exist so the set stays bounded.
          const present = new Set(tabs.map((t) => t.id).filter((id): id is number => id !== undefined));
          for (const id of claimedTabs) if (!present.has(id)) claimedTabs.delete(id);

          const blank = tabs.find(
            (t) =>
              t.id !== undefined &&
              !claimedTabs.has(t.id) &&
              (BLANK.test(t.url ?? '') || (t.url ?? '') === '' || t.pendingUrl === 'about:blank'),
          );
          if (blank?.id !== undefined) {
            claimedTabs.add(blank.id);
            return { id: blank.id, reused: true, needsNav: url !== undefined };
          }
          // Create in the background; we focus below (one activation path for both).
          const created = await chrome.tabs.create({ url, active: false });
          if (created.id === undefined) throw new CmdError('TARGET_GONE', 'failed to create a tab');
          claimedTabs.add(created.id);
          return { id: created.id, reused: false, needsNav: false };
        });

        if (claim.needsNav) {
          await chrome.tabs.update(claim.id, { url });
          await waitComplete(claim.id);
        }
        if (active) {
          const t = await chrome.tabs.get(claim.id);
          await chrome.tabs.update(claim.id, { active: true }).catch(() => undefined);
          await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
        }
        return { ...(await tabInfo(await chrome.tabs.get(claim.id))), reused: claim.reused };
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

      // -- screenshot --
      // Primary path: chrome.debugger Page.captureScreenshot, which captures a
      // SPECIFIC tab WITHOUT activating it (no focus-stealing → safe under
      // concurrent batches) and supports true full-page + element capture.
      // Falls back to captureVisibleTab only if the debugger can't attach.
      case 'screenshot': {
        const id = await targetTab(cmd);
        const fullPage = cmd.params.fullPage === true;
        const selector = selectorOf(cmd);
        try {
          return await screenshotViaDebugger(id, fullPage, selector);
        } catch (err) {
          // A genuinely missing element is a real failure — don't mask it with a fallback.
          if (err instanceof CmdError && err.code === 'SELECTOR_NOT_FOUND') throw err;
          return await screenshotViaVisibleTab(id, fullPage);
        }
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
      // One injection that polls IN-PAGE until the condition holds or the deadline
      // passes, rather than one executeScript round-trip per tick.
      case 'wait_for': {
        const id = await targetTab(cmd);
        const timeout = typeof cmd.params.timeoutMs === 'number' ? cmd.params.timeoutMs : 30_000;
        const start = Date.now();
        const matched = await execInTab(
          id,
          ((sel: string | null, text: string | null, gone: boolean, timeoutMs: number, interval: number) =>
            new Promise<boolean>((resolve) => {
              const deadline = Date.now() + timeoutMs;
              const hit = (): boolean => {
                let present: boolean;
                if (sel) present = !!document.querySelector(sel);
                else if (text) present = (document.body?.innerText ?? '').includes(text);
                else present = true;
                return gone ? !present : present;
              };
              const tick = (): void => {
                if (hit()) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(tick, interval);
              };
              tick();
            })) as unknown as (...a: unknown[]) => boolean,
          [cmd.params.selector ?? null, cmd.params.textContains ?? null, cmd.params.gone === true, timeout, 150],
        );
        return { matched: matched === true, waitedMs: Date.now() - start };
      }

      // -- download (saved to the user's Downloads dir; the server then moves it
      //    into the active task's downloads/). We wait for completion and report
      //    the absolute on-disk path so the server can relocate it. --
      case 'download_file': {
        const url = typeof cmd.params.url === 'string' ? cmd.params.url : undefined;
        if (!url) throw new CmdError('DOWNLOAD_FAILED', 'the extension download path requires a url');
        const name = sanitizeDownloadName(
          typeof cmd.params.suggestedName === 'string' ? cmd.params.suggestedName : undefined,
        );
        const downloadId = await chrome.downloads.download({ url, filename: name });
        const item = await waitForDownloadComplete(downloadId);
        const bytes = item.fileSize > 0 ? item.fileSize : item.bytesReceived;
        return {
          path: item.filename,
          sourcePath: item.filename,
          downloadId,
          backend: 'extension',
          bytes,
          suggestedName: name,
        };
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
