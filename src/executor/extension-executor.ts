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
  type CookieItem,
  type DownloadResult,
  type EvalResult,
  type Executor,
  ExecutorError,
  type ExecutorStatus,
  type FillFieldOp,
  type FrameInfo,
  type FrameOpts,
  type ObserverArgs,
  type ObserverReadResult,
  type PdfResult,
  type KeyModifier,
  type MouseButton,
  type NavResult,
  type ScreenshotEncoding,
  type ScreenshotResult,
  type SnapshotLocator,
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
import { WIRE_CAP_FILL_FORM, fillFormTimeoutMs, type FillFormWireResult } from '../../shared/protocol';
import type { BridgeServer } from '../bridge/server';
import { mapWireErrorCode } from '../bridge/connection';
import { captureDownload, peekActiveWorkspace } from '../bridge/workspace';

/**
 * How long a reported active-tab URL stays usable for the policy gate.
 *
 * Deliberately short. It exists to cover back-to-back calls (a `batch`, or an
 * agent's read → click → read), where the tab demonstrably has not changed
 * between them. Past that, pay the round-trip. Note the extension re-gates every
 * command against the tab's live URL regardless (fail-closed, authoritative), so
 * this window trades a little pre-check precision for half the traffic — never
 * enforcement itself.
 */
const ACTIVE_URL_TTL_MS = 2_000;

/** Flatten frame options into the params a wire command carries. */
function frameParams(o?: FrameOpts): Record<string, unknown> {
  if (!o) return {};
  return {
    ...(o.frameId !== undefined ? { frameId: o.frameId } : {}),
    ...(o.allFrames ? { allFrames: true } : {}),
  };
}

/** Flatten a Target into the params a wire command carries. */
function targetParams(t?: Target): Record<string, unknown> {
  if (!t) return {};
  return 'selector' in t && t.selector !== undefined ? { selector: t.selector } : { ref: (t as { ref: string }).ref };
}

export class ExtensionExecutor implements Executor {
  readonly backend: BackendKind = 'extension';

  constructor(private readonly bridge: BridgeServer) {}

  /** The profile this executor routes to = the active task workspace's profile
   *  (set by `profile_use`). Falls back to "default" before a workspace exists. */
  private activeProfile(): string {
    return peekActiveWorkspace()?.profile ?? 'default';
  }

  private send(
    method: Parameters<BridgeServer['sendCommand']>[0],
    params: Record<string, unknown>,
    opts?: { tabId?: TabId; timeoutMs?: number },
  ): Promise<unknown> {
    return this.bridge.sendCommand(method, params, { ...opts, profile: this.activeProfile() });
  }

  status(): ExecutorStatus {
    const profile = this.activeProfile();
    const connected = this.bridge.hasConnection(profile);
    return {
      ready: connected,
      backend: this.backend,
      activeTabId: null, // not known synchronously
      extensionConnected: connected,
      cdpAttached: false,
      detail: connected ? undefined : `active profile "${profile}" has no paired browser`,
      activeProfile: profile,
      connectedProfiles: this.bridge.connectedProfiles(),
    };
  }

  async ensureReady(): Promise<void> {
    // The bridge owns connectivity; nothing to launch here. The selector has
    // already confirmed an extension is paired + responsive before picking us.
  }

  async ping(deadlineMs = 800): Promise<boolean> {
    if (!this.bridge.hasConnection(this.activeProfile())) return false;
    try {
      await this.send('ping_probe', {}, { timeoutMs: deadlineMs });
      return true;
    } catch {
      return false;
    }
  }

  /** Why this executor can't serve the active profile right now: not paired, or
   *  paired but not answering pings. Used for the selector's NO_BACKEND message. */
  unavailableReason(): string {
    const profile = this.activeProfile();
    if (!this.bridge.hasConnection(profile)) return this.bridge.noPairMessage(profile);
    return (
      `The browser paired for profile "${profile}" is not responding. Open that Chrome, ` +
      `or reload the chrome-mcp extension in chrome://extensions, then retry.`
    );
  }

  async dispose(): Promise<void> {
    // Never close the user's Chrome.
  }

  /** The active tab's URL as reported by the last command on this profile, if it
   *  is fresh enough to gate against. See `ACTIVE_URL_TTL_MS`. */
  cachedActiveUrl(): string | null {
    return this.bridge.lastActiveUrl(this.activeProfile(), ACTIVE_URL_TTL_MS);
  }

  /** A specific tab's URL as last reported (by a result for that tab, or by a
   *  `tabs_list`), if fresh enough to gate against. */
  cachedTabUrl(tabId: TabId): string | null {
    return this.bridge.lastTabUrl(this.activeProfile(), tabId, ACTIVE_URL_TTL_MS);
  }

