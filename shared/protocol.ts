/**
 * shared/protocol.ts — THE SINGLE SOURCE OF TRUTH for the wire contract.
 *
 * Imported VERBATIM by both the server build (`src/`) and the extension build
 * (`extension/`). Nothing about the bridge wire format, the default port, or the
 * protocol version may be redeclared anywhere else — if it is, the two ends can
 * silently drift. (Phase 0 verification asserts there is exactly one copy.)
 *
 * The server is the WebSocket SERVER; the extension is the single privileged
 * CLIENT that dials in. Methods on the wire mirror the MCP primitives 1:1.
 * Helpers (extract_links / read_as_markdown) are NOT on the wire — they are
 * composed server-side from these primitives. `download_file` is a wire method
 * beyond the primitives, and so is `fill_form` (a batch of `type`/`click` writes
 * in one round-trip; capability-gated, see `WIRE_CAP_FILL_FORM`).
 */

/** Bumped on any breaking change to the frames below. */
export const PROTOCOL_VERSION = 1 as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

/**
 * Default loopback port the bridge binds and the extension dials. NOT a security
 * boundary (the token is) — a fixed port is only a convenience; the canonical
 * port travels with the token in `handshake.json`, and ephemeral port `0` is
 * supported because the extension re-reads the handshake on every failed dial.
 */
export const DEFAULT_WS_PORT = 38017 as const;

/** Loopback host. Never bind 0.0.0.0. */
export const BRIDGE_HOST = '127.0.0.1' as const;

/** WebSocket close codes we use deliberately. */
export const CLOSE_UNAUTHORIZED = 4401 as const;
export const CLOSE_SUPERSEDED = 4000 as const;

/**
 * Capabilities an extension advertises in `hello`. Additive and optional, so an
 * older extension (which sends none) keeps the conservative behaviour — never
 * gate a capability behind a version-string comparison.
 *
 * `tab-url`: this extension (a) enforces the policy mirror FAIL-CLOSED — it
 * refuses every command until a policy has arrived — and (b) reports the target
 * tab's post-command URL as `ResultFrame.tabUrl`. Together those let the server
 * gate from the reported URL instead of paying a `tabs_list` round-trip before
 * every call. Without it, the server falls back to fetching the URL itself.
 */
export const WIRE_CAP_TAB_URL = 'tab-url' as const;

/**
 * `fill-form`: this extension handles the `fill_form` wire method — every field
 * of a form written in ONE round-trip. Without it the server fills field by
 * field over `type`/`click`, which every extension build understands.
 */
export const WIRE_CAP_FILL_FORM = 'fill-form' as const;

/** One field write inside a `fill_form` command: set a value, or click to toggle. */
export interface FillFieldOp {
  selector: string;
  /** A string is value-set (cleared first); a boolean toggles via a click. */
  value: string | boolean;
}

/**
 * `fill_form` result. Ops run in order and stop at the first failure, so
 * `filled` counts the fields that landed and `error` names the one that did not.
 */
