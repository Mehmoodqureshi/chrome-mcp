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

import { type CommandFrame, type ExecutorErrorCode, type WireMethod, type WirePolicy } from '../../../shared/protocol';
import { evaluatePolicy } from '../../../shared/policy';
import { sanitizeDownloadName } from '../../../shared/download';
import { collectSnapshot } from '../../../shared/snapshot';
import { pageOp, type PageOpArgs } from '../../../shared/page-fns';
import { OBSERVER_GLOBAL, readObservers } from '../../../shared/observers';
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_SCREENSHOT_FORMAT,
  planScreenshot,
  type ElementRect,
  type PageDims,
  type ScreenshotFormat,
} from '../../../shared/screenshot';
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

/** Methods that act on no particular tab (or create one), so there is nothing
 *  to resolve up front. */
const TABLESS: ReadonlySet<WireMethod> = new Set<WireMethod>(['tabs_list', 'tab_new', 'ping_probe', 'download_file']);

/**
 * Resolve the Chrome tab a command operates on ONCE, up front. The router
 * gates on it, the executor acts on it, and the result frame reports its URL
 * — three consumers, one `chrome.tabs.query`. `null` for tabless methods.
 * Throws TARGET_GONE for a stale/malformed handle so the caller gets that, not
 * a baffling policy denial against an empty URL.
 */
export async function resolveTab(cmd: CommandFrame): Promise<number | null> {
  if (TABLESS.has(cmd.method)) return null;
  return targetTab(cmd);
}

/**
 * The URL the policy gate should evaluate for `cmd`: the DESTINATION for
 * `navigate`, otherwise the target/active tab's current URL. Returns '' if it
 * can't be resolved — the gate treats that as not-allowlisted (fail-closed).
 */
export async function urlForCommand(cmd: CommandFrame, tab: number | null): Promise<string> {
  if (cmd.method === 'navigate') {
    const u = cmd.params.url;
    return typeof u === 'string' ? u : '';
  }
  return observedTabUrl(cmd, tab);
}

/**
 * Where the target tab actually IS, read straight from `chrome.tabs` — no round
 * trip, we are inside the browser. Unlike `urlForCommand` this never substitutes
 * a navigate DESTINATION, so it reports the post-redirect landing URL; the server
 * caches it to gate the NEXT call without asking for the tab list again.
 * '' when the tab is gone (tab_close) or Chrome won't reveal its URL.
 * `tab` is the id `resolveTab` produced; null means "resolve now" (tab_new's
 * result is the tab it just created/activated).
 */
export async function observedTabUrl(cmd: CommandFrame, tab: number | null): Promise<string> {
  try {
    const tabId = tab ?? (await targetTab(cmd));
    const t = await chrome.tabs.get(tabId);
    return t.url ?? '';
  } catch {
    return '';
  }
}

/**
 * Which frames an injection targets. `undefined` = the top frame only, which is
 * the default and the historical behaviour. A list restricts to exactly those
 * frame ids; every id in it has already been policy-checked against that
 * frame's own URL by `ChromeExecutor.frames()`.
 */
type FrameIds = number[] | undefined;

function scriptTarget(tabId: number, frameIds: FrameIds): chrome.scripting.InjectionTarget {
  return frameIds && frameIds.length > 0 ? { tabId, frameIds } : { tabId };
}

async function execInTab<T>(
  tabId: number,
  func: (...args: unknown[]) => T,
  args: unknown[] = [],
  world?: 'MAIN' | 'ISOLATED',
  frameIds?: FrameIds,
): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frameIds),
    func: func as (...a: unknown[]) => unknown,
    args,
    world,
  });
  return res?.result as T;
}

/** What one frame returned from a `pageOp` injection. */
interface OpOutcome {
  found: boolean;
  frameId: number;
  [key: string]: unknown;
}

/**
 * Run one `pageOp` in the target frame(s) and pick the frame that actually has
 * the element.
 *
 * With several frames in play "did it work" is per-frame, so the winner is the
 * first frame reporting `found` — an element lives in exactly one of them, and
 * scanning is the whole point of `allFrames`. When nothing matches anywhere we
 * still return a frame's outcome (so the caller reports SELECTOR_NOT_FOUND, not
 * an empty-result crash).
 */
