# Chrome MCP — Build-Ready Blueprint (v1)

> An MCP server that lets Claude drive a real Chrome browser. One pluggable
> `Executor` interface, two backends: an MV3 **extension** (primary, drives the
> user's real Chrome via `chrome.debugger`/CDP) and a **CDP fallback** (the
> server launches/attaches Chromium via Playwright). Distributed as an npm
> package run with `npx` plus a load-unpacked extension.
>
> This document is the spec. Every blocker and major from verification has been
> **designed away**; resolutions are called out inline as **[RESOLVED]**.

---

## 1. Overview & Architecture

Three "worlds" cooperate through one process-global `ExecutorManager` and one
canonical wire protocol. The MCP host (Claude Desktop / Code) speaks JSON-RPC
over **stdio**; the extension speaks the canonical frame protocol over a
**localhost WebSocket**; the CDP fallback speaks **Playwright/CDP**.

```
            ┌──────────────────────────────────────────────────────────────┐
 WORLD 1    │  MCP HOST (Claude Desktop / Claude Code)                      │
 (the model)│  spawns:  npx chrome-mcp                                      │
            └───────────────┬──────────────────────────────────────────────┘
                            │ JSON-RPC over stdio  (stdout = SACRED)
            ┌───────────────▼──────────────────────────────────────────────┐
 WORLD 2    │  chrome-mcp CLI  (one Node process)                           │
 (server)   │                                                              │
            │  ┌────────────┐   ┌──────────────────┐   ┌─────────────────┐ │
            │  │ MCP Server │──▶│  tools.ts        │──▶│ ExecutorManager │ │
            │  │ (stdio)    │   │  dispatchToolCall│   │ (selection +    │ │
            │  └────────────┘   │  + policy gate   │   │  self-heal)     │ │
            │                   └──────────────────┘   └───┬─────────┬───┘ │
            │                                              │         │     │
            │                              ┌───────────────▼──┐   ┌──▼────┐│
            │                              │ ExtensionExecutor│   │ Cdp-  ││
            │                              │ (WS proxy)       │   │ Exec- ││
            │                              └───────┬──────────┘   │ utor  ││
            │   ┌─────────────────────┐            │              └──┬────┘│
            │   │ BridgeServer (ws)   │◀───────────┘ sendCommand()   │     │
            │   │ 127.0.0.1:<port>    │  id-correlated frames        │     │
            │   │ token gate (only    │                              │     │
            │   │ real boundary)      │                              │     │
            │   └──────────┬──────────┘                              │     │
            └──────────────│─────────────────────────────────────────│─────┘
                           │ ws:// loopback                           │
                           │ (extension dials IN as CLIENT)           │ Playwright
            ┌──────────────▼─────────────────────┐    ┌───────────────▼───────────┐
 WORLD 3    │  MV3 EXTENSION (user's REAL Chrome) │    │  Chromium (server-owned   │
 (browser)  │  background SW: WsClient + Router   │    │  OR attached via          │
            │  CdpExecutor over chrome.debugger   │    │  connectOverCDP)          │
            │  → real cookies / real logins       │    │  FALLBACK ONLY            │
            └────────────────────────────────────┘    └───────────────────────────┘
```

**Backend selection (every `ensureReady()`):** prefer a *responsive*
authenticated extension; otherwise, if `cdpFallback` is enabled, lazily
launch/attach Chromium. Selection is re-evaluated per call so a late extension
takes over from CDP and vice-versa on disconnect.

**Decisive global calls:**
- Single process-global `Executor` pointer for v1 (not a pool). Multi-session is out of scope.
- **The 256-bit per-boot token is the ONLY security boundary.** Origin checks and the loopback bind are defense-in-depth against *browser-page* attackers, not native processes. [RESOLVED — security blockers 2 & 3]
- **One canonical `protocol.ts`** imported by both server and extension. Four conflicting wire/port/token designs are collapsed into this single contract. [RESOLVED — integration blocker 1]
- **Helpers (`extract_links`, `read_as_markdown`, `fill_form`) are composed server-side** from primitives. Only `download_file` is an executor/wire method. [RESOLVED — integration blocker 2]
- **Default-deny domain policy is ON by default and gates reads too**, enforced SERVER-SIDE inside the executor dispatch (both backends). NOTE: the extension router does NOT independently re-check the policy — the bridge token is the sole trust boundary for the WebSocket. Mirroring the gate into the extension router is a planned hardening. [RESOLVED — security major 4 & eval]

---

## 2. Repository Layout

Single sibling repo `chrome-mcp/` (NOT a workspace). Two build roots in one git
repo so the wire protocol version-locks between server and extension. The shared
`protocol.ts` lives at the top so both builds import the *same file*.

