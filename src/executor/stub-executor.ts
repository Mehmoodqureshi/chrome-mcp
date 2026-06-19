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
}

const ok: ActionOk = { ok: true };

export class StubExecutor implements Executor {
  readonly backend: BackendKind = 'extension';
  private url: string;
  private readonly evalThrows: boolean;
  private ready = false;

  constructor(opts: StubOptions = {}) {
    this.url = opts.activeUrl ?? 'about:blank';
    this.evalThrows = opts.evalThrows ?? false;
  }

  private tab(): TabInfo {
    return { tabId: 'extension:stub:1', url: this.url, title: 'Stub Page', active: true, index: 0 };
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
    return [this.tab()];
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