async function execOp(
  tabId: number,
  args: PageOpArgs,
  frameIds?: FrameIds,
  world?: 'MAIN' | 'ISOLATED',
): Promise<OpOutcome> {
  const results = await chrome.scripting.executeScript({
    target: scriptTarget(tabId, frameIds),
    func: pageOp as unknown as (...a: unknown[]) => unknown,
    args: [args as unknown as Record<string, unknown>],
    world,
  });
  const outcomes: OpOutcome[] = results.map((r) => ({
    ...((r.result as Record<string, unknown> | undefined) ?? { found: false }),
    frameId: r.frameId ?? 0,
  })) as OpOutcome[];
  if (outcomes.length === 0) throw new CmdError('TARGET_GONE', 'the page returned no result for this command');
  return outcomes.find((o) => o.found === true) ?? outcomes[0];
}

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

function waitUntilOf(cmd: CommandFrame): WaitUntil {
  const w = cmd.params.waitUntil;
  return w === 'domcontentloaded' || w === 'networkidle' ? w : 'load';
}

/**
 * Arm the listeners for a navigation of `tabId`'s top frame BEFORE the caller
 * triggers it, and return a promise that settles when the navigation reaches
 * the requested stage. Event-driven (chrome.webNavigation + chrome.tabs.onUpdated)
 * rather than polling `chrome.tabs.get` every 100ms, so a page that finishes
 * in 40ms costs 40ms, and `domcontentloaded` really does return before the
 * load event (ads, analytics, late images) fires.
 *
 * Terminal signals, in the order they tend to arrive:
 *   - onDOMContentLoaded (frame 0)              -> done for 'domcontentloaded'
 *   - onCompleted (frame 0)                     -> done for 'load'; +quiet for 'networkidle'
 *   - onHistoryStateUpdated / onReferenceFragmentUpdated -> same-document nav: done
 *   - onErrorOccurred (frame 0)                 -> navigation failed/aborted: done
 *   - tabs.onUpdated status 'complete'          -> belt-and-braces (chrome:// error pages)
 * Events stamped before `start` belong to the PREVIOUS page and are ignored.
 * On timeout it resolves anyway (the caller reports whatever the tab shows).
 */
interface NavigationWait {
  /** Resolve once the navigation reaches the requested stage (or the timeout). */
  wait(): Promise<void>;
  /** Drop the listeners without waiting — for a trigger that did not navigate. */
  cancel(): void;
}

function armNavigationWait(tabId: number, waitUntil: WaitUntil, timeoutMs = 30_000): NavigationWait {
  const start = Date.now();
  const NETWORK_QUIET_MS = 500;
  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const isTop = (d: { tabId: number; frameId: number; timeStamp: number }): boolean =>
    d.tabId === tabId && d.frameId === 0 && d.timeStamp >= start - 1;

  const onDom = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
    if (isTop(d) && waitUntil === 'domcontentloaded') done();
  };
  const onCompleted = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails): void => {
    if (!isTop(d)) return;
    if (waitUntil === 'networkidle') setTimeout(done, NETWORK_QUIET_MS);
    else done();
  };
  const onSameDoc = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void => {
    if (isTop(d)) done();
  };
  const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails): void => {
    if (isTop(d)) done();
  };
  const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
    if (id === tabId && info.status === 'complete') done();
  };

  chrome.webNavigation.onDOMContentLoaded.addListener(onDom);
  chrome.webNavigation.onCompleted.addListener(onCompleted);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDoc);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDoc);
  chrome.webNavigation.onErrorOccurred.addListener(onError);
  chrome.tabs.onUpdated.addListener(onUpdated);

  const cleanup = (): void => {
    chrome.webNavigation.onDOMContentLoaded.removeListener(onDom);
    chrome.webNavigation.onCompleted.removeListener(onCompleted);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDoc);
    chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDoc);
    chrome.webNavigation.onErrorOccurred.removeListener(onError);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };

  return {
    async wait(): Promise<void> {
      const timer = setTimeout(done, timeoutMs);
      try {
        await finished;
      } finally {
        clearTimeout(timer);
        cleanup();
      }
    },
    cancel: cleanup,
  };
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

/** How long an element op waits in-page for a not-yet-rendered target. */
const ACTION_WAIT_MS = 5_000;

/** Wait-and-act in ONE injection: `pageOp` polls for the selector itself when
 *  `timeoutMs` is set, then runs the op the moment the element appears. */
