/**
 * src/executor/stub-executor.ts — an in-memory Executor with no browser.
 *
 * Two jobs:
 *   1. Lets Phase 1 ship a fully working MCP server you can point Claude at with
 *      zero Chrome involved (the CLI uses it until the real backends land).
 *   2. Drives the dispatch/policy/envelope tests with deterministic, canned
 *      values (and a couple of forced-failure switches).
 */

import {
  ExecutorError,
  type ActionOk,
  type BackendKind,
  type CookieItem,
  type DownloadResult,
  type EvalResult,
  type Executor,
  type ExecutorStatus,
  type NavResult,
  type ScreenshotResult,
  type SnapshotResult,
  type StorageOp,
  type StorageResult,
  type TabId,
  type TabInfo,
  type Target,
  type WaitResult,
} from './types';

/** 1×1 transparent PNG, base64 — a valid image block for screenshot tests. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface StubOptions {
  /** URL of the (single) active tab — used to exercise the domain policy gate. */
  activeUrl?: string;
  /** When true, `eval` resolves `{ok:false}` to mimic a page-side throw. */
  evalThrows?: boolean;
  /** When true, `tabsList` rejects — mimics a transient bridge failure. */
  tabsListThrows?: boolean;
  /** When true, `tabsList` resolves empty — mimics a browser reporting no tabs. */
  noTabs?: boolean;
  /** When true, the (single) tab reports an empty URL — mimics a chrome:// page
   *  or a site the extension has no host access to. */
  blankTabUrl?: boolean;
  /** A URL the backend claims to already know, as the extension reports on every
   *  result frame. Set it to assert the gate uses it INSTEAD of calling tabsList. */
  cachedUrl?: string;
}

const ok: ActionOk = { ok: true };

export class StubExecutor implements Executor {
  readonly backend: BackendKind = 'extension';
  private url: string;
  private readonly evalThrows: boolean;
  private readonly tabsListThrows: boolean;
  private readonly noTabs: boolean;
  private readonly blankTabUrl: boolean;
  private readonly cached: string | null;
  /** How many times the gate actually asked for the tab list — the round-trip
   *  counter the caching path exists to keep at zero. */
  tabsListCalls = 0;
  private ready = false;

  constructor(opts: StubOptions = {}) {
    this.url = opts.activeUrl ?? 'about:blank';
    this.evalThrows = opts.evalThrows ?? false;
    this.tabsListThrows = opts.tabsListThrows ?? false;
    this.noTabs = opts.noTabs ?? false;
    this.blankTabUrl = opts.blankTabUrl ?? false;
    this.cached = opts.cachedUrl ?? null;
  }

  private tab(): TabInfo {
    return {
      tabId: 'extension:stub:1',
      url: this.blankTabUrl ? '' : this.url,
      title: 'Stub Page',
      active: true,
      index: 0,
    };
  }

  cachedActiveUrl(): string | null {
    return this.cached;
  }

  status(): ExecutorStatus {
    return {
      ready: this.ready,
      backend: this.backend,
      activeTabId: this.tab().tabId,
      extensionConnected: true,
      cdpAttached: false,
    };
  }

  async ensureReady(): Promise<void> {
    this.ready = true;
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async dispose(): Promise<void> {
    this.ready = false;
  }

  async tabsList(): Promise<TabInfo[]> {
    this.tabsListCalls++;
    if (this.tabsListThrows) throw new ExecutorError('EXTENSION_DISCONNECTED', 'stub bridge is down');
    return this.noTabs ? [] : [this.tab()];
  }
  async tabSelect(tabId: TabId): Promise<TabInfo> {
    return { ...this.tab(), tabId };
  }
  async tabNew(url?: string, _opts?: { active?: boolean }): Promise<TabInfo> {
    if (url) this.url = url;
    return this.tab();
  }
  async tabClose(tabId: TabId): Promise<{ closed: true; tabId: TabId }> {
    return { closed: true, tabId };
  }

  async navigate(args: { url: string }): Promise<NavResult> {
    this.url = args.url;
    return { url: args.url, title: 'Stub Page', httpStatus: 200 };
  }
  async back(): Promise<NavResult> {
    return { url: this.url, title: 'Stub Page' };
  }
  async forward(): Promise<NavResult> {
    return { url: this.url, title: 'Stub Page' };
  }
  async reload(): Promise<NavResult> {
    return { url: this.url, title: 'Stub Page' };
  }

  async click(): Promise<ActionOk> {
    return ok;
  }
  async type(): Promise<ActionOk> {
    return ok;
  }
  async fill(): Promise<ActionOk> {
    return ok;
  }
  async press(): Promise<ActionOk> {
    return ok;
  }
  async hover(): Promise<ActionOk> {
    return ok;
  }
  async selectOption(): Promise<ActionOk> {
    return ok;
  }
  async scroll(): Promise<ActionOk> {
    return ok;
  }

  async getText(_t?: Target): Promise<{ text: string; ref?: string }> {
    return { text: 'stub text', ref: 'el_stub_1' };
  }
  async getHtml(): Promise<{ html: string }> {
    return { html: '<html><body><a href="https://example.com">Example</a></body></html>' };
  }
  async snapshot(): Promise<SnapshotResult> {
    return {
      url: this.url,
      title: 'Stub Page',
      nodes: [{ ref: 'e1', role: 'link', name: 'Example', tag: 'a' }],
      truncated: false,
    };
  }
  async getCookies(): Promise<{ cookies: CookieItem[] }> {
    return { cookies: [{ name: 'stub', value: '1', domain: 'example.com', path: '/', secure: true, httpOnly: false }] };
  }
  async storage(args: { op: StorageOp; key?: string }): Promise<StorageResult> {
    if (args.op === 'get') return { ok: true, value: args.key ? 'stub-value' : null, entries: args.key ? undefined : { k: 'stub-value' } };
    return { ok: true };
  }
  async screenshot(): Promise<ScreenshotResult> {
    return { dataBase64: TINY_PNG, mimeType: 'image/png', width: 1, height: 1, truncated: false };
  }
  async eval(expression: string): Promise<EvalResult> {
    if (this.evalThrows || /throw/.test(expression)) {
      return { ok: false, error: 'Error: stub page threw' };
    }
    return { ok: true, value: 'stub-value', type: 'string' };
  }
  async waitFor(): Promise<WaitResult> {
    return { matched: true, waitedMs: 0 };
  }

  async download(args: { suggestedName?: string }): Promise<DownloadResult> {
    return {
      path: `/stub/downloads/${args.suggestedName ?? 'file.download'}`,
      backend: this.backend,
      bytes: 0,
    };
  }

  async uploadFile(): Promise<ActionOk> {
    return ok;
  }
}
