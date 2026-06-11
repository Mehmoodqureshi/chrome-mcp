/**
 * src/executor/types.ts — the single backend-agnostic Executor contract.
 *
 * Plain JSON-serializable in/out: no Playwright `Page`, no CDP session, no DOM
 * handle ever crosses this boundary. Both `ExtensionExecutor` (over the WS
 * bridge) and `CdpExecutor` (Playwright) implement this identical interface, so
 * the tool layer never knows or cares which backend is live.
 *
 * Helpers (extract_links / read_as_markdown / fill_form) are composed in
 * `mcp/helpers.ts` from these primitives; only `download` is privileged.
 */

export type BackendKind = 'extension' | 'cdp';
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type MouseButton = 'left' | 'right' | 'middle';

/**
 * A target element: selector XOR ref. `requireTarget()` enforces exactly-one-of.
 * Refs are minted by getText/extractLinks/waitFor/eval results and are
 * PAGE-scoped — invalidated when that tab navigates. Format:
 * `el_<tabShort>_<backendNodeId>`.
 */
export type Target = { selector: string; ref?: never } | { ref: string; selector?: never };

/**
 * Tab handle. ALWAYS prefixed `<backend>:<sessionId>:<rawId>` so a handle minted
 * by one backend/session can never mis-route after a fallback switch or a
 * reconnect (a mismatch becomes a clean `STALE_TAB`, not a wrong-tab action).
 */
export type TabId = string;

export interface TabInfo {
  tabId: TabId;
  url: string;
  title: string;
  active: boolean;
  index: number;
}

export interface NavResult {
  url: string;
  title: string;
  httpStatus?: number;
}

/** `value` is truncated when serialized > 256KB. */
export interface EvalResult {
  ok: boolean;
  value?: unknown;
  type?: string;
  error?: string;
}

export interface WaitResult {
  matched: boolean;
  ref?: string;
  waitedMs: number;
}

export interface ActionOk {
  ok: true;
}

export interface ScreenshotResult {
  dataBase64: string;
  mimeType: 'image/png';
  width: number;
  height: number;
  /** fullPage capture exceeded the height cap; `fullHeight` reports the real size. */
  truncated: boolean;
  fullHeight?: number;
}

export interface DownloadResult {
  path: string;
  backend: BackendKind;
  bytes: number;
  mimeType?: string;
  suggestedName?: string;
}

export interface ExecutorStatus {
  ready: boolean;
  backend: BackendKind | null;
  activeTabId: TabId | null;
  /** WHY unavailable (port in use, no extension, policy denied, etc.). */
  detail?: string;
  extensionConnected: boolean;
  cdpAttached: boolean;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Executor {
  readonly backend: BackendKind;

  status(): ExecutorStatus;

  /** Idempotent lazy connect/attach + self-heal; single-flight guarded. */
  ensureReady(): Promise<void>;

  /**
   * Lightweight responsiveness probe (short deadline). Used by
   * `withReadyExecutor` to detect a dead-but-not-yet-reconnected MV3 worker and
   * fall through to CDP instead of eating a full command timeout.
   */
  ping(deadlineMs?: number): Promise<boolean>;

  /** Close ONLY if we own the browser; never the user's Chrome. */
  dispose(): Promise<void>;

  // --- tabs ---
  tabsList(): Promise<TabInfo[]>;
  tabSelect(tabId: TabId): Promise<TabInfo>;
  tabNew(url?: string): Promise<TabInfo>;
  tabClose(tabId: TabId): Promise<{ closed: true; tabId: TabId }>;

  // --- navigation (active tab unless tabId given) ---
  navigate(args: { url: string; tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult>;
  back(tabId?: TabId): Promise<NavResult>;
  forward(tabId?: TabId): Promise<NavResult>;
  reload(args?: { tabId?: TabId; waitUntil?: WaitUntil }): Promise<NavResult>;

  // --- interaction (Target = {selector} XOR {ref}) ---
  click(
    t: Target,
    opts?: { tabId?: TabId; button?: MouseButton; clickCount?: number },
  ): Promise<ActionOk>;
  type(
    t: Target,
    text: string,
    opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean },
  ): Promise<ActionOk>;
  /** Value-set + input/change events (used by fill_form). */
  fill(t: Target, value: string, opts?: { tabId?: TabId }): Promise<ActionOk>;
  press(key: string, opts?: { tabId?: TabId; modifiers?: KeyModifier[] }): Promise<ActionOk>;
  hover(t: Target, opts?: { tabId?: TabId }): Promise<ActionOk>;
  scroll(opts: {
    tabId?: TabId;
    x?: number;
    y?: number;
    deltaX?: number;
    deltaY?: number;
    target?: Target;
  }): Promise<ActionOk>;

  // --- read (policy-gated by current tab URL) ---
  getText(t?: Target, opts?: { tabId?: TabId }): Promise<{ text: string; ref?: string }>;
  getHtml(t?: Target, opts?: { tabId?: TabId; outer?: boolean }): Promise<{ html: string }>;
  screenshot(opts?: { tabId?: TabId; fullPage?: boolean; target?: Target }): Promise<ScreenshotResult>;
  eval(expression: string, opts?: { tabId?: TabId; awaitPromise?: boolean }): Promise<EvalResult>;
  waitFor(opts: {
    tabId?: TabId;
    selector?: string;
    textContains?: string;
    gone?: boolean;
    timeoutMs?: number;
  }): Promise<WaitResult>;

  // --- privileged, executor-owned (NOT composable) ---
  download(args: {
    url?: string;
    target?: Target;
    tabId?: TabId;
    suggestedName?: string;
  }): Promise<DownloadResult>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Server-side executor error codes. A superset of the wire `ExecutorErrorCode`
 * (which only carries codes that originate inside the extension); these extra
 * codes describe failures on the server half (no backend, launch failed, etc.).
 */
export type ExecutorErrorCodeLocal =
  | 'NO_BACKEND'
  | 'EXTENSION_DISCONNECTED'
  | 'TIMEOUT'
  | 'TAB_NOT_FOUND'
  | 'STALE_TAB'
  | 'SELECTOR_NOT_FOUND'
  | 'REF_EXPIRED'
  | 'EVAL_FAILED'
  | 'LAUNCH_FAILED'
  | 'DETACHED'
  | 'TARGET_GONE'
  | 'POLICY_DENIED'
  | 'DEVTOOLS_OPEN'
  | 'DOWNLOAD_FAILED'
  | 'BACKPRESSURE';

export class ExecutorError extends Error {
  constructor(
    public readonly code: ExecutorErrorCodeLocal,
    message: string,
  ) {
    super(message);
    this.name = 'ExecutorError';
  }
}
