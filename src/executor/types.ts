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
  /** Set when `value` exceeded MAX_EVAL_BYTES and was replaced by a truncated JSON string. */
  truncated?: boolean;
}

/** Hard cap on a serialized eval result before it is truncated (see `truncateEvalResult`). */
export const MAX_EVAL_BYTES = 256 * 1024;

/**
 * Enforce the EvalResult size cap uniformly across backends. Attempts to
 * JSON-serialize `value`; if the UTF-8 byte length exceeds MAX_EVAL_BYTES the
 * value is replaced by the JSON sliced to the cap with a `...[truncated]`
 * marker and `truncated: true` is set. Non-serializable values (stringify
 * throws or yields undefined) are left untouched — this never throws.
 */
export function truncateEvalResult(result: EvalResult): EvalResult {
  if (!result.ok || result.value === undefined) return result;
  let json: string | undefined;
  try {
    json = JSON.stringify(result.value);
  } catch {
    return result; // not serializable — leave value as-is
  }
  if (json === undefined) return result;
  if (Buffer.byteLength(json, 'utf8') <= MAX_EVAL_BYTES) return result;
  // Slice by bytes, then trim any partial trailing UTF-8 char before appending the marker.
  const sliced = Buffer.from(json, 'utf8').subarray(0, MAX_EVAL_BYTES).toString('utf8');
  return { ...result, value: `${sliced}...[truncated]`, truncated: true };
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

/** One interactive/landmark element in an accessibility snapshot. `ref` is stable until the tab navigates. */
export interface SnapshotNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface SnapshotResult {
  url: string;
  title: string;
  nodes: SnapshotNode[];
  truncated: boolean;
}

export interface CookieItem {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expires?: number;
}

export type StorageOp = 'get' | 'set' | 'remove' | 'clear';
export interface StorageResult {
  ok: boolean;
  /** For `get`: the value (or null if absent). For others: omitted. */
  value?: string | null;
  /** For a keyless `get`: the whole store as a flat object. */
  entries?: Record<string, string>;
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
    opts?: { tabId?: TabId; button?: MouseButton; clickCount?: number; trusted?: boolean },
  ): Promise<ActionOk>;
  type(
    t: Target,
    text: string,
    opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean; trusted?: boolean },
  ): Promise<ActionOk>;
  /** Choose option(s) of a <select> by value or visible label. */
  selectOption(t: Target, values: string[], opts?: { tabId?: TabId }): Promise<ActionOk>;
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
  /** Accessibility snapshot: interactive/landmark elements with stable refs the model can target. */
  snapshot(opts?: { tabId?: TabId; interactiveOnly?: boolean; max?: number }): Promise<SnapshotResult>;
  /** Read cookies visible to the active tab's URL (or a given url). */
  getCookies(opts?: { tabId?: TabId; url?: string }): Promise<{ cookies: CookieItem[] }>;
  /** localStorage/sessionStorage get/set/remove/clear for the active tab. */
  storage(args: { op: StorageOp; key?: string; value?: string; session?: boolean; tabId?: TabId }): Promise<StorageResult>;
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

  /**
   * Set the files on a file `<input>` (target by selector or ref) from local
   * absolute paths — the upload equivalent of a file-picker, without the OS
   * dialog. Privileged: sends local files to the page, so it is gated by
   * `allowUploads` and the destination domain allowlist.
   */
  uploadFile(t: Target, files: string[], opts?: { tabId?: TabId }): Promise<ActionOk>;
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
  | 'UPLOAD_FAILED'
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