const withWait = (a: PageOpArgs): PageOpArgs => ({ ...a, timeoutMs: ACTION_WAIT_MS, interval: 120 });

/** Poll the page for a selector (used where the follow-up is not a page op,
 *  e.g. a CDP DOM.setFileInputFiles). Runs INSIDE the page: one executeScript
 *  that resolves when the element appears or the deadline passes. */
async function waitForSelector(tabId: number, selector: string, frameIds: FrameIds, timeoutMs = ACTION_WAIT_MS): Promise<boolean> {
  const out = await execOp(tabId, { op: 'waitSelector', selector, timeoutMs, interval: 120 }, frameIds);
  return out.found === true;
}

/**
 * How long an attached debugger session lingers after its last op. Attach +
 * detach cost a few hundred ms and flash the "is being debugged" bar, and a
 * screenshot → click → screenshot loop would pay that three times. Within the
 * grace window the next op reuses the session; after it the bar clears.
 */
const DEBUGGER_GRACE_MS = 1_500;

/** Live debugger sessions keyed by tab, each with its pending detach timer. */
const dbgSessions = new Map<number, { detachTimer: ReturnType<typeof setTimeout> | null }>();

function forgetDebugger(tabId: number): void {
  const s = dbgSessions.get(tabId);
  if (s?.detachTimer) clearTimeout(s.detachTimer);
  dbgSessions.delete(tabId);
}

// Chrome (or the user closing DevTools / the tab) can end a session under us.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) forgetDebugger(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => forgetDebugger(tabId));

function scheduleDetach(tabId: number): void {
  const s = dbgSessions.get(tabId);
  if (!s) return;
  if (s.detachTimer) clearTimeout(s.detachTimer);
  s.detachTimer = setTimeout(() => {
    dbgSessions.delete(tabId);
    chrome.debugger.detach({ tabId }).catch(() => undefined);
  }, DEBUGGER_GRACE_MS);
}

async function ensureAttached(tabId: number): Promise<void> {
  const s = dbgSessions.get(tabId);
  if (s) {
    if (s.detachTimer) clearTimeout(s.detachTimer);
    s.detachTimer = null;
    return;
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  dbgSessions.set(tabId, { detachTimer: null });
}

const DETACHED_RE = /not attached|no target with given id|detached/i;

/** Run one op against an attached debugger, reusing a session that is still
 *  inside its grace window. Serialized per tab: a second attach on the same tab
 *  throws, and one op's detach would yank the debugger from a concurrent op.
 *  Different tabs still run in parallel. A session that Chrome dropped between
 *  ops is re-attached once, transparently. */
async function withDebugger<T>(tabId: number, fn: (target: chrome.debugger.Debuggee) => Promise<T>): Promise<T> {
  return locks.run(`dbg:${tabId}`, async () => {
    const target: chrome.debugger.Debuggee = { tabId };
    await ensureAttached(tabId);
    try {
      return await fn(target);
    } catch (err) {
      if (!DETACHED_RE.test(String((err as Error)?.message ?? err))) throw err;
      forgetDebugger(tabId);
      await ensureAttached(tabId);
      return await fn(target);
    } finally {
      scheduleDetach(tabId);
    }
  });
}

/** Real keystrokes via CDP Input.insertText — works on React/Vue controlled inputs. */
async function trustedType(
  tabId: number,
  selector: string,
  text: string,
  clear: boolean,
  frameIds: FrameIds,
  pressEnter = false,
): Promise<boolean> {
  // Focus only - never clear through the DOM here. A controlled editor (Draft,
  // Lexical, Quill) re-renders after a DOM-level delete and throws away the
  // selection, so the Input.insertText below would land nowhere and leave the
  // box empty. Clearing is done with Chrome's own selectAll editing command
  // instead, which is what Cmd+A does and which insertText then replaces.
  const focused = await execOp(tabId, withWait({ op: 'focus', selector, clear: false }), frameIds);
  if (!focused.found) return false;
  // One attach serves the select-all, the text, and the Enter that follows it.
  await withDebugger(tabId, async (t) => {
    if (clear) {
      for (const type of ['keyDown', 'keyUp'] as const) {
        await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', {
          type,
          key: 'a',
          code: 'KeyA',
          windowsVirtualKeyCode: 65,
          modifiers: 8, // Meta
          ...(type === 'keyDown' ? { commands: ['selectAll'] } : {}),
        });
      }
    }
    await chrome.debugger.sendCommand(t, 'Input.insertText', { text });
    if (!pressEnter) return;
    for (const type of ['keyDown', 'keyUp'] as const) {
      await chrome.debugger.sendCommand(t, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
  });
  return true;
}

/** A real mouse click via CDP Input.dispatchMouseEvent at the element's center. */
async function trustedClick(tabId: number, selector: string, frameIds: FrameIds): Promise<'ok' | 'missing' | 'inexact'> {
  const pt = await execOp(tabId, withWait({ op: 'point', selector }), frameIds);
  if (!pt.found) return 'missing';
  // A CDP mouse event is dispatched in TOP-viewport coordinates. An element in a
  // cross-origin iframe cannot report where that frame sits, so clicking the
  // coordinates we have would land somewhere else on the page entirely — worse
  // than not using trusted input. Say so and let the caller fall back.
  if (pt.exact === false) return 'inexact';
  await withDebugger(tabId, async (t) => {
    const base = { x: pt.x as number, y: pt.y as number, button: 'left' as const, clickCount: 1 };
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...base });
    await chrome.debugger.sendCommand(t, 'Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...base });
  });
  return 'ok';
}

