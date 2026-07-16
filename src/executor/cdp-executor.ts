/**
 * src/executor/cdp-executor.ts — the Playwright-driven fallback Executor.
 *
 * Used when no extension is paired. Two acquisition modes:
 *   - 'connect': attach over CDP to a Chrome we did NOT launch (never closed by
 *     us — its lifecycle is the user's).
 *   - 'launch':  spawn a dedicated persistent Chromium under a profile that is
 *     NOT the user's real one (would conflict with the extension-driven Chrome).
 *
 * Ported from linkedin-mcp/src/driver/browser.ts: the stale-profile-lock
 * recovery (a SIGKILLed MCP child orphans `SingletonLock`), connect-once reuse,
 * stealth init on the launch path only, and tab resolution. `tabId`s are stamped
 * `cdp:<sessionId>:<n>` so a handle never mis-routes across a backend switch.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from 'playwright';

import { MAX_DOWNLOAD_BYTES, isWithinSizeCap, sanitizeDownloadName } from '../../shared/download';
import { collectSnapshot } from '../../shared/snapshot';
import {
  type ActionOk,
  type BackendKind,
  type CookieItem,
  type DownloadResult,
  type EvalResult,
  type Executor,
  ExecutorError,
  type ExecutorStatus,
  type KeyModifier,
  type NavResult,
  type ScreenshotResult,
  type SnapshotResult,
  type StorageOp,
  type StorageResult,
  type TabId,
  type TabInfo,
  type Target,
  truncateEvalResult,
  type WaitResult,
  type WaitUntil,
} from './types';

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const STEALTH = `Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`;
const NON_CONTENT = /^(file|data|devtools|chrome|about):/i;
/** Playwright errors that mean the page/context/browser died under us → DETACHED. */
const CLOSED_TARGET = /Target closed|Browser has been closed|Target page, context or browser has been closed|Execution context was destroyed/i;

/** Minimal CSS attribute-value escape for ref selectors (refs are `e\d+`, but be safe). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

export interface CdpOptions {
  mode: 'connect' | 'launch';
  cdpEndpoint?: string;
  userDataDir: string;
  headless?: boolean;
  downloadDir?: string;
}

// --- lock recovery helpers (ported) ---------------------------------------

function inspectProfileLock(profileDir: string): { alive: boolean; pid: number | null } {
  try {
    const lockPath = join(profileDir, 'SingletonLock');
    if (!existsSync(lockPath)) return { alive: false, pid: null };
    const target = readlinkSync(lockPath);
    const pid = Number.parseInt(target.slice(target.lastIndexOf('-') + 1), 10);
    if (!Number.isInteger(pid) || pid <= 0) return { alive: false, pid: null };
    try {
      process.kill(pid, 0);
      return { alive: true, pid };
    } catch (e) {
      return { alive: (e as NodeJS.ErrnoException).code === 'EPERM', pid };
    }
  } catch {
    return { alive: false, pid: null };
  }
}

function clearProfileLocks(profileDir: string): void {
  for (const name of SINGLETON_FILES) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      /* best effort */
    }
  }
}