```
chrome-mcp/
├── package.json                 # bin: chrome-mcp -> dist/cli.js; deps sdk, ws, playwright
├── tsconfig.json
├── README.md
├── .gitignore                   # dist/, extension-dist/, test-targets.json, *.handshake
├── scripts/
│   └── postinstall.js           # playwright install chromium (CDP fallback only); skip-guarded
│
├── shared/
│   └── protocol.ts              # ⭐ SINGLE SOURCE OF TRUTH for the wire contract
│                                #   imported by BOTH src/ and extension/ builds
│
├── src/                         # → dist/ via tsc
│   ├── cli.ts                   # npx entry: parseArgs, help/version, boot bridge+stdio, shutdown
│   ├── config.ts                # CliConfig + parseArgs (single port/token/policy source)
│   ├── mcp/
│   │   ├── server.ts            # createServer factory + start/stop/isRunning + logErr (clean-stdout)
│   │   ├── tools.ts             # TOOL_DEFINITIONS + TOOL_HANDLERS + dispatchToolCall + drift-check
│   │   ├── validators.ts        # asArgs/requireString/optional*/requireTarget guards
│   │   ├── envelopes.ts         # jsonResult / imageResult / textResult
│   │   ├── helpers.ts           # extract_links / read_as_markdown / fill_form composed server-side
│   │   └── markdown-extract.ts  # dependency-free HTML→md reducer (injected string)
│   ├── executor/
│   │   ├── types.ts             # ⭐ Executor interface + arg/result types + ExecutorError
│   │   ├── manager.ts           # ExecutorManager singleton + withReadyExecutor + selection/self-heal
│   │   ├── extension-executor.ts# proxies primitives → BridgeServer.sendCommand
│   │   ├── cdp-executor.ts      # Playwright connectOverCDP / launchPersistentContext (BrowserManager port)
│   │   └── page-scripts.ts      # shared injected-script sources (getText/extractLinks/waitFor poll)
│   ├── bridge/
│   │   ├── server.ts            # BridgeServer: ws on 127.0.0.1, token gate, id-correlation, heartbeat
│   │   ├── connection.ts        # ExtensionConnection: pending-map, timeouts, reject-all-on-close
│   │   ├── auth.ts              # token gen, atomic 0600 handshake.json, hashed constant-time compare
│   │   └── datadir.ts           # Electron-free CHROME_MCP_DATA || ~/.chrome-mcp
│   └── security/
│       └── policy.ts            # Policy type, loadPolicy, assertUrlAllowed (default-deny, gates reads)
│
├── extension/                   # → extension-dist/ via esbuild (load-unpacked root)
│   ├── manifest.json            # MV3; keyed for stable id; minimum_chrome_version 123
│   ├── icons/{16,48,128}.png
│   ├── scripts/build-ext.mjs    # esbuild background.ts (esm) + options.ts (iife) + copy manifest/html/icons
│   ├── package.json             # devDeps only: typescript, esbuild, @types/chrome
│   └── src/
│       ├── sw/
│       │   ├── background.ts     # SW entry: top-level listeners, ensureConnected, keepalive loop
│       │   ├── ws-client.ts      # dial ws://, hello-token handshake, reconnect, ping/pong
│       │   ├── router.ts         # CommandRouter: never-throw firewall, drift-assert, policy gate
│       │   ├── cdp-executor.ts   # chrome.debugger Executor: ensureAttached self-heal, poll-based lifecycle
│       │   └── tabs.ts           # tabs_list/select/new/close + attachedTabId persistence + validation
│       ├── options/
│       │   ├── options.html
│       │   └── options.ts        # native-host pairing status + manual fallback paste; live status
│       └── nm/
│           └── trampoline.ts     # (optional, v1.1) native-messaging host that reads handshake.json
│
├── test/
│   ├── stub-executor.ts          # in-memory Executor (canned values + forced throws)
│   ├── bridge.test.ts            # node --test: token gate, id-correlation, displacement, deadline→isError
│   ├── tools.test.ts             # dispatch drift-check, requireTarget, isError envelope, image block
│   ├── policy.test.ts            # default-deny, read-gating, allowlist glob, token-never-logged assertion
│   ├── extension-smoke.ts        # Playwright --load-extension, programmatic pair, navigate→getText
│   └── hitl/                     # human-gated e2e (cloned from linkedin-mcp/test/hitl)
│       ├── index.ts runner.ts reporter.ts prompts.ts types.ts scenarios.ts
│
├── test-targets.example.json     # committed; test-targets.json is gitignored
└── policy.example.json           # committed example allowlist
```

---

## 3. The Executor Interface

The single backend-agnostic contract. Plain JSON-serializable in/out — **no
Playwright `Page`, no CDP session, no DOM handle crosses this boundary.** Both
`ExtensionExecutor` and `CdpExecutor` implement it. Helpers are composed in
`mcp/helpers.ts` from these primitives; only `download` is privileged.