  // -- tabs ---------------------------------------------------------------
  async tabsList(): Promise<TabInfo[]> {
    return (await this.send('tabs_list', {})) as TabInfo[];
  }
  async tabSelect(tabId: TabId): Promise<TabInfo> {
    return (await this.send('tab_select', {}, { tabId })) as TabInfo;
  }
  async tabNew(url?: string, opts?: { active?: boolean }): Promise<TabInfo> {
    return (await this.send('tab_new', { url, active: opts?.active })) as TabInfo;
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
  async click(t: Target, opts?: { tabId?: TabId; button?: MouseButton; clickCount?: number; trusted?: boolean } & FrameOpts): Promise<ActionOk> {
    return (await this.send('click', { ...targetParams(t), ...frameParams(opts), button: opts?.button, clickCount: opts?.clickCount, trusted: opts?.trusted }, { tabId: opts?.tabId })) as ActionOk;
  }
  async type(
    t: Target,
    text: string,
    opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean; trusted?: boolean } & FrameOpts,
  ): Promise<ActionOk> {
    return (await this.send(
      'type',
      { ...targetParams(t), ...frameParams(opts), text, clear: opts?.clear, pressEnter: opts?.pressEnter, keyEvents: opts?.keyEvents, trusted: opts?.trusted },
      { tabId: opts?.tabId },
    )) as ActionOk;
  }
  async selectOption(t: Target, values: string[], opts?: { tabId?: TabId } & FrameOpts): Promise<ActionOk> {
    return (await this.send('select_option', { ...targetParams(t), ...frameParams(opts), values }, { tabId: opts?.tabId })) as ActionOk;
  }
  async fill(t: Target, value: string, opts?: { tabId?: TabId } & FrameOpts): Promise<ActionOk> {
    // No dedicated wire method: a cleared insertText is the fill primitive.
    return (await this.send('type', { ...targetParams(t), ...frameParams(opts), text: value, clear: true, keyEvents: false }, { tabId: opts?.tabId })) as ActionOk;
  }
  async fillFields(fields: FillFieldOp[], opts?: { tabId?: TabId } & FrameOpts): Promise<{ filled: number } | null> {
    // An extension that predates the op never advertised it: let the caller go field by field.
    if (!this.bridge.hasCap(this.activeProfile(), WIRE_CAP_FILL_FORM)) return null;
    const res = (await this.send(
      'fill_form',
      { ops: fields, ...frameParams(opts) },
      { tabId: opts?.tabId, timeoutMs: fillFormTimeoutMs(fields.length) },
    )) as FillFormWireResult;
    if (res.error) {
      // Say how far the batch got: the fields before this one DID land, and a
      // blind retry of the whole form would write them a second time.
      const where = `field ${res.filled + 1} of ${fields.length} (${res.error.selector}) failed after ${res.filled} filled`;
      throw new ExecutorError(mapWireErrorCode(res.error.code), `${where}: ${res.error.message}`);
    }
    return { filled: res.filled };
  }
  async press(key: string, opts?: { tabId?: TabId; modifiers?: KeyModifier[] }): Promise<ActionOk> {
    return (await this.send('press', { key, modifiers: opts?.modifiers }, { tabId: opts?.tabId })) as ActionOk;
  }
  async hover(t: Target, opts?: { tabId?: TabId } & FrameOpts): Promise<ActionOk> {
    return (await this.send('hover', { ...targetParams(t), ...frameParams(opts) }, { tabId: opts?.tabId })) as ActionOk;
  }
  async scroll(opts: {
    tabId?: TabId;
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    target?: Target;
  } & FrameOpts): Promise<ActionOk> {
    return (await this.send(
      'scroll',
      { x: opts.x, y: opts.y, deltaX: opts.deltaX, deltaY: opts.deltaY, ...targetParams(opts.target), ...frameParams(opts) },
      { tabId: opts.tabId },
    )) as ActionOk;
  }