function isChromiumProcess(pid: number): boolean {
  // Windows has no `ps`; tasklist is the equivalent and is a real .exe, so it
  // needs no shell. Its CSV row leads with the image name (e.g. "chrome.exe"),
  // and the no-match case prints an INFO line that fails the same test.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']]
      : ['ps', ['-p', String(pid), '-o', 'command=']];
  try {
    const out = execFileSync(cmd, args as string[], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /chrom(e|ium)|Chrome for Testing/i.test(out);
  } catch {
    return false;
  }
}

export class CdpExecutor implements Executor {
  readonly backend: BackendKind = 'cdp';
  private readonly sessionId = randomUUID();
  private readonly profileDir: string;
  private cdpBrowser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  /** Whether WE own (launched) the browser — only then may we close it. */
  private launched = false;
  private readonly tabs = new Map<TabId, Page>();
  private seq = 0;

  constructor(private readonly opts: CdpOptions) {
    this.profileDir = join(opts.userDataDir, 'cdp-profile');
  }

  status(): ExecutorStatus {
    return {
      ready: this.context !== null,
      backend: this.backend,
      activeTabId: null,
      extensionConnected: false,
      cdpAttached: this.context !== null,
    };
  }

  async ensureReady(): Promise<void> {
    await this.getContext();
  }
  async ping(): Promise<boolean> {
    return this.context !== null;
  }
  async dispose(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.tabs.clear();
    if (this.opts.mode === 'connect' || !this.launched) return; // never close the user's Chrome
    try {
      await ctx?.close();
    } catch {
      /* ignore */
    }
    this.launched = false;
  }

  // -- acquisition --------------------------------------------------------

  private async getContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = this.opts.mode === 'connect' ? this.doConnect() : this.doLaunch();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async doConnect(): Promise<BrowserContext> {
    if (!this.opts.cdpEndpoint) throw new ExecutorError('LAUNCH_FAILED', 'connect mode requires a cdpEndpoint');
    if (!this.cdpBrowser || !this.cdpBrowser.isConnected()) {
      this.cdpBrowser = await chromium.connectOverCDP(this.opts.cdpEndpoint);
      this.cdpBrowser.on('disconnected', () => {
        this.cdpBrowser = null;
        this.context = null;
        this.tabs.clear();
      });
    }
    const ctx = this.cdpBrowser.contexts()[0];
    if (!ctx) throw new ExecutorError('LAUNCH_FAILED', 'connected browser exposed no context');
    this.context = ctx;
    this.launched = false;
    return ctx;
  }

  private async doLaunch(): Promise<BrowserContext> {
    mkdirSync(this.profileDir, { recursive: true });
    const args = ['--disable-blink-features=AutomationControlled'];
    let ctx: BrowserContext;
    try {
      ctx = await this.launchWithLockRecovery(args);
    } catch (err) {
      throw new ExecutorError('LAUNCH_FAILED', `failed to launch Chromium: ${(err as Error).message}`);
    }
    try {
      await ctx.addInitScript(STEALTH);
    } catch {
      /* non-fatal */
    }
    this.context = ctx;
    this.launched = true;
    ctx.on('close', () => {
      if (this.context === ctx) {
        this.context = null;
        this.tabs.clear();
      }
    });
    return ctx;
  }

  private async launchWithLockRecovery(args: string[]): Promise<BrowserContext> {
    const launchOpts = {
      headless: this.opts.headless ?? true,
      args,
      acceptDownloads: true,
    } as Parameters<typeof chromium.launchPersistentContext>[1];

    try {
      return await chromium.launchPersistentContext(this.profileDir, launchOpts);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!/already in use|existing browser session|ProcessSingleton|SingletonLock|profile.*in use/i.test(msg)) {
        throw err;
      }
      const owner = inspectProfileLock(this.profileDir);
      if (owner.alive && owner.pid !== null) {
        if (isChromiumProcess(owner.pid)) {
          try {
            process.kill(owner.pid, 'SIGKILL');
          } catch {
            /* gone */
          }
          await new Promise((r) => setTimeout(r, 500));
        } else {
          throw new ExecutorError(
            'LAUNCH_FAILED',
            `profile lock held by pid ${owner.pid}, which is not our Chromium`,
          );
        }
      }
      clearProfileLocks(this.profileDir);
      return await chromium.launchPersistentContext(this.profileDir, launchOpts);
    }
  }

  // -- tab resolution -----------------------------------------------------

  private idFor(page: Page): TabId {
    for (const [id, p] of this.tabs) if (p === page) return id;
    const id = `cdp:${this.sessionId}:${++this.seq}`;
    this.tabs.set(id, page);
    return id;
  }

  private contentPages(ctx: BrowserContext): Page[] {
    return ctx.pages().filter((p) => {
      const u = p.url();
      return !!u && !NON_CONTENT.test(u) && u !== 'about:blank';
    });
  }

  private async resolveTab(tabId?: TabId): Promise<Page> {
    const ctx = await this.getContext();
    if (tabId) {
      const p = this.tabs.get(tabId);
      if (!p || p.isClosed()) {
        if (tabId.startsWith('cdp:') && !tabId.startsWith(`cdp:${this.sessionId}:`)) {
          throw new ExecutorError('STALE_TAB', 'tab handle is from a previous session; call tabs_list again');
        }
        throw new ExecutorError('TAB_NOT_FOUND', `no such tab: ${tabId}`);
      }
      return p;
    }
    const content = this.contentPages(ctx);
    const page = content[0] ?? ctx.pages()[0] ?? (await ctx.newPage());
    return page;
  }

  private locator(page: Page, t: Target) {
    if ('selector' in t && t.selector !== undefined) return page.locator(t.selector).first();
    if ('ref' in t && t.ref !== undefined) {
      // Refs are minted by snapshot() as data-mcp-ref attributes on the page.
      return page.locator(`[data-mcp-ref="${cssEscape(t.ref)}"]`).first();
    }
    throw new ExecutorError('SELECTOR_NOT_FOUND', 'provide a selector or a ref from snapshot()');
  }

  /**
   * Run a live-page operation, converting an opaque "target closed"/crashed
   * error from Playwright into a clean DETACHED. On such a failure we also drop
   * the cached context/tabs so the next call relaunches or reconnects cleanly.
   * Any other error is rethrown unchanged.
   */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (CLOSED_TARGET.test(msg)) {
        this.context = null;
        this.tabs.clear();
        throw new ExecutorError('DETACHED', 'browser target closed or crashed; reconnect and retry');
      }
      throw err;
    }
  }

  // -- tabs ---------------------------------------------------------------
  async tabsList(): Promise<TabInfo[]> {
    const ctx = await this.getContext();
    const pages = this.contentPages(ctx);
    const out: TabInfo[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      out.push({ tabId: this.idFor(p), url: p.url(), title: await p.title().catch(() => ''), active: i === 0, index: i });
    }
    return out;
  }
  async tabSelect(tabId: TabId): Promise<TabInfo> {
    const p = await this.resolveTab(tabId);
    await p.bringToFront().catch(() => undefined);
    return { tabId, url: p.url(), title: await p.title().catch(() => ''), active: true, index: 0 };
  }
  async tabNew(url?: string, opts?: { active?: boolean }): Promise<TabInfo> {
    const ctx = await this.getContext();
    const p = await ctx.newPage();
    if (url) await p.goto(url, { waitUntil: 'load' }).catch(() => undefined);
    if (opts?.active !== false) await p.bringToFront().catch(() => undefined);
    return { tabId: this.idFor(p), url: p.url(), title: await p.title().catch(() => ''), active: true, index: 0 };
  }
  async tabClose(tabId: TabId): Promise<{ closed: true; tabId: TabId }> {
    const p = await this.resolveTab(tabId);
    await p.close();
    this.tabs.delete(tabId);
    return { closed: true, tabId };
  }

  // -- navigation ---------------------------------------------------------
  private toState(w?: WaitUntil): 'load' | 'domcontentloaded' | 'networkidle' {
    return w ?? 'load';
  }
  async navigate(args: { url: string; tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(args.tabId);
      const resp = await p.goto(args.url, { waitUntil: this.toState(args.waitUntil) });
      return { url: p.url(), title: await p.title().catch(() => ''), httpStatus: resp?.status() };
    });
  }
  async back(tabId?: TabId): Promise<NavResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(tabId);
      await p.goBack().catch(() => undefined);
      return { url: p.url(), title: await p.title().catch(() => '') };
    });
  }
  async forward(tabId?: TabId): Promise<NavResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(tabId);
      await p.goForward().catch(() => undefined);
      return { url: p.url(), title: await p.title().catch(() => '') };
    });
  }
  async reload(args?: { tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(args?.tabId);
      await p.reload({ waitUntil: this.toState(args?.waitUntil) });
      return { url: p.url(), title: await p.title().catch(() => '') };
    });
  }

  // -- interaction --------------------------------------------------------
  private ok: ActionOk = { ok: true };
  async click(t: Target, opts?: { tabId?: TabId; button?: 'left' | 'right' | 'middle'; clickCount?: number; trusted?: boolean }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      // Playwright already drives real (trusted) input, so `trusted` is a no-op here.
      await this.locator(p, t).click({ button: opts?.button, clickCount: opts?.clickCount });
      return this.ok;
    });
  }
  async type(t: Target, text: string, opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean; trusted?: boolean }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      const loc = this.locator(p, t);
      if (opts?.clear) await loc.fill('');
      if (opts?.keyEvents) await loc.pressSequentially(text);
      else await loc.fill(text);
      if (opts?.pressEnter) await loc.press('Enter');
      return this.ok;
    });
  }
  async selectOption(t: Target, values: string[], opts?: { tabId?: TabId }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      // Try by value, then fall back to visible label.
      const loc = this.locator(p, t);
      try {
        await loc.selectOption(values);
      } catch {
        await loc.selectOption(values.map((label) => ({ label })));
      }
      return this.ok;
    });
  }
  async fill(t: Target, value: string, opts?: { tabId?: TabId }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      await this.locator(p, t).fill(value);
      return this.ok;
    });
  }
  async press(key: string, opts?: { tabId?: TabId; modifiers?: KeyModifier[] }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      const combo = [...(opts?.modifiers ?? []), key].join('+');
      await p.keyboard.press(combo);
      return this.ok;
    });
  }
  async hover(t: Target, opts?: { tabId?: TabId }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      await this.locator(p, t).hover();
      return this.ok;
    });
  }
  async scroll(opts: { tabId?: TabId; x?: number; y?: number; deltaX?: number; deltaY?: number; target?: Target }): Promise<ActionOk> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts.tabId);
      if (opts.target) await this.locator(p, opts.target).scrollIntoViewIfNeeded();
      else if (opts.x !== undefined || opts.y !== undefined) await p.evaluate(([x, y]) => window.scrollTo(x ?? 0, y ?? 0), [opts.x, opts.y]);
      else await p.mouse.wheel(opts.deltaX ?? 0, opts.deltaY ?? 0);
      return this.ok;
    });
  }

  // -- read ---------------------------------------------------------------
  async getText(t?: Target, opts?: { tabId?: TabId }): Promise<{ text: string; ref?: string }> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      const text = t ? await this.locator(p, t).innerText() : await p.locator('body').innerText();
      return { text };
    });
  }
  async getHtml(t?: Target, opts?: { tabId?: TabId; outer?: boolean }): Promise<{ html: string }> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      if (!t) return { html: await p.content() };
      const loc = this.locator(p, t);
      const html = opts?.outer ? await loc.evaluate((el) => (el as Element).outerHTML) : await loc.innerHTML();
      return { html };
    });
  }
  async snapshot(opts?: { tabId?: TabId; interactiveOnly?: boolean; max?: number }): Promise<SnapshotResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      // Inject collectSnapshot's source and run it in the page (it can't close over module scope).
      const raw = await p.evaluate(
        ([fnSrc, interactiveOnly, max]) => {
          // eslint-disable-next-line no-eval
          const fn = (0, eval)(`(${fnSrc})`) as (i: boolean, m: number) => unknown;
          return fn(interactiveOnly as boolean, max as number);
        },
        [collectSnapshot.toString(), opts?.interactiveOnly ?? true, opts?.max ?? 200] as const,
      );
      return raw as SnapshotResult;
    });
  }
  async getCookies(opts?: { tabId?: TabId; url?: string }): Promise<{ cookies: CookieItem[] }> {
    const p = await this.resolveTab(opts?.tabId);
    const url = opts?.url ?? p.url();
    const ctx = await this.getContext();
    const raw = await ctx.cookies(url);
    return {
      cookies: raw.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: c.secure, httpOnly: c.httpOnly, expires: c.expires >= 0 ? c.expires : undefined,
      })),
    };
  }
  async storage(args: { op: StorageOp; key?: string; value?: string; session?: boolean; tabId?: TabId }): Promise<StorageResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(args.tabId);
      return p.evaluate((a) => {
        const store = a.session ? window.sessionStorage : window.localStorage;
        if (a.op === 'set') { store.setItem(String(a.key), String(a.value ?? '')); return { ok: true }; }
        if (a.op === 'remove') { store.removeItem(String(a.key)); return { ok: true }; }
        if (a.op === 'clear') { store.clear(); return { ok: true }; }
        if (a.key) return { ok: true, value: store.getItem(a.key) };
        const entries: Record<string, string> = {};
        for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k) entries[k] = store.getItem(k) ?? ''; }
        return { ok: true, entries };
      }, args) as Promise<StorageResult>;
    });
  }
  async screenshot(opts?: { tabId?: TabId; fullPage?: boolean; target?: Target }): Promise<ScreenshotResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      const buf = opts?.target
        ? await this.locator(p, opts.target).screenshot()
        : await p.screenshot({ fullPage: opts?.fullPage });
      const size = p.viewportSize() ?? { width: 0, height: 0 };
      return { dataBase64: buf.toString('base64'), mimeType: 'image/png', width: size.width, height: size.height, truncated: false };
    });
  }
  async eval(expression: string, opts?: { tabId?: TabId; awaitPromise?: boolean }): Promise<EvalResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts?.tabId);
      try {
        const value = await p.evaluate((expr) => {
          // eslint-disable-next-line no-eval
          return (0, eval)(expr);
        }, expression);
        return truncateEvalResult({ ok: true, value, type: typeof value });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        // A dead/crashed target must surface as DETACHED, not a swallowed EvalResult error.
        if (CLOSED_TARGET.test(msg)) throw err;
        return { ok: false, error: msg };
      }
    });
  }
  async waitFor(opts: { tabId?: TabId; selector?: string; textContains?: string; gone?: boolean; timeoutMs?: number }): Promise<WaitResult> {
    return this.guard(async () => {
      const p = await this.resolveTab(opts.tabId);
      const timeout = opts.timeoutMs ?? 30_000;
      const start = Date.now();
      try {
        if (opts.selector) {
          await p.locator(opts.selector).first().waitFor({ state: opts.gone ? 'detached' : 'visible', timeout });
        } else if (opts.textContains) {
          await p.waitForFunction(
            (needle) => document.body?.innerText.includes(needle) ?? false,
            opts.textContains,
            { timeout },
          );
        }
        return { matched: true, waitedMs: Date.now() - start };
      } catch (err) {
        const msg = (err as Error).message ?? '';
        // Crashed target must escalate to DETACHED; a plain timeout stays a non-match.
        if (CLOSED_TARGET.test(msg)) throw err;
        return { matched: false, waitedMs: Date.now() - start };
      }
    });
  }

  // -- privileged ---------------------------------------------------------
  async download(args: { url?: string; target?: Target; tabId?: TabId; suggestedName?: string }): Promise<DownloadResult> {
    const ctx = await this.getContext();
    const dir = this.opts.downloadDir ?? join(this.opts.userDataDir, 'downloads');
    mkdirSync(dir, { recursive: true });
    const safeName = sanitizeDownloadName(args.suggestedName);
    const dest = join(dir, safeName);
    if (args.url) {
      const resp = await ctx.request.get(args.url);
      const body = await resp.body();
      if (!isWithinSizeCap(body.length)) {
        throw new ExecutorError('DOWNLOAD_FAILED', `download exceeds the ${MAX_DOWNLOAD_BYTES}-byte cap`);
      }
      writeFileSync(dest, body);
      return { path: dest, backend: this.backend, bytes: body.length, mimeType: resp.headers()['content-type'] };
    }
    // Element-triggered download.
    const p = await this.resolveTab(args.tabId);
    const target = args.target;
    if (!target) throw new ExecutorError('DOWNLOAD_FAILED', 'provide a url or a target');
    const [dl] = await Promise.all([p.waitForEvent('download'), this.locator(p, target).click()]);
    let bytes = 0;
    try {
      // Surface a cancelled/interrupted download instead of reporting a phantom success.
      const failure = await dl.failure();
      if (failure) throw new ExecutorError('DOWNLOAD_FAILED', `download failed: ${failure}`);
      await dl.saveAs(dest);
      bytes = statSync(dest).size;
    } catch (err) {
      if (err instanceof ExecutorError) throw err;
      throw new ExecutorError('DOWNLOAD_FAILED', `failed to save download: ${(err as Error).message}`);
    }
    return { path: dest, backend: this.backend, bytes, suggestedName: dl.suggestedFilename() };
  }

  async uploadFile(t: Target, files: string[], opts?: { tabId?: TabId }): Promise<ActionOk> {
    return this.guard(async () => {
      for (const f of files) {
        try {
          statSync(f);
        } catch {
          throw new ExecutorError('UPLOAD_FAILED', `file not found: ${f}`);
        }
      }
      const p = await this.resolveTab(opts?.tabId);
      try {
        await this.locator(p, t).setInputFiles(files);
      } catch (err) {
        if (err instanceof ExecutorError) throw err;
        throw new ExecutorError('UPLOAD_FAILED', `could not set files on the input: ${(err as Error).message}`);
      }
      return this.ok;
    });
  }
}