```ts
// src/executor/types.ts  (and re-exported shapes shared with shared/protocol.ts)

export type BackendKind = 'extension' | 'cdp';
export type WaitUntil   = 'load' | 'domcontentloaded' | 'networkidle';
export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

/** Selector XOR ref. requireTarget() enforces exactly-one-of. Refs are minted
 *  by getText/extractLinks/waitFor/eval results and are PAGE-scoped: invalidated
 *  on that tab's navigation. ref format: `el_<tabShort>_<backendNodeId>`. */
export type Target = { selector: string; ref?: never } | { ref: string; selector?: never };

/** tabId is ALWAYS prefixed `<backend>:<sessionId>:<rawId>` so a handle from one
 *  backend/session can never mis-route after a fallback switch or reconnect. */
export type TabId = string;

export interface TabInfo  { tabId: TabId; url: string; title: string; active: boolean; index: number; }
export interface NavResult{ url: string; title: string; httpStatus?: number; }
export interface EvalResult { ok: boolean; value?: unknown; type?: string; error?: string; } // value truncated >256KB
export interface WaitResult { matched: boolean; ref?: string; waitedMs: number; }
export interface ActionOk   { ok: true; }
export interface ScreenshotResult {
  dataBase64: string; mimeType: 'image/png';
  width: number; height: number; truncated: boolean; fullHeight?: number;  // fullPage cap metadata
}
export interface DownloadResult { path: string; backend: BackendKind; bytes: number; mimeType?: string; suggestedName?: string; }

export interface ExecutorStatus {
  ready: boolean;
  backend: BackendKind | null;
  activeTabId: TabId | null;
  detail?: string;                 // WHY unavailable (port in use, no extension, policy, etc.)
  extensionConnected: boolean;
  cdpAttached: boolean;
}

export interface Executor {
  readonly backend: BackendKind;
  status(): ExecutorStatus;
  /** idempotent lazy connect/attach + self-heal; single-flight guarded. */
  ensureReady(): Promise<void>;
  /** lightweight responsiveness probe (short deadline) — used by withReadyExecutor
   *  to detect a dead-but-not-yet-reconnected MV3 worker and fall through. */
  ping(deadlineMs?: number): Promise<boolean>;
  dispose(): Promise<void>;        // close ONLY if we own the browser; never the user's Chrome

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
  click(t: Target, opts?: { tabId?: TabId; button?: 'left'|'right'|'middle'; clickCount?: number }): Promise<ActionOk>;
  type(t: Target, text: string, opts?: { tabId?: TabId; clear?: boolean; pressEnter?: boolean; keyEvents?: boolean }): Promise<ActionOk>;
  fill(t: Target, value: string, opts?: { tabId?: TabId }): Promise<ActionOk>;   // value-set + input/change (used by fill_form)
  press(key: string, opts?: { tabId?: TabId; modifiers?: KeyModifier[] }): Promise<ActionOk>;
  hover(t: Target, opts?: { tabId?: TabId }): Promise<ActionOk>;
  scroll(opts: { tabId?: TabId; x?: number; y?: number; deltaX?: number; deltaY?: number; target?: Target }): Promise<ActionOk>;

  // --- read (policy-gated by current tab URL) ---
  getText(t?: Target, opts?: { tabId?: TabId }): Promise<{ text: string; ref?: string }>;
  getHtml(t?: Target, opts?: { tabId?: TabId; outer?: boolean }): Promise<{ html: string }>;
  screenshot(opts?: { tabId?: TabId; fullPage?: boolean; target?: Target }): Promise<ScreenshotResult>;
  eval(expression: string, opts?: { tabId?: TabId; awaitPromise?: boolean }): Promise<EvalResult>;
  waitFor(opts: { tabId?: TabId; selector?: string; textContains?: string; gone?: boolean; timeoutMs?: number }): Promise<WaitResult>;

  // --- privileged, executor-owned (NOT composable) ---
  download(args: { url?: string; target?: Target; tabId?: TabId; suggestedName?: string }): Promise<DownloadResult>;
}

export class ExecutorError extends Error {
  constructor(
    public code:
      | 'NO_BACKEND' | 'EXTENSION_DISCONNECTED' | 'TIMEOUT'
      | 'TAB_NOT_FOUND' | 'STALE_TAB' | 'SELECTOR_NOT_FOUND' | 'REF_EXPIRED'
      | 'EVAL_FAILED' | 'LAUNCH_FAILED' | 'DETACHED' | 'TARGET_GONE'
      | 'POLICY_DENIED' | 'DEVTOOLS_OPEN' | 'DOWNLOAD_FAILED' | 'BACKPRESSURE',
    message: string,
  ) { super(message); this.name = 'ExecutorError'; }
}
```

**`ExecutorManager`** (the `withReadyDriver` analog, `linkedin-mcp/src/driver/linkedin.ts:208`
/ `linkedin-mcp/src/mcp/tools.ts:638`):

```ts
export class ExecutorManager {
  constructor(deps: { bridge: BridgeServer; policy: Policy; cdpFallback: boolean;
                      cdpEndpoint?: string; headless: boolean; userDataDir: string });
  static getInstance(deps?: ConstructorParameters<typeof ExecutorManager>[0]): ExecutorManager;

  /** Re-selects backend (extension-if-responsive else CDP), ensures operational,
   *  single-flight guarded by this.readying. PINGs the extension with a short
   *  deadline; a dead MV3 worker falls through to CDP instead of eating a 30s
   *  timeout. [RESOLVED — mv3 keepalive blocker] */
  ensureReady(): Promise<Executor>;
  peek(): { backend: BackendKind | null; ready: boolean; detail?: string };
  dispose(): Promise<void>;
}
export async function withReadyExecutor(): Promise<Executor> {
  return ExecutorManager.getInstance().ensureReady();
}
```

Selection logic, decisively:
1. If `bridge.hasActiveExtension()` **and** `extensionExecutor.ping(800ms)` resolves true → return `ExtensionExecutor`.
2. Else if `cdpFallback` → single-flight `cdpExecutor.ensureReady()` (launch or `connectOverCDP`) → return it.
3. Else → `throw new ExecutorError('NO_BACKEND', 'No Chrome available: open the extension and pair it, or enable CDP fallback.')`.

Mid-call disconnects are **not** migrated: the in-flight call rejects (→ `isError`),
the *next* call re-selects. Tool descriptions tell the model to retry on disconnect.

---

## 4. Wire Protocol

One canonical `shared/protocol.ts`, `v:1`, **snake_case** method names matching
the MCP primitives 1:1, JSON text frames (one object per WS message),
request/response correlated by `id`. The server is the WS **SERVER**; the
extension is the single privileged **CLIENT**. [RESOLVED — integration blocker 1]