  // -- read ---------------------------------------------------------------
  async getText(t?: Target, opts?: { tabId?: TabId } & FrameOpts): Promise<{ text: string; ref?: string }> {
    return (await this.send('get_text', { ...targetParams(t), ...frameParams(opts) }, { tabId: opts?.tabId })) as { text: string; ref?: string };
  }
  async getHtml(t?: Target, opts?: { tabId?: TabId; outer?: boolean } & FrameOpts): Promise<{ html: string }> {
    return (await this.send('get_html', { ...targetParams(t), ...frameParams(opts), outer: opts?.outer }, { tabId: opts?.tabId })) as { html: string };
  }
  async snapshot(opts?: { tabId?: TabId; interactiveOnly?: boolean; max?: number; locator?: SnapshotLocator } & FrameOpts): Promise<SnapshotResult> {
    return (await this.send(
      'snapshot',
      { interactiveOnly: opts?.interactiveOnly, max: opts?.max, locator: opts?.locator, ...frameParams(opts) },
      { tabId: opts?.tabId },
    )) as SnapshotResult;
  }
  async getCookies(opts?: { tabId?: TabId; url?: string }): Promise<{ cookies: CookieItem[] }> {
    return (await this.send('get_cookies', { url: opts?.url }, { tabId: opts?.tabId })) as { cookies: CookieItem[] };
  }
  async storage(args: { op: StorageOp; key?: string; value?: string; session?: boolean; tabId?: TabId }): Promise<StorageResult> {
    return (await this.send('storage', { op: args.op, key: args.key, value: args.value, session: args.session }, { tabId: args.tabId })) as StorageResult;
  }
  async screenshot(opts?: { tabId?: TabId; fullPage?: boolean; target?: Target } & ScreenshotEncoding & FrameOpts): Promise<ScreenshotResult> {
    return (await this.send(
      'screenshot',
      {
        fullPage: opts?.fullPage,
        format: opts?.format,
        quality: opts?.quality,
        scale: opts?.scale,
        ...targetParams(opts?.target),
        ...frameParams(opts),
      },
      { tabId: opts?.tabId },
    )) as ScreenshotResult;
  }
  async eval(expression: string, opts?: { tabId?: TabId; awaitPromise?: boolean } & FrameOpts): Promise<EvalResult> {
    const result = (await this.send('eval', { expression, awaitPromise: opts?.awaitPromise, ...frameParams(opts) }, { tabId: opts?.tabId })) as EvalResult;
    return truncateEvalResult(result);
  }
  async waitFor(opts: {
    tabId?: TabId;
    selector?: string;
    textContains?: string;
    gone?: boolean;
    timeoutMs?: number;
  } & FrameOpts): Promise<WaitResult> {
    return (await this.send(
      'wait_for',
      { selector: opts.selector, textContains: opts.textContains, gone: opts.gone, timeoutMs: opts.timeoutMs, ...frameParams(opts) },
      { tabId: opts.tabId, timeoutMs: opts.timeoutMs ? opts.timeoutMs + 5_000 : undefined },
    )) as WaitResult;
  }

  // -- privileged ---------------------------------------------------------
  async download(args: { url?: string; target?: Target; tabId?: TabId; suggestedName?: string }): Promise<DownloadResult> {
    const res = (await this.send(
      'download_file',
      { url: args.url, ...targetParams(args.target), suggestedName: args.suggestedName },
      { tabId: args.tabId },
    )) as DownloadResult;
    // The extension can only write to the user's Downloads dir; relocate the file
    // into the active task's downloads/ so each task collects its own artifacts.
    // If the move fails, keep Chrome's path rather than reporting a phantom failure.
    if (res.sourcePath) {
      try {
        const moved = captureDownload(res.sourcePath, res.suggestedName);
        return { ...res, path: moved.path, bytes: moved.bytes, sourcePath: undefined };
      } catch {
        // Capture failed (e.g. over the size cap): leave the file where Chrome put
        // it and report that path instead of failing the call.
        return { ...res, sourcePath: undefined };
      }
    }
    return res;
  }

  async uploadFile(t: Target, files: string[], opts?: { tabId?: TabId }): Promise<ActionOk> {
    return (await this.send('upload_file', { ...targetParams(t), files }, { tabId: opts?.tabId })) as ActionOk;
  }

  // -- optional capabilities ----------------------------------------------
  async framesList(opts?: { tabId?: TabId }): Promise<FrameInfo[]> {
    const res = (await this.send('frames_list', {}, { tabId: opts?.tabId })) as { frames?: FrameInfo[] };
    return res.frames ?? [];
  }

  async observers(args: ObserverArgs): Promise<ObserverReadResult> {
    return (await this.send(
      'observers',
      {
        ...frameParams(args),
        console: args.console,
        network: args.network,
        dialogs: args.dialogs,
        sinceSeq: args.sinceSeq,
        limit: args.limit,
        clear: args.clear,
        setPolicy: args.setPolicy,
        promptText: args.promptText,
        includeResources: args.includeResources,
      },
      { tabId: args.tabId },
    )) as ObserverReadResult;
  }

  async printPdf(opts?: {
    tabId?: TabId;
    landscape?: boolean;
    printBackground?: boolean;
    scale?: number;
    paperWidth?: number;
    paperHeight?: number;
    pageRanges?: string;
    preferCSSPageSize?: boolean;
  }): Promise<PdfResult> {
    return (await this.send(
      'print_pdf',
      {
        landscape: opts?.landscape,
        printBackground: opts?.printBackground,
        scale: opts?.scale,
        paperWidth: opts?.paperWidth,
        paperHeight: opts?.paperHeight,
        pageRanges: opts?.pageRanges,
        preferCSSPageSize: opts?.preferCSSPageSize,
      },
      // A large page can take a while through Chrome's print pipeline.
      { tabId: opts?.tabId, timeoutMs: 60_000 },
    )) as PdfResult;
  }
}