/** Measure viewport + content dims, and (if a selector is given) the element's
 *  box in DOCUMENT coordinates. Returns null element when the selector is given
 *  but no element matches, so the caller can raise SELECTOR_NOT_FOUND. */
async function measurePage(
  tabId: number,
  selector?: string,
  frameIds?: FrameIds,
): Promise<{ dims: PageDims; element: ElementRect | null; missing: boolean } | undefined> {
  // With a selector we want the frame that HAS the element; the page dimensions
  // for the clip must still come from the top frame, which is what the
  // screenshot actually captures.
  const found = await execOp(tabId, { op: 'measure', selector: selector ?? null }, frameIds);
  const top =
    selector && frameIds && frameIds.length > 0
      ? await execOp(tabId, { op: 'measure', selector: null })
      : found;
  return {
    dims: top.dims as PageDims,
    element: (found.element ?? null) as ElementRect | null,
    missing: found.missing === true,
  };
}

interface ShotEncoding {
  format: ScreenshotFormat;
  quality: number;
  scale?: number;
}

function encodingOf(cmd: CommandFrame): ShotEncoding {
  const f = cmd.params.format;
  const q = cmd.params.quality;
  const sc = cmd.params.scale;
  return {
    format: f === 'png' || f === 'jpeg' ? f : DEFAULT_SCREENSHOT_FORMAT,
    quality: typeof q === 'number' && q >= 1 && q <= 100 ? Math.round(q) : DEFAULT_JPEG_QUALITY,
    scale: typeof sc === 'number' && sc > 0 ? sc : undefined,
  };
}

