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
import { existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from 'playwright';

import { MAX_DOWNLOAD_BYTES, isWithinSizeCap, sanitizeDownloadName } from '../../shared/download';
import {
  type ActionOk,
  type BackendKind,
  type DownloadResult,
  type EvalResult,
  type Executor,
  ExecutorError,
  type ExecutorStatus,
  type KeyModifier,
  type NavResult,
  type ScreenshotResult,
  type TabId,
  type TabInfo,
  type Target,
  type WaitResult,
  type WaitUntil,
} from './types';

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
const STEALTH = `Object.defineProperty(navigator,'webdriver',{get:()=>undefined});`;
const NON_CONTENT = /^(file|data|devtools|chrome|about):/i;

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
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
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
    throw new ExecutorError('SELECTOR_NOT_FOUND', 'the CDP fallback supports selectors, not refs (use the extension backend)');
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
  async tabNew(url?: string): Promise<TabInfo> {
    const ctx = await this.getContext();
    const p = await ctx.newPage();
    if (url) await p.goto(url, { waitUntil: 'load' }).catch(() => undefined);
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
    const p = await this.resolveTab(args.tabId);
    const resp = await p.goto(args.url, { waitUntil: this.toState(args.waitUntil) });
    return { url: p.url(), title: await p.title().catch(() => ''), httpStatus: resp?.status() };
  }
  async back(tabId?: TabId): Promise<NavResult> {
    const p = await this.resolveTab(tabId);
    await p.goBack().catch(() => undefined);
    return { url: p.url(), title: await p.title().catch(() => '') };
  }
  async forward(tabId?: TabId): Promise<NavResult> {
    const p = await this.resolveTab(tabId);
    await p.goForward().catch(() => undefined);
    return { url: p.url(), title: await p.title().catch(() => '') };
  }
  async reload(args?: { tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult> {
    const p = await this.resolveTab(args?.tabId);
    await p.reload({ waitUntil: this.toState(args?.waitUntil) });
    return { url: p.url(), title: await p.title().catch(() => '') };
  }

  // -- interaction --------------------------------------------------------
  private ok: ActionOk = { ok: true };
  async click(t: Target, opts?: { tabId?: TabId; button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<ActionOk> {
    const p = await this.resolveTab(opts?.tabId);
    await this.locator(p, t).click({ button: opts?.button, clickCount: opts?.clickCount });
    return this.ok;
  }
  async type(t: Target, text: string, opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean }): Promise<ActionOk> {
    const p = await this.resolveTab(opts?.tabId);
    const loc = this.locator(p, t);
    if (opts?.clear) await loc.fill('');
    if (opts?.keyEvents) await loc.pressSequentially(text);
    else await loc.fill((opts?.clear ? '' : '') + text);
    if (opts?.pressEnter) await loc.press('Enter');
    return this.ok;
  }
  async fill(t: Target, value: string, opts?: { tabId?: TabId }): Promise<ActionOk> {
    const p = await this.resolveTab(opts?.tabId);
    await this.locator(p, t).fill(value);
    return this.ok;
  }
  async press(key: string, opts?: { tabId?: TabId; modifiers?: KeyModifier[] }): Promise<ActionOk> {
    const p = await this.resolveTab(opts?.tabId);
    const combo = [...(opts?.modifiers ?? []), key].join('+');
    await p.keyboard.press(combo);
    return this.ok;
  }
  async hover(t: Target, opts?: { tabId?: TabId }): Promise<ActionOk> {
    const p = await this.resolveTab(opts?.tabId);
    await this.locator(p, t).hover();
    return this.ok;
  }
  async scroll(opts: { tabId?: TabId; x?: number; y?: number; deltaX?: number; deltaY?: number; target?: Target }): Promise<ActionOk> {
    const p = await this.resolveTab(opts.tabId);
    if (opts.target) await this.locator(p, opts.target).scrollIntoViewIfNeeded();
    else if (opts.x !== undefined || opts.y !== undefined) await p.evaluate(([x, y]) => window.scrollTo(x ?? 0, y ?? 0), [opts.x, opts.y]);
    else await p.mouse.wheel(opts.deltaX ?? 0, opts.deltaY ?? 0);
    return this.ok;
  }

  // -- read ---------------------------------------------------------------
  async getText(t?: Target, opts?: { tabId?: TabId }): Promise<{ text: string; ref?: string }> {
    const p = await this.resolveTab(opts?.tabId);
    const text = t ? await this.locator(p, t).innerText() : await p.locator('body').innerText();
    return { text };
  }
  async getHtml(t?: Target, opts?: { tabId?: TabId; outer?: boolean }): Promise<{ html: string }> {
    const p = await this.resolveTab(opts?.tabId);
    if (!t) return { html: await p.content() };
    const loc = this.locator(p, t);
    const html = opts?.outer ? await loc.evaluate((el) => (el as Element).outerHTML) : await loc.innerHTML();
    return { html };
  }
  async screenshot(opts?: { tabId?: TabId; fullPage?: boolean; target?: Target }): Promise<ScreenshotResult> {
    const p = await this.resolveTab(opts?.tabId);
    const buf = opts?.target
      ? await this.locator(p, opts.target).screenshot()
      : await p.screenshot({ fullPage: opts?.fullPage });
    const size = p.viewportSize() ?? { width: 0, height: 0 };
    return { dataBase64: buf.toString('base64'), mimeType: 'image/png', width: size.width, height: size.height, truncated: false };
  }
  async eval(expression: string, opts?: { tabId?: TabId; awaitPromise?: boolean }): Promise<EvalResult> {
    const p = await this.resolveTab(opts?.tabId);
    try {
      const value = await p.evaluate((expr) => {
        // eslint-disable-next-line no-eval
        return (0, eval)(expr);
      }, expression);
      return { ok: true, value, type: typeof value };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  async waitFor(opts: { tabId?: TabId; selector?: string; textContains?: string; gone?: boolean; timeoutMs?: number }): Promise<WaitResult> {
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
    } catch {
      return { matched: false, waitedMs: Date.now() - start };
    }
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
    await dl.saveAs(dest);
    return { path: dest, backend: this.backend, bytes: 0, suggestedName: dl.suggestedFilename() };
  }
}