```ts
// shared/protocol.ts  — imported VERBATIM by src/ and extension/
export const PROTOCOL_VERSION = 1 as const;

/** Methods on the wire = MCP primitives 1:1. Helpers (extract_links,
 *  read_as_markdown, fill_form) are NOT here — composed server-side.
 *  Only download_file is a wire method beyond the primitives. [RESOLVED] */
export type WireMethod =
  | 'tabs_list' | 'tab_select' | 'tab_new' | 'tab_close'
  | 'navigate' | 'back' | 'forward' | 'reload'
  | 'click' | 'type' | 'press' | 'hover' | 'scroll'
  | 'screenshot' | 'get_text' | 'get_html' | 'eval' | 'wait_for'
  | 'download_file' | 'ping_probe';

export interface BaseFrame { type: string; v: 1; }

// ---- handshake ----
export interface HelloFrame   extends BaseFrame { type: 'hello'; token: string; ext: { id: string; version: string; chrome: string }; }
export interface WelcomeFrame extends BaseFrame { type: 'welcome'; serverVersion: string; sessionId: string; heartbeatMs: number; }
export interface UnauthFrame  extends BaseFrame { type: 'unauthorized'; reason: 'bad_token' | 'bad_version' | 'timeout'; }

// ---- command / result ----
export interface CommandFrame extends BaseFrame {
  type: 'command'; id: string; method: WireMethod;
  params: Record<string, unknown>; tabId?: string; timeoutMs: number;
}
export interface ResultFrame extends BaseFrame {
  type: 'result'; id: string; ok: true; data: unknown;       // screenshot: { dataBase64, mimeType, width, height, truncated }
}
export interface ErrorFrame extends BaseFrame {
  type: 'error'; id: string; ok: false; error: { code: ExecutorErrorCode; message: string; data?: Record<string, unknown> };
}

// ---- unsolicited + heartbeat ----
export interface EventFrame extends BaseFrame {
  type: 'event'; event: 'tab_created'|'tab_removed'|'tab_updated'|'detached'|'target_gone'; data: Record<string, unknown>;
}
export interface PingFrame extends BaseFrame { type: 'ping'; ts: number; }
export interface PongFrame extends BaseFrame { type: 'pong'; ts: number; }

export type ServerFrame    = CommandFrame | WelcomeFrame | UnauthFrame | PingFrame;
export type ExtensionFrame = HelloFrame | ResultFrame | ErrorFrame | EventFrame | PongFrame;
export type Frame = ServerFrame | ExtensionFrame;

export type ExecutorErrorCode =
  | 'NO_TARGET' | 'TARGET_GONE' | 'DETACHED' | 'DEVTOOLS_OPEN'
  | 'SELECTOR_NOT_FOUND' | 'REF_EXPIRED' | 'EVAL_THREW'
  | 'TIMEOUT' | 'BAD_ARGS' | 'CDP_ERROR' | 'POLICY_DENIED'
  | 'DOWNLOAD_FAILED' | 'UNKNOWN_METHOD';
```

**Auth handshake (the canonical, ONLY model):** [RESOLVED — security blocker 1, minor 7]
1. Server, at boot, generates a **fresh 256-bit token every boot**, never persisted/reused: `crypto.randomBytes(32).toString('base64url')`. It writes `{ v, port, token, pid, ts, expectedExtensionId? }` **atomically** (tmp + `rename`) to `$CHROME_MCP_DATA/handshake.json` with mode **0600**, verifies the mode after write, and **fails closed** if it cannot. The token is **never** written to stdout or stderr or any log. A test asserts this.
2. The extension acquires `{port, token}` from the handshake file via a **native-messaging trampoline** (`extension/src/nm/`) — the only component that can read a 0600 file the model/attacker cannot. v1 ships a **manual fallback**: the user runs `npx chrome-mcp --print-pairing` which prints a **redacted confirmation + the file path** (`handshake.json written to …; open the extension and click Pair`) and the trampoline reads it. **No token on stdout/stderr, no `/connect` HTTP endpoint.** [RESOLVED — security blocker 3]
3. Extension dials `ws://127.0.0.1:<port>` (port read from handshake via trampoline; see §6 for re-read-on-reconnect) and sends `hello` within 5000ms.
4. Server compares tokens by **hashing both sides to SHA-256 and `timingSafeEqual`-ing the digests** (no length precondition, no length leak). Match → `welcome`, flip to ACTIVE; mismatch / `v!==1` / timeout → send `unauthorized` then close **4401**. No `command`/`result`/`event` is processed before `welcome`.

**id correlation & timeouts:**
- `id` is a server-generated ULID per `CommandFrame`. `ExtensionConnection` holds `Map<id, { resolve, reject, timer, method, startedAt }>`.
- Per-request timeout is **method-aware**: default **30s**; `screenshot`, `wait_for`, `navigate`, `download_file` get **60s**. On timeout: reject `ExecutorError('TIMEOUT')`, delete the entry, **do NOT close the socket**.
- On socket close/error: reject **every** pending entry with `EXTENSION_DISCONNECTED`, clear the map.
- Backpressure: before send, if `ws.bufferedAmount > 8MB` reject `BACKPRESSURE` (screenshots are large; never queue unboundedly).

**Heartbeat:** app-level `ping`/`pong` every 15s, layered over `ws` native ping/pong. Two missed pongs (>30s silence) → terminate connection → next `ensureReady` falls to CDP, with a loud stderr note.

**Single-active-connection (security-aware):** a second valid-token dial **supersedes** the first (close 4000). This is logged **loudly to stderr AND surfaced via `chrome_status`** as a *security-relevant displacement event*, not a UX nicety. The active connection is bound to the `ext.id` from the first `hello`; a displacement by a *different* id is refused without an explicit user re-pair. [RESOLVED — security minor 9]

---

## 5. The Complete MCP Tool Surface

26 tools. `readOnly` is metadata (not a JSON-Schema field) consumed by the host
and by **safe-mode** (shipped in v1, default ON). Every handler:
`withReadyExecutor()` → validate args (`requireTarget` for selector|ref) →
**`policy.assertUrlAllowed(currentTabUrl, method)`** → call executor/helper →
`jsonResult`/`imageResult`/`textResult`. `dispatchToolCall` is the single
never-throw firewall converting any thrown `Error` to `{isError:true}`.