/** Capture via CDP (no tab activation). Reports CSS-px logical dimensions. */
async function screenshotViaDebugger(
  tabId: number,
  fullPage: boolean,
  enc: ShotEncoding,
  selector?: string,
  frameIds?: FrameIds,
): Promise<Record<string, unknown>> {
  const measured = await measurePage(tabId, selector, frameIds);
  if (!measured) throw new CmdError('CDP_ERROR', 'could not read page dimensions');
  if (selector && measured.missing) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${selector}`);

  const plan = planScreenshot(measured.dims, { fullPage, element: measured.element, scale: enc.scale });
  const params: Record<string, unknown> = {
    format: enc.format,
    captureBeyondViewport: plan.captureBeyondViewport,
    // Skip the slow PNG compression pass; bytes-on-the-wire matter less than latency here.
    optimizeForSpeed: true,
  };
  if (enc.format === 'jpeg') params.quality = enc.quality;
  if (plan.clip) params.clip = plan.clip;

  const data = await withDebugger(tabId, async (target) => {
    const res = (await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', params)) as { data?: string };
    return res.data ?? '';
  });

  return {
    dataBase64: data,
    mimeType: enc.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    width: plan.width,
    height: plan.height,
    truncated: plan.truncated,
    fullHeight: plan.fullHeight,
  };
}

/** Fallback: captureVisibleTab grabs the ACTIVE visible tab, so activate the
 *  target first. Used only when the debugger can't attach (reintroduces the
 *  focus change, but only on the rare fallback path). */
async function screenshotViaVisibleTab(tabId: number, fullPage: boolean, enc: ShotEncoding): Promise<Record<string, unknown>> {
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
  const dataUrl = await chrome.tabs.captureVisibleTab(
    t.windowId,
    enc.format === 'jpeg' ? { format: 'jpeg', quality: enc.quality } : { format: 'png' },
  );
  const viewportH = dims?.h ?? 0;
  const fullH = dims?.full ?? viewportH;
  return {
    dataBase64: dataUrl.split(',')[1] ?? '',
    mimeType: enc.format === 'jpeg' ? 'image/jpeg' : 'image/png',
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
  'frames_list', 'observers', 'print_pdf',
]);

export class ChromeExecutor {
  /**
   * The live wire policy, so frame-scoped commands can be gated against the
   * FRAME's origin rather than the tab's. The router gates the tab; only this
   * side knows which frames an injection would actually reach, and an
   * allowlisted page embedding a third-party iframe is the ordinary case, not an
   * exotic one.
   */
  constructor(private readonly getPolicy: () => WirePolicy | null = () => null) {}

  /**
   * Resolve `frameId` / `allFrames` params into the frame ids an injection may
   * touch, dropping any whose own URL the policy does not allow for this method.
   * `undefined` means the top frame only (the default, and every call that
   * predates frame support).
   *
   * The URL probe is a separate round-trip on purpose: filtering AFTER running
   * the command would mean a mutation had already fired inside a frame nobody
   * authorized.
   */
  private async frames(cmd: CommandFrame, tabId: number): Promise<FrameIds> {
    const explicit = typeof cmd.params.frameId === 'number' ? (cmd.params.frameId as number) : undefined;
    const all = cmd.params.allFrames === true;
    if (explicit === undefined && !all) return undefined;

    const probes = await chrome.scripting
      .executeScript({
        target: explicit !== undefined ? { tabId, frameIds: [explicit] } : { tabId, allFrames: true },
        func: pageOp as unknown as (...a: unknown[]) => unknown,
        args: [{ op: 'probe' } as unknown as Record<string, unknown>],
      })
      .catch(() => []);

    const seen = probes.map((r) => ({
      frameId: r.frameId ?? 0,
      url: String((r.result as { url?: string } | undefined)?.url ?? ''),
    }));
    if (seen.length === 0) {
      throw new CmdError(
        'FRAME_NOT_FOUND',
        explicit !== undefined
          ? `frame ${explicit} is not in this tab (or the extension cannot inject into it) — call frames_list`
          : 'no injectable frames in this tab',
      );
    }

    const policy = this.getPolicy();
    if (!policy) throw new CmdError('POLICY_DENIED', 'no policy has arrived yet, so no frame is authorized');

    const allowed: number[] = [];
    const denied: string[] = [];
    for (const f of seen) {
      if (evaluatePolicy(f.url, cmd.method, policy).ok) allowed.push(f.frameId);
      else denied.push(f.url || `frame ${f.frameId}`);
    }
    if (allowed.length === 0) {
      throw new CmdError(
        'POLICY_DENIED',
        `no targeted frame is on the allowed-sites list (skipped: ${denied.slice(0, 5).join(', ')})`,
      );
    }
    return allowed;
  }

  /**
   * Execute one command. `tab` is the id `resolveTab` already produced for it
   * (the router resolves once and shares it); omitted → resolve here.
   */
  async run(cmd: CommandFrame, tab: number | null = null): Promise<unknown> {
    const targetTab = async (c: CommandFrame): Promise<number> => tab ?? (c.tabId ? parseTabId(c.tabId) : currentTabId());
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
          const nav = armNavigationWait(claim.id, 'load');
          await chrome.tabs.update(claim.id, { url }).catch((err: unknown) => {
            nav.cancel();
            throw err;
          });
          await nav.wait();
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
        // Arm BEFORE triggering so a fast page cannot finish before we listen.
        const nav = armNavigationWait(id, waitUntilOf(cmd));
        await chrome.tabs.update(id, { url }).catch((err: unknown) => {
          nav.cancel();
          throw err;
        });
        await nav.wait();
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? url, title: t.title ?? '' };
      }
      case 'back': {
        const id = await targetTab(cmd);
        const nav = armNavigationWait(id, 'load', 15_000);
        // goBack rejects when there is no history entry; then there is nothing to wait for.
        const moved = await chrome.tabs.goBack(id).then(() => true, () => false);
        if (moved) await nav.wait();
        else nav.cancel();
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? '', title: t.title ?? '' };
      }
      case 'forward': {
        const id = await targetTab(cmd);
        const nav = armNavigationWait(id, 'load', 15_000);
        const moved = await chrome.tabs.goForward(id).then(() => true, () => false);
        if (moved) await nav.wait();
        else nav.cancel();
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? '', title: t.title ?? '' };
      }
      case 'reload': {
        const id = await targetTab(cmd);
        const nav = armNavigationWait(id, waitUntilOf(cmd));
        await chrome.tabs.reload(id).catch((err: unknown) => {
          nav.cancel();
          throw err;
        });
        await nav.wait();
        const t = await chrome.tabs.get(id);
        return { url: t.url ?? '', title: t.title ?? '' };
      }

      // -- reads (isolated world; CSP-safe) --
      case 'get_text': {
        const id = await targetTab(cmd);
        const frameIds = await this.frames(cmd, id);
        const out = await execOp(id, { op: 'text', selector: selectorOf(cmd) ?? null }, frameIds);
        if (!out.found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${selectorOf(cmd)}`);
        return { text: String(out.text ?? ''), frameId: out.frameId };
      }
      case 'get_html': {
        const id = await targetTab(cmd);
        const frameIds = await this.frames(cmd, id);
        const out = await execOp(
          id,
          { op: 'html', selector: selectorOf(cmd) ?? null, outer: cmd.params.outer === true },
          frameIds,
        );
        if (!out.found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${selectorOf(cmd)}`);
        return { html: String(out.html ?? ''), frameId: out.frameId };
      }

      // -- accessibility snapshot (tags elements with data-mcp-ref so refs work) --
      case 'snapshot': {
        const id = await targetTab(cmd);
        const interactiveOnly = cmd.params.interactiveOnly !== false;
        const max = typeof cmd.params.max === 'number' ? cmd.params.max : 200;
        const loc = cmd.params.locator;
        const locator =
          loc && typeof loc === 'object'
            ? {
                role: typeof (loc as { role?: unknown }).role === 'string' ? (loc as { role: string }).role : undefined,
                name: typeof (loc as { name?: unknown }).name === 'string' ? (loc as { name: string }).name : undefined,
              }
            : null;
        const frameIds = await this.frames(cmd, id);
        const raw = await execInTab(
          id,
          collectSnapshot as unknown as (...a: unknown[]) => unknown,
          [interactiveOnly, max, locator],
          undefined,
          frameIds,
        );
        return raw ?? { url: '', title: '', nodes: [], truncated: false };
      }

      // -- <select> option(s) by value or visible label --
      case 'select_option': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        const frameIds = await this.frames(cmd, id);
        const values = Array.isArray(cmd.params.values) ? cmd.params.values.map(String) : [];
        const out = await execOp(id, withWait({ op: 'select', selector: sel, values }), frameIds);
        if (!out.found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        if (out.matched !== true) throw new CmdError('SELECTOR_NOT_FOUND', `no <select> option matched for ${sel}`);
        return { ok: true, frameId: out.frameId };
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
        const frameIds = await this.frames(cmd, id);
        const out = await execOp(id, { op: 'storage', storageOp: op, key, value, session }, frameIds);
        const { found: _found, frameId: _frameId, ...rest } = out;
        return Object.keys(rest).length > 0 ? rest : { ok: false };
      }

      // -- interaction (synthetic events in the isolated world) --
      case 'click': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        const frameIds = await this.frames(cmd, id);
        if (cmd.params.trusted === true) {
          const verdict = await trustedClick(id, sel, frameIds);
          if (verdict === 'missing') throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
          // 'inexact': the element is in a cross-origin frame whose position we
          // cannot map. Fall through to the synthetic click rather than
          // dispatching a real mouse event at the wrong pixel.
          if (verdict === 'ok') return { ok: true };
        }
        const out = await execOp(id, withWait({ op: 'click', selector: sel }), frameIds);
        if (!out.found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        return { ok: true, frameId: out.frameId, ...(cmd.params.trusted === true ? { trusted: false } : {}) };
      }
      case 'type': {
        const id = await targetTab(cmd);
        const sel = requireSelector(cmd);
        const frameIds = await this.frames(cmd, id);
        const text = String(cmd.params.text ?? '');
        const clear = cmd.params.clear === true;
        if (cmd.params.trusted === true) {
          // Trusted keystrokes: works on React/Vue controlled inputs that ignore direct value-sets.
          if (!(await trustedType(id, sel, text, clear, frameIds, cmd.params.pressEnter === true))) {
            throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
          }
          return { ok: true };
        }
        const out = await execOp(id, withWait({ op: 'type', selector: sel, text, clear }), frameIds);
        if (!out.found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        return { ok: true, frameId: out.frameId };
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
        const frameIds = await this.frames(cmd, id);
        const out = await execOp(id, withWait({ op: 'hover', selector: sel }), frameIds);
        if (!out.found) throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        return { ok: true, frameId: out.frameId };
      }
      case 'scroll': {
        const id = await targetTab(cmd);
        const frameIds = await this.frames(cmd, id);
        await execOp(
          id,
          {
            op: 'scroll',
            selector: selectorOf(cmd) ?? null,
            x: (cmd.params.x as number | null) ?? null,
            y: (cmd.params.y as number | null) ?? null,
            deltaX: (cmd.params.deltaX as number | null) ?? null,
            deltaY: (cmd.params.deltaY as number | null) ?? null,
          },
          frameIds,
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
        const enc = encodingOf(cmd);
        const frameIds = await this.frames(cmd, id);
        try {
          return await screenshotViaDebugger(id, fullPage, enc, selector, frameIds);
        } catch (err) {
          // A genuinely missing element is a real failure — don't mask it with a fallback.
          if (err instanceof CmdError && err.code === 'SELECTOR_NOT_FOUND') throw err;
          return await screenshotViaVisibleTab(id, fullPage, enc);
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
          await this.frames(cmd, id),
        );
        return result ?? { ok: false, error: 'no result' };
      }

      // -- wait_for (poll the isolated world) --
      // One injection that polls IN-PAGE until the condition holds or the deadline
      // passes, rather than one executeScript round-trip per tick.
      case 'wait_for': {
        const id = await targetTab(cmd);
        const frameIds = await this.frames(cmd, id);
        const timeout = typeof cmd.params.timeoutMs === 'number' ? cmd.params.timeoutMs : 30_000;
        const start = Date.now();
        const out = await execOp(
          id,
          {
            op: 'waitFor',
            selector: (cmd.params.selector as string | null) ?? null,
            textContains: (cmd.params.textContains as string | null) ?? null,
            gone: cmd.params.gone === true,
            timeoutMs: timeout,
            interval: 150,
          },
          frameIds,
        );
        return { matched: out.matched === true, waitedMs: Date.now() - start };
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
        if (!(await waitForSelector(id, sel, undefined))) {
          throw new CmdError('SELECTOR_NOT_FOUND', `no element for selector: ${sel}`);
        }
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

      // -- frames: the ids an injection can target, plus each frame's URL.
      //    Read via a probe injection rather than chrome.webNavigation so no
      //    extra host-level permission is needed to see them. --
      case 'frames_list': {
        const id = await targetTab(cmd);
        const probes = await chrome.scripting
          .executeScript({
            target: { tabId: id, allFrames: true },
            func: pageOp as unknown as (...a: unknown[]) => unknown,
            args: [{ op: 'probe' } as unknown as Record<string, unknown>],
          })
          .catch(() => []);
        const frames = probes.map((r) => {
          const res = (r.result ?? {}) as { url?: string; title?: string };
          return {
            frameId: r.frameId ?? 0,
            top: (r.frameId ?? 0) === 0,
            url: res.url ?? '',
            title: res.title ?? '',
          };
        });
        return { frames, count: frames.length };
      }

      // -- observers: read (and configure) the in-page console/network/dialog
      //    buffers. The hook is normally registered at document_start; a page
      //    that loaded before registration gets it injected here, and the caller
      //    is told capture only starts from that moment. --
      case 'observers': {
        const id = await targetTab(cmd);
        const frameIds = await this.frames(cmd, id);
        const opts = {
          console: cmd.params.console === true,
          network: cmd.params.network === true,
          dialogs: cmd.params.dialogs === true,
          sinceSeq: typeof cmd.params.sinceSeq === 'number' ? (cmd.params.sinceSeq as number) : 0,
          limit: typeof cmd.params.limit === 'number' ? (cmd.params.limit as number) : 200,
          clear: cmd.params.clear === true,
          setPolicy: typeof cmd.params.setPolicy === 'string' ? (cmd.params.setPolicy as string) : null,
          promptText: typeof cmd.params.promptText === 'string' ? (cmd.params.promptText as string) : null,
          includeResources: cmd.params.includeResources === true,
        };

        // The hook records per FRAME (it is registered in all of them), so a
        // read spans exactly the frames this command is authorized for — the
        // top one by default, like every other tool.
        const read = async (): Promise<Array<{ frameId: number; out: Record<string, unknown> }>> => {
          const results = await chrome.scripting.executeScript({
            target: scriptTarget(id, frameIds),
            func: readObservers as unknown as (...a: unknown[]) => unknown,
            args: [OBSERVER_GLOBAL, opts],
            world: 'MAIN',
          });
          return results.map((r) => ({
            frameId: r.frameId ?? 0,
            out: ((r.result as Record<string, unknown> | undefined) ?? { installed: false }),
          }));
        };

        let frames = await read();
        let justInstalled = false;
        if (!frames.some((f) => f.out.installed === true)) {
          // Late install: everything from here on is captured, nothing before it.
          await chrome.scripting
            .executeScript({ target: scriptTarget(id, frameIds), files: ['page-hook.js'], world: 'MAIN' })
            .catch(() => undefined);
          frames = await read();
          justInstalled = frames.some((f) => f.out.installed === true);
        }

        const live = frames.filter((f) => f.out.installed === true);
        if (live.length === 0) return { installed: false };

        // Merge across frames, tagging each entry with the frame it came from and
        // ordering by time so a cross-frame story reads in the order it happened.
        const merge = (key: string): unknown[] => {
          const all: Array<Record<string, unknown>> = [];
          for (const f of live) {
            for (const e of (f.out[key] as Array<Record<string, unknown>>) ?? []) {
              all.push(f.frameId === 0 ? e : { ...e, frameId: f.frameId });
            }
          }
          return all.sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
        };

        const top = live.find((f) => f.frameId === 0) ?? live[0];
        return {
          installed: true,
          hookVersion: top.out.hookVersion,
          dialogPolicy: top.out.dialogPolicy,
          dropped: live.some((f) => f.out.dropped === true),
          ...(opts.console ? { console: merge('console') } : {}),
          ...(opts.network ? { network: merge('network') } : {}),
          ...(opts.dialogs ? { dialogs: merge('dialogs') } : {}),
          ...(live.length > 1 ? { frames: live.length } : {}),
          ...(justInstalled
            ? {
                justInstalled: true,
                note:
                  'the observer hook was installed just now, so these buffers start empty - ' +
                  'reload the page to capture what happens during load',
              }
            : {}),
        };
      }

      // -- print_pdf: Page.printToPDF over the same one-op debugger attach the
      //    screenshot path uses. Returns base64; the server writes the file. --
      case 'print_pdf': {
        const id = await targetTab(cmd);
        const params: Record<string, unknown> = {
          printBackground: cmd.params.printBackground !== false,
          landscape: cmd.params.landscape === true,
          preferCSSPageSize: cmd.params.preferCSSPageSize === true,
        };
        if (typeof cmd.params.scale === 'number') params.scale = cmd.params.scale;
        if (typeof cmd.params.paperWidth === 'number') params.paperWidth = cmd.params.paperWidth;
        if (typeof cmd.params.paperHeight === 'number') params.paperHeight = cmd.params.paperHeight;
        if (typeof cmd.params.pageRanges === 'string') params.pageRanges = cmd.params.pageRanges;

        const data = await withDebugger(id, async (t) => {
          const res = (await chrome.debugger.sendCommand(t, 'Page.printToPDF', params)) as { data?: string };
          return res.data ?? '';
        });
        if (!data) throw new CmdError('CDP_ERROR', 'Chrome returned an empty PDF');
        const t = await chrome.tabs.get(id);
        return { dataBase64: data, mimeType: 'application/pdf', url: t.url ?? '', title: t.title ?? '' };
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