export interface FillFormWireResult {
  filled: number;
  error?: { selector: string; code: ExecutorErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

/**
 * Every method that may travel on the wire = the MCP primitives 1:1, plus
 * `download_file` (privileged, executor-owned) and `ping_probe` (a short-deadline
 * responsiveness check used to detect a dead-but-not-yet-reconnected worker).
 */
export type WireMethod =
  | 'tabs_list'
  | 'tab_select'
  | 'tab_new'
  | 'tab_close'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload'
  | 'click'
  | 'type'
  | 'press'
  | 'hover'
  | 'scroll'
  | 'screenshot'
  | 'get_text'
  | 'get_html'
  | 'snapshot'
  | 'select_option'
  | 'get_cookies'
  | 'storage'
  | 'eval'
  | 'wait_for'
  | 'download_file'
  | 'upload_file'
  | 'frames_list'
  | 'observers'
  | 'print_pdf'
  | 'fill_form'
  | 'ping_probe';

/** Runtime list of every WireMethod, for boot-time drift assertions on both ends. */
export const WIRE_METHODS: readonly WireMethod[] = [
  'tabs_list',
  'tab_select',
  'tab_new',
  'tab_close',
  'navigate',
  'back',
  'forward',
  'reload',
  'click',
  'type',
  'press',
  'hover',
  'scroll',
  'screenshot',
  'get_text',
  'get_html',
  'snapshot',
  'select_option',
  'get_cookies',
  'storage',
  'eval',
  'wait_for',
  'download_file',
  'upload_file',
  'frames_list',
  'observers',
  'print_pdf',
  'fill_form',
  'ping_probe',
] as const;

// ---------------------------------------------------------------------------
// Errors (the canonical wire error enum)
// ---------------------------------------------------------------------------

export type ExecutorErrorCode =
  | 'NO_TARGET'
  | 'TARGET_GONE'
  | 'DETACHED'
  | 'DEVTOOLS_OPEN'
  | 'SELECTOR_NOT_FOUND'
  | 'REF_EXPIRED'
  | 'EVAL_THREW'
  | 'TIMEOUT'
  | 'BAD_ARGS'
  | 'CDP_ERROR'
  | 'POLICY_DENIED'
  | 'DOWNLOAD_FAILED'
  | 'UPLOAD_FAILED'
  | 'FRAME_NOT_FOUND'
  | 'OBSERVERS_DISABLED'
  | 'UNKNOWN_METHOD';

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface BaseFrame {
  type: string;
  v: ProtocolVersion;
}

// ---- handshake ----

export interface HelloFrame extends BaseFrame {
  type: 'hello';
  token: string;
  ext: { id: string; version: string; chrome: string };
  /** Routing label: which profile this browser pairs as. Absent/empty → "default".
   *  NOT a security boundary (the token is) — it selects which connection slot the
   *  server routes commands to, so several browsers can stay paired at once. */
  profile?: string;
  /** Random id this extension install keeps in its chrome.storage.local — one per
   *  Chrome profile. With no `profile` label, the server names the browser from it
   *  ("default", "profile-2", ...) so two blank-profile browsers never collide. */
  installId?: string;
  /** Optional capability advertisements (see `WIRE_CAP_TAB_URL`). An extension
   *  that sends none gets the conservative path, so old builds stay correct. */
  caps?: string[];
}

/**
 * The wire-serializable subset of the server's policy, delivered in `welcome` so
 * the extension can enforce the SAME gate the server does (defense-in-depth). The
 * server-only `uploadsDir` (a local filesystem path) is intentionally NOT sent.
 */
export interface WirePolicy {
  allowDomains: string[];
  allowEval: boolean;
  allowDownloads: boolean;
  allowUploads: boolean;
  allowAllTabs: boolean;
  enableMutations: boolean;
  /**
   * Whether the in-page observer hook (console / network / dialog capture) may
   * be installed. Off by default: it patches `console`, `fetch`,
   * `XMLHttpRequest` and the dialog functions on every allowlisted page in the
   * user's real browser, which is too invasive to turn on for someone silently.
   * Optional so an older extension deserializing a newer welcome frame reads it
   * as undefined -> falsy -> the safe answer.
   */
  allowObservers?: boolean;
}

export interface WelcomeFrame extends BaseFrame {
  type: 'welcome';
  serverVersion: string;
  sessionId: string;
  heartbeatMs: number;
  /** The active policy, so the extension can mirror the server-side gate. */
  policy: WirePolicy;
  /** The profile name this browser was paired as (shown in the Options page).
   *  Optional so an older server's welcome still parses. */
  profile?: string;
}

export interface UnauthFrame extends BaseFrame {
  type: 'unauthorized';
  reason: 'bad_token' | 'bad_version' | 'timeout';
}

// ---- command / result ----

export interface CommandFrame extends BaseFrame {
  type: 'command';
  id: string;
  method: WireMethod;
  params: Record<string, unknown>;
  tabId?: string;
  timeoutMs: number;
}

export interface ResultFrame extends BaseFrame {
  type: 'result';
  id: string;
  ok: true;
  /** For `screenshot`: { dataBase64, mimeType, width, height, truncated }. */
  data: unknown;
  /**
   * The target tab's URL as observed AFTER the command ran — the extension has
   * it locally, so sending it costs nothing and saves the server a round-trip
   * on the next policy gate. Omitted when it can't be resolved (e.g. the tab was
   * closed). Only sent by extensions advertising `WIRE_CAP_TAB_URL`.
   */
  tabUrl?: string;
}

export interface ErrorFrame extends BaseFrame {
  type: 'error';
  id: string;
  ok: false;
  error: { code: ExecutorErrorCode; message: string; data?: Record<string, unknown> };
}

// ---- unsolicited + heartbeat ----

export type WireEvent =
  | 'tab_created'
  | 'tab_removed'
  | 'tab_updated'
  | 'detached'
  | 'target_gone';

export interface EventFrame extends BaseFrame {
  type: 'event';
  event: WireEvent;
  data: Record<string, unknown>;
}

export interface PingFrame extends BaseFrame {
  type: 'ping';
  ts: number;
}

export interface PongFrame extends BaseFrame {
  type: 'pong';
  ts: number;
}

// ---- unions ----

/** Frames the SERVER sends to the extension. */
export type ServerFrame = CommandFrame | WelcomeFrame | UnauthFrame | PingFrame;

/** Frames the EXTENSION sends to the server. */
export type ExtensionFrame = HelloFrame | ResultFrame | ErrorFrame | EventFrame | PongFrame;

export type Frame = ServerFrame | ExtensionFrame;

// ---------------------------------------------------------------------------
// Handshake file (written 0600 by the server; read by the extension trampoline)
// ---------------------------------------------------------------------------

/** Shape of `$CHROME_MCP_DATA/handshake.json`. The token is a secret. */
export interface HandshakeFile {
  v: ProtocolVersion;
  port: number;
  token: string;
  pid: number;
  ts: number;
  expectedExtensionId?: string;
}