| Tool | Input (summary) | Returns | R/O? | Impl home |
|---|---|---|---|---|
| `tabs_list` | `{}` | `TabInfo[]` | read | executor primitive |
| `tab_select` | `{tabId}` | `TabInfo` | mutate | executor primitive |
| `tab_new` | `{url?}` | `TabInfo` | mutate | executor primitive |
| `tab_close` | `{tabId}` | `{closed,tabId}` | mutate | executor primitive |
| `navigate` | `{url, tabId?, waitUntil?}` | `NavResult` | mutate | executor primitive |
| `back` | `{tabId?}` | `NavResult` | mutate | executor primitive |
| `forward` | `{tabId?}` | `NavResult` | mutate | executor primitive |
| `reload` | `{tabId?, waitUntil?}` | `NavResult` | mutate | executor primitive |
| `click` | `{selector?\|ref?, tabId?, button?, clickCount?}` | `ActionOk` | mutate | executor primitive |
| `type` | `{selector?\|ref?, text, tabId?, clear?, pressEnter?, keyEvents?}` | `ActionOk` | mutate | executor primitive |
| `press` | `{key, modifiers?, tabId?}` | `ActionOk` | mutate | executor primitive |
| `hover` | `{selector?\|ref?, tabId?}` | `ActionOk` | mutate | executor primitive |
| `scroll` | `{x?,y?,deltaX?,deltaY?,selector?\|ref?, tabId?}` | `ActionOk` | mutate | executor primitive |
| `screenshot` | `{fullPage?, selector?\|ref?, tabId?}` | **image block** + dims/truncated | read* | executor primitive |
| `get_text` | `{selector?\|ref?, tabId?}` | `{text, ref?}` | read | executor primitive |
| `get_html` | `{selector?\|ref?, outer?, tabId?}` | `{html}` | read | executor primitive |
| `eval` | `{expression, awaitPromise?, tabId?}` | `EvalResult` | **mutate** | executor primitive |
| `wait_for` | `{selector?, textContains?, gone?, timeoutMs?, tabId?}` | `WaitResult` | read | executor primitive |
| `extract_links` | `{selector?, sameOriginOnly?, include?, exclude?, tabId?}` | `{links:[{href,text,ref}]}` | read | **server helper** (one `ex.eval` IIFE) |
| `read_as_markdown` | `{selector?, tabId?}` | raw markdown text | read | **server helper** (md-reducer IIFE) |
| `fill_form` | `{fields:{[selector]:string\|bool}, submitSelector?, tabId?}` | `{filled, submitted}` | mutate | **server helper** (seq `ex.fill`/`ex.click`) |
| `download_file` | `{url?\|(selector?\|ref?), suggestedName?, tabId?}` | `DownloadResult` | mutate | **executor `download`** (privileged) |
| `chrome_status` | `{}` | `ExecutorStatus` + displacement/heartbeat flags | read | manager (defensive cached fallback) |

Notes:
- **`screenshot` is `readOnly:true` but auto-scrolls the target into view** before capture — documented benign side effect. Returns a real `{type:'image',data,mimeType}` block (the one envelope extension over the LinkedIn repo). `read*` = read with a benign side effect.
- **`eval` is `readOnly:false`** (arbitrary JS). Safe-mode disables `eval` and the entire mutating set unless `--unsafe-enable-eval` / `--enable-mutations`. [RESOLVED — security major eval]
- **`eval`/all reads/all navigations call `policy.assertUrlAllowed(tab.currentUrl, method)`** before dispatch — reads are gated because reads are the exfil payload. [RESOLVED — security major 4]
- Validators add `optionalBoolean`, `optionalNumber(float,bounds)`, `optionalStringArray`, and `requireTarget` (exactly-one-of selector|ref) to the lifted LinkedIn set.

---

## 6. Chrome Extension

### 6.1 `manifest.json` (full)

