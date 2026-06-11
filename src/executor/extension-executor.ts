/**
 * src/executor/extension-executor.ts — the Executor backed by the MV3 extension.
 *
 * Every method is a thin translation into a single `bridge.sendCommand(method,
 * params, {tabId, timeoutMs})` round-trip; the extension does the real work over
 * `chrome.debugger`. The "operate-on" tab travels in the frame's `tabId`;
 * method-specific arguments travel in `params`. Results are trusted shapes
 * produced by the extension router (validated there).
 */

import {
  type ActionOk,
  type BackendKind,
  type DownloadResult,
  type EvalResult,
  type Executor,
  type ExecutorStatus,
  type KeyModifier,
  type MouseButton,
  type NavResult,
  type ScreenshotResult,
  type TabId,
  type TabInfo,
  type Target,
  type WaitResult,
  type WaitUntil,
} from './types';
import type { BridgeServer } from '../bridge/server';

/** Flatten a Target into the params a wire command carries. */
function targetParams(t?: Target): Record<string, unknown> {
  if (!t) return {};
  return 'selector' in t && t.selector !== undefined ? { selector: t.selector } : { ref: (t as { ref: string }).ref };
}

export class ExtensionExecutor implements Executor {
  readonly backend: BackendKind = 'extension';

  constructor(private readonly bridge: BridgeServer) {}

  private send(
    method: Parameters<BridgeServer['sendCommand']>[0],
    params: Record<string, unknown>,
    opts?: { tabId?: TabId; timeoutMs?: number },
  ): Promise<unknown> {
    return this.bridge.sendCommand(method, params, opts);
  }

  status(): ExecutorStatus {
    const connected = this.bridge.hasActiveExtension();
    return {
      ready: connected,
      backend: this.backend,
      activeTabId: null, // not known synchronously
      extensionConnected: connected,
      cdpAttached: false,
    };
  }

  async ensureReady(): Promise<void> {
    // The bridge owns connectivity; nothing to launch here. The selector has
    // already confirmed an extension is paired + responsive before picking us.
  }

  async ping(deadlineMs = 800): Promise<boolean> {
    if (!this.bridge.hasActiveExtension()) return false;
    try {
      await this.send('ping_probe', {}, { timeoutMs: deadlineMs });
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    // Never close the user's Chrome.
  }

  // -- tabs ---------------------------------------------------------------
  async tabsList(): Promise<TabInfo[]> {
    return (await this.send('tabs_list', {})) as TabInfo[];
  }
  async tabSelect(tabId: TabId): Promise<TabInfo> {
    return (await this.send('tab_select', {}, { tabId })) as TabInfo;
  }
  async tabNew(url?: string): Promise<TabInfo> {
    return (await this.send('tab_new', { url })) as TabInfo;
  }
  async tabClose(tabId: TabId): Promise<{ closed: true; tabId: TabId }> {
    return (await this.send('tab_close', {}, { tabId })) as { closed: true; tabId: TabId };
  }

  // -- navigation ---------------------------------------------------------
  async navigate(args: { url: string; tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult> {
    return (await this.send('navigate', { url: args.url, waitUntil: args.waitUntil }, { tabId: args.tabId })) as NavResult;
  }
  async back(tabId?: TabId): Promise<NavResult> {
    return (await this.send('back', {}, { tabId })) as NavResult;
  }
  async forward(tabId?: TabId): Promise<NavResult> {
    return (await this.send('forward', {}, { tabId })) as NavResult;
  }
  async reload(args?: { tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult> {
    return (await this.send('reload', { waitUntil: args?.waitUntil }, { tabId: args?.tabId })) as NavResult;
  }

  // -- interaction --------------------------------------------------------
  async click(t: Target, opts?: { tabId?: TabId; button?: MouseButton; clickCount?: number }): Promise<ActionOk> {
    return (await this.send('click', { ...targetParams(t), button: opts?.button, clickCount: opts?.clickCount }, { tabId: opts?.tabId })) as ActionOk;
  }
  async type(
    t: Target,
    text: string,
    opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean },
  ): Promise<ActionOk> {
    return (await this.send(
      'type',
      { ...targetParams(t), text, clear: opts?.clear, pressEnter: opts?.pressEnter, keyEvents: opts?.keyEvents },
      { tabId: opts?.tabId },
    )) as ActionOk;
  }
  async fill(t: Target, value: string, opts?: { tabId?: TabId }): Promise<ActionOk> {
    // No dedicated wire method: a cleared insertText is the fill primitive.
    return (await this.send('type', { ...targetParams(t), text: value, clear: true, keyEvents: false }, { tabId: opts?.tabId })) as ActionOk;
  }
  async press(key: string, opts?: { tabId?: TabId; modifiers?: KeyModifier[] }): Promise<ActionOk> {
    return (await this.send('press', { key, modifiers: opts?.modifiers }, { tabId: opts?.tabId })) as ActionOk;
  }
  async hover(t: Target, opts?: { tabId?: TabId }): Promise<ActionOk> {
    return (await this.send('hover', { ...targetParams(t) }, { tabId: opts?.tabId })) as ActionOk;
  }
  async scroll(opts: {
    tabId?: TabId;
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    target?: Target;
  }): Promise<ActionOk> {
    return (await this.send(
      'scroll',
      { x: opts.x, y: opts.y, deltaX: opts.deltaX, deltaY: opts.deltaY, ...targetParams(opts.target) },
      { tabId: opts.tabId },
    )) as ActionOk;
  }

  // -- read ---------------------------------------------------------------
  async getText(t?: Target, opts?: { tabId?: TabId }): Promise<{ text: string; ref?: string }> {
    return (await this.send('get_text', { ...targetParams(t) }, { tabId: opts?.tabId })) as { text: string; ref?: string };
  }
  async getHtml(t?: Target, opts?: { tabId?: TabId; outer?: boolean }): Promise<{ html: string }> {
    return (await this.send('get_html', { ...targetParams(t), outer: opts?.outer }, { tabId: opts?.tabId })) as { html: string };
  }
  async screenshot(opts?: { tabId?: TabId; fullPage?: boolean; target?: Target }): Promise<ScreenshotResult> {
    return (await this.send('screenshot', { fullPage: opts?.fullPage, ...targetParams(opts?.target) }, { tabId: opts?.tabId })) as ScreenshotResult;
  }
  async eval(expression: string, opts?: { tabId?: TabId; awaitPromise?: boolean }): Promise<EvalResult> {
    return (await this.send('eval', { expression, awaitPromise: opts?.awaitPromise }, { tabId: opts?.tabId })) as EvalResult;
  }
  async waitFor(opts: {
    tabId?: TabId;
    selector?: string;
    textContains?: string;
    gone?: boolean;
    timeoutMs?: number;
  }): Promise<WaitResult> {
    return (await this.send(
      'wait_for',
      { selector: opts.selector, textContains: opts.textContains, gone: opts.gone, timeoutMs: opts.timeoutMs },
      { tabId: opts.tabId, timeoutMs: opts.timeoutMs ? opts.timeoutMs + 5_000 : undefined },
    )) as WaitResult;
  }

  // -- privileged ---------------------------------------------------------
  async download(args: { url?: string; target?: Target; tabId?: TabId; suggestedName?: string }): Promise<DownloadResult> {
    return (await this.send(
      'download_file',
      { url: args.url, ...targetParams(args.target), suggestedName: args.suggestedName },
      { tabId: args.tabId },
    )) as DownloadResult;
  }
}