```json
{
  "manifest_version": 3,
  "name": "Chrome MCP Bridge",
  "version": "1.0.0",
  "minimum_chrome_version": "123",
  "key": "<BASE64_PUBLIC_KEY_PINS_A_DETERMINISTIC_EXTENSION_ID>",
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": [
    "debugger", "tabs", "scripting", "activeTab", "downloads", "storage",
    "alarms", "nativeMessaging"
  ],
  "optional_host_permissions": ["*://*/*"],
  "host_permissions": [],
  "options_page": "options.html",
  "action": { "default_title": "Chrome MCP — click to pair / attach" },
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

Decisions (each justified, narrowed for review): [RESOLVED — security major 4, mv3 minors]
- **No `<all_urls>` baked in.** `host_permissions: []`; hosts are requested on demand via `optional_host_permissions` after the user action-click grants the tab. `debugger` does not need host permissions; reading `tab.url` needs only `tabs`. This is the default-deny posture at the manifest level and eases (eventual) store review.
- `nativeMessaging` powers the pairing trampoline that reads the 0600 handshake file.
- `key` pins a deterministic extension id so the Origin pin is meaningful; the id is **public**, the token is the secret.
- `minimum_chrome_version: 123` (not 116) for predictable `alarms`/`storage.session`/`debugger` behavior the keepalive design assumes. [RESOLVED — mv3 nit]

### 6.2 Background service worker (eviction survival)

**Posture (correct, kept):** all listeners registered **synchronously at top
level**; **zero authoritative state in SW memory** — `{wsPort, token-presence,
connState}` in `chrome.storage.local`, `attachedTabId` in
`chrome.storage.session`. On every wake (`onStartup`/`onInstalled`/`onAlarm`/
`onClicked`/`onMessage`) call `ensureConnected()` which re-hydrates and (re)dials.

**Keepalive — the real one.** [RESOLVED — mv3 blocker 1]
`chrome.alarms` (≥30s) only *wakes* the worker; an open WebSocket does **not**
extend MV3 worker lifetime. So:
- While a session is ACTIVE (after `welcome`, until socket close or N idle minutes), run a **25s `setInterval` that issues an *awaited extension API call*** (`await chrome.storage.local.get('connState')`) — an awaited extension API call resets the 30s idle timer; raw socket I/O does not.
- A **`chrome.alarms` keepalive (every 30s) is the cold-restart safety net** and the authoritative **reconnect driver**: on each alarm, if `connState !== 'connected'` and not `unauthorized`, re-dial. The fragile in-SW backoff timer is best-effort only. [RESOLVED — mv3 minor reconnect]
- The server **cannot wake a dead worker**, so the gap between death and next wake is real: `withReadyExecutor` PINGs the extension with an **800ms deadline**; a dead-but-not-yet-reconnected worker fails the probe and the call **falls through to CDP** instead of eating a 30s timeout (or a short bounded retry if CDP is disabled). [RESOLVED]

**Port re-read on reconnect (port/token consistency):** [RESOLVED — mv3 blocker 3, security minor 8]
The canonical token+port live together in `handshake.json` (one source of
truth). The extension learns both via the native-messaging trampoline. **Whenever
a WS dial FAILS** (server restarted → fresh token + possibly fresh port), the SW
re-invokes the trampoline to re-read `{port, token}` before the next dial. This
makes ephemeral ports work: the extension never holds a stale port. The single
default fixed port is **`38017`** (override `CHROME_MCP_WS_PORT`); ephemeral
port `0` is supported precisely because the extension re-reads on failure. The
port is **not** a security boundary — the token is.

**WsClient handshake & unauthorized:** on `open`, send `hello` with the
trampoline-read token. `welcome` → ACTIVE + start keepalive interval.
`unauthorized` → **stop reconnecting, badge `AUTH`, re-read handshake on next
alarm** (server likely rotated the token). `options.ts` must **`await
chrome.storage.local.set(...)` before** sending `{type:'reconnect'}` so the SW
reads fresh config; the `unauthorized` state is cleared atomically on re-pair.

**Router (`router.ts`):** extension-side mirror of `dispatchToolCall` — one
try/catch firewall, **never throws**, always returns exactly one
`result`/`error` per `id`. Boot-time **drift assert** that every `WireMethod`
has a router case and vice-versa. **The router calls
`policy.assertUrlAllowed(currentTabUrl, method)` BEFORE any
`chrome.debugger.attach`/`navigate`/`eval`/read** — the policy gate is enforced
at *both* ends. [RESOLVED — security major 4]

### 6.3 chrome.debugger method-mapping table

`CdpExecutor` (extension side) over `chrome.debugger.sendCommand({tabId}, …,
'1.3')`. **Resolve selectors AND refs uniformly to `backendNodeId` →
`DOM.getBoxModel` quad center**; scroll-into-view first; this fixes off-screen,
zoom, and same-origin-iframe coordinate bugs. [RESOLVED — mv3 major coordinates]

| Protocol method | CDP / chrome.* calls |
|---|---|
| `tabs_list` | `chrome.tabs.query({})` → scheme-filter (`http/https/file`; skip `chrome://`,`devtools://`,`about:blank`) |
| `tab_select` | single-flight: `detach(old)` → `chrome.debugger.attach({tabId},'1.3')` → enable `Page`,`Runtime`,`DOM` (lazy `Accessibility`) → persist `attachedTabId` |
| `tab_new` / `tab_close` | `chrome.tabs.create({url,active:false})` (auto-select) / detach-if-attached → `chrome.tabs.remove` |
| `navigate` | `Page.navigate` then **poll `Runtime.evaluate(document.readyState)`** to the requested `waitUntil`, deadline-bounded |
| `back`/`forward` | `Page.getNavigationHistory` → `Page.navigateToHistoryEntry` |
| `reload` | `Page.reload` + readiness poll |
| `click`/`hover` | resolve target → `DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` center → `Input.dispatchMouseEvent` (pressed/released; trusted events) |
| `type` | `DOM.focus` → if `clear` select-all+delete → `Input.insertText`; if `keyEvents` per-char `Input.dispatchKeyEvent`; `pressEnter` → key event |
| `press` | `Input.dispatchKeyEvent` with modifiers |
| `scroll` | `Input.dispatchMouseEvent` wheel, or element box + `Input.dispatchScrollEvent` |
| `screenshot` | `Emulation.setDeviceMetricsOverride` (known DPR) → `Page.captureScreenshot({format:'png', captureBeyondViewport:fullPage})`, **height-capped** with `truncated`+`fullHeight` metadata (or scroll-stitch fallback) [RESOLVED — mv3 major screenshot] |
| `get_text`/`get_html` | `Runtime.evaluate` (CSP-bypassing path; `returnByValue:true`) |
| `eval` | `Runtime.evaluate({awaitPromise})`; `exceptionDetails` → `{ok:false,error}` (NOT a tool error) |
| `wait_for` | **poll `Runtime.evaluate`** (querySelector / textContains / gone) with deadline — never wait on a future lifecycle event [RESOLVED — mv3 blocker 2] |
| `download_file` | server-side CDP fetch (see §8); extension path only if explicitly allowed |

**Detach handling:** `chrome.debugger.onDetach` → null attach state, emit
`detached` event; next command re-attaches. **DevTools-open is terminal, not a
loop:** on attach failure, `chrome.debugger.getTargets()` checks for
`attached:true` by another client → return `DEVTOOLS_OPEN` ('close DevTools on
this tab') and do **not** retry. attach/detach are **single-flight serialized**
so `tab_select` churn can't race. `detach-all` on session end. [RESOLVED — mv3 major one-debugger-client]

**Helpers parity:** `extract_links`/`read_as_markdown`/`fill_form` run via the
**already-attached `Runtime.evaluate`** path (CSP-bypassing, parity with the CDP
backend) — **not** `chrome.scripting` MAIN-world (which CSP can block). `fill_form`
submit click goes through `Input.dispatch` (trusted event). [RESOLVED — mv3 minor CSP/manifest]

---

## 7. CdpExecutor Fallback

`src/executor/cdp-executor.ts` — Playwright `connectOverCDP(endpoint)` (attach)
or `launchPersistentContext(userDataDir)` (self-spawn). **Lifted from
`linkedin-mcp/src/driver/browser.ts`:**
- connect-once/reuse guard, **never `cdpBrowser.close()` in attach mode** (`doConnect` ~464–509).
- single-flight launch guard `this.launching` (~291–305).
- `launchWithLockRecovery` + `inspectProfileLock`/`clearProfileLocks`/`isChromiumProcess` (~318–361) — **must verify the lock owner is a Chromium before SIGKILL**; required because Claude Desktop SIGKILLs the npx child and orphans `SingletonLock`.
- `STEALTH_INIT_SCRIPT` + `--disable-blink-features=AutomationControlled` + pinned UA **only on the self-launch path** (never attach).
- `wirePage` default timeouts.
- `findLinkedInPage` **generalized to `resolveTab(tabId?|urlPattern?)`**: poll `context.pages()`, skip `file://`/`data://`/`devtools://`/`chrome://`/`about:blank`, match by stored guid or URL regex, else first content page. `contexts()[0]` holds ALL targets over CDP — `tabsList`/`tabSelect` filter non-content targets.

Decisions:
- **Ownership flag `launched`**: `dispose()` closes the context only when `launched===true`; attach mode drops refs only.
- **Do NOT set `PLAYWRIGHT_BROWSERS_PATH`** (rely on the postinstall cache; respect a pre-set override). Drop the Electron `useBundledBrowsersIfPackaged` branch.
- **Self-launch profile dir must NOT be the user's real Chrome profile** (`CHROME_MCP_USERDATA` || `~/.chrome-mcp/cdp-profile`) — it would conflict with the real Chrome the extension drives.
- `screenshot` → `page.screenshot({fullPage})` → base64; `eval` → `page.evaluate` wrapped so a page throw becomes `{ok:false}` not a transport-killing throw.
- **tabId stamping**: CDP guids are prefixed `cdp:<sessionId>:<guid>`; extension ids `ext:<sessionId>:<targetId>`. A handle whose prefix doesn't match the current backend/session → `STALE_TAB` ('call tabs_list again'). [RESOLVED — mv3 major tabId / integration]

**Selection** (recap §3): extension if responsive-on-ping, else CDP. `--prefer cdp` forces CDP even when an extension is connected (testing). `--no-cdp-fallback` disables the fallback entirely.

---

## 8. Security Model

**Threat model.** `chrome.debugger` grants **total** control of the attached
Chrome: read every cookie/DOM/localStorage of every logged-in site, inject JS,
download files. The localhost WS is reachable by **any local process** (a
malicious npm postinstall, a browser-spawned helper, any unsandboxed user
process). **Therefore: the 256-bit per-boot token is the entire boundary, and
prompt-injection-to-exfil via page content is a PRIMARY, not theoretical,
threat** (this tool feeds untrusted page text to an LLM that can call `eval`).

**Mitigations — every security blocker/major resolved:**

1. **One auth model, no alternatives.** Fresh 256-bit token **every boot**, never persisted/reused; atomic-0600 `handshake.json`; SHA-256-then-`timingSafeEqual` compare; the four other token/port/transport variants are **deleted from the spec** so they can't half-ship as dead paths. [RESOLVED — blocker 1, minor 7, minor 8]
2. **Loopback bind only** (`127.0.0.1`, never `0.0.0.0`). Defense-in-depth.
3. **Origin is NOT a security layer.** Documented as defense-in-depth against *browser-page* attackers only (a web page cannot forge a `chrome-extension://` Origin; a native process can). The token holds independently. We never relax token strength on Origin's account. Never reject a valid-token dev connection solely on Origin mismatch. [RESOLVED — blocker 2, mv3 major Origin]
4. **No `/connect` HTTP endpoint.** Token bootstrap is the **native-messaging trampoline** reading the 0600 file (the model/attacker can't read it), with a manual file-path-pairing fallback. No race-able network token vendor exists. [RESOLVED — blocker 3]
5. **Token never logged.** Never on stdout or stderr; only in the 0600 file (mode verified post-write, fail-closed). Any human-readable pairing artifact is also 0600 and short-lived. `policy.test.ts` asserts the token appears on neither stream. `logErr` redacts. [RESOLVED — major 5]
6. **Default-deny domain policy, ON by default, gating READS too.** `Policy { allowDomains: glob[]; allowEval; allowDownloads; allowAllTabs }`. Absent config → **SAFE DEFAULT**: navigate only to `about:blank` + already-open allowlisted tabs, **eval denied cross-domain, reads (`get_text`/`get_html`/`screenshot`/`eval`) denied outside the allowlist**, downloads off. `assertUrlAllowed(currentTabUrl, method)` runs SERVER-SIDE in **the executor dispatch (both backends)** before any attach/navigate/eval/read. The extension router does NOT re-check the policy (token is the sole bridge boundary); a mirrored extension-side gate is a planned hardening. `--unsafe-all-domains` (= `allowDomains:['*']`) is the loud-logged escape hatch. [RESOLVED — major 4]
7. **Safe-mode shipped in v1 (not "future").** Default disables `eval` and the entire mutating tool set; `--enable-mutations` / `--unsafe-enable-eval` opt in. `eval`'s effective target origin (the tab's current URL) is allowlist-checked before dispatch. [RESOLVED — major eval]
8. **Narrowed manifest:** no `<all_urls>`; `host_permissions:[]` + `optional_host_permissions` requested on demand after an explicit user action-click grant before first attach. [RESOLVED — major 4]
9. **Displacement is a security event:** superseding connects are logged loudly + surfaced in `chrome_status`; the active connection is pinned to the first `hello` ext id and won't be displaced by a different id without re-pair. [RESOLVED — minor 9]
10. **`download_file` is server-side CDP fetch into a dedicated, non-executable, server-owned dir.** `suggestedName` is sanitized (strip path separators, drop dangerous extensions or force `.download`), size-capped; **never writes into the user's real Downloads via the AI path by default.** Result `{path, backend, bytes, mimeType}` marks which filesystem `path` is on; the call resolves only on `complete`/`interrupted` (never on download-begin), no Save-As dialog. [RESOLVED — minor 10, mv3 minor download]
11. **Kill switch:** delete `handshake.json` + `SIGHUP` rotates the token and forces re-pair. **Ship load-unpacked only for v1** (`chrome.debugger` triggers heavy store review).

---

## 9. Build Plan

Each phase is a shippable slice with a verification slice that proves it. Order
is dependency-aware; the canonical contracts (`shared/protocol.ts`,
`executor/types.ts`, `security/policy.ts`) land first so nothing forks.

**Phase 0 — Contracts & skeleton.**
Build: `shared/protocol.ts`, `executor/types.ts`, `security/policy.ts`, `config.ts` (single port/token/policy surface), `package.json`/`tsconfig`, `postinstall.js`. *Verify:* `tsc` compiles; `policy.test.ts` proves default-deny + read-gating + glob; a unit test asserts no second copy of any protocol/port/token constant exists.

**Phase 1 — MCP server + StubExecutor (Chrome-free).**
Build: `mcp/server.ts` (clean-stdout `logErr`), `mcp/tools.ts` (26 defs+handlers, drift-check, `dispatchToolCall`), `validators.ts`, `envelopes.ts`, `helpers.ts`, `markdown-extract.ts`, `executor/manager.ts` wired to a `StubExecutor`. *Verify:* `tools.test.ts` — drift parity, `requireTarget` exactly-one-of, `McpToolError`→`isError`, screenshot→image block, `eval`-throw→`{ok:false}`, safe-mode blocks `eval`+mutations, policy denies cross-domain read. Runs in CI (`node --test`).

**Phase 2 — Bridge + auth + token-never-logged.**
Build: `bridge/server.ts`, `bridge/connection.ts`, `bridge/auth.ts` (per-boot token, atomic 0600, SHA-256 compare), `bridge/datadir.ts`. *Verify:* `bridge.test.ts` — correct token accepted; wrong token → 4401; missing/forged Origin in dev with valid token → still accepted (Origin not a gate); id X→reply X with 3 in flight; second valid client displaces first (+ event surfaced); deadline→`isError`; **token absent from stdout AND stderr**. CI-eligible (fake WS client).

**Phase 3 — ExtensionExecutor + CdpExecutor + selection.**
Build: `executor/extension-executor.ts`, `executor/cdp-executor.ts` (BrowserManager port + lock recovery + `resolveTab`), `executor/page-scripts.ts`. Manager `ensureReady` with ping-probe fall-through + single-flight. *Verify:* extend `tools.test.ts` with a fake bridge — late extension takes over from CDP; extension ping-fail falls to CDP without a 30s stall; `STALE_TAB` on cross-backend tabId.

**Phase 4 — MV3 extension.**
Build: `manifest.json`, `sw/background.ts` (top-level listeners, keepalive interval + alarm reconnect driver, re-hydrate), `sw/ws-client.ts`, `sw/router.ts` (never-throw, drift-assert, policy gate), `sw/cdp-executor.ts` (poll-based lifecycle, box-model resolution, DevTools-terminal), `sw/tabs.ts`, `options/*`, `nm/trampoline.ts`, `build-ext.mjs`. *Verify:* `extension-smoke.ts` — Playwright `--load-extension`, programmatic pair via trampoline-equivalent, `navigate(example.com)`→`get_text` contains "Example", and a >30s idle test proving keepalive keeps the socket alive then a kill test proving CDP fall-through. Headed; behind a display flag.

**Phase 5 — Helpers, download, full policy wiring, HITL.**
Build: server-side `extract_links`/`read_as_markdown`/`fill_form` over `Runtime.evaluate`; server-side CDP-fetch `download_file` with sanitized names/size cap; policy enforced at executor + router. *Verify:* `test/hitl/` (cloned harness, Executor handle) — read steps free; mutating steps (`download_file`, `fill_form+submit`, `eval`-side-effect) behind classification + `--include-mutating` + literal `yes` + `test-targets.json` allowlist. Human verdict gate; never CI.

**Phase 6 — Packaging & docs.**
Build: `files` whitelist incl. `extension-dist/`, `--print-pairing`/`--print-extension-path`, `.mcp.json` snippet, README (banner caveat, load-unpacked-only, policy/safe-mode defaults, kill switch). *Verify:* `npx chrome-mcp` from a packed tarball boots, prints the pairing file path (no token leak), and a fresh Chrome load-unpacked round-trips one navigate→get_text.

---

## 10. Open Questions & Remaining Risks

**Resolved-and-closed** (were open questions; now decided): token model (per-boot ephemeral, 0600, native-messaging trampoline); port (single `38017` default, ephemeral-0 supported via re-read-on-failure); helper home (server-side compose, only `download` on the wire); error enum (one `ExecutorErrorCode`); screenshot key (`dataBase64`); ref model (page-scoped, invalidated on navigation); safe-mode + read-gating (shipped, default-on); Origin (defense-in-depth only, not a gate).

**Remaining risks (accepted for v1):**
- **The yellow "is being debugged" banner** is permanent in v1 and a social-engineering footgun; accepted with `chrome.debugger`. Documented.
- **MV3 worker death gap:** between worker eviction and the next wake, the extension is briefly undriveable; mitigated by ping-probe fall-through to CDP and the keepalive loop, but the model may see one transient `isError`+retry. Tool descriptions instruct retry.
- **Native-messaging trampoline install step** is the one manual setup beyond `npx`; the manual file-path paste is the no-native fallback. Smoother one-click pairing is a v1.1 polish.
- **`networkidle`** is approximated by a bounded idle-window poll (no native CDP event); documented as best-effort, never able to wedge a call.
- **Local-code-execution attacker** who can already read the user's 0600 files has root-equivalent access to the user session; the token cannot defend against an attacker who already owns the filesystem. The policy allowlist still blocks blind exfil to arbitrary domains.
- **`captureBeyondViewport` very-tall pages**: capped + `truncated` flag; scroll-stitch is the v1.1 upgrade if full fidelity is needed.

**Genuinely open (decide before v1.1):**
- Multi-tab/multi-session concurrency (single global Executor + single attached tab today): does an agent need N tabs driven simultaneously? That breaks the singleton and requires per-cmd `tabId` everywhere on the wire.
- Web Store path: requires a `chrome.scripting`-only mode (no `chrome.debugger`) — a second executor backend behind the same interface.
- Whether `download` should ever use the extension `chrome.downloads` path (user Downloads dir) as an explicit opt-in, or remain server-fetch-only forever.
