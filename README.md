# chrome-mcp

Drive a **real Chrome browser** from Claude (or any MCP host). One pluggable
`Executor` interface, two backends:

- **Extension (primary):** an MV3 extension drives your real Chrome — real
  logins, real cookies — via `chrome.scripting`/`chrome.tabs`. The CLI runs a
  localhost WebSocket server; the extension dials in.
- **CDP fallback:** when no extension is paired, the CLI launches/attaches a
  Playwright-driven Chromium for scripted/headless use.

Distributed as an `npx` CLI (the MCP server) plus a load-unpacked extension.

> **Full design:** [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) — architecture, wire
> protocol, the complete tool surface, the extension manifest, the security
> model, and the phased build plan.

## Quickstart

**1. Register the MCP server** with your host (e.g. Claude Desktop / Code):

```jsonc
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/chrome-mcp", "--allow-domain", "example.com", "--enable-mutations"]
    }
  }
}
```

By default everything is **deny-all** (no domains, no eval, no mutations). Grant
exactly what you need with `--allow-domain <glob>` (repeatable), `--enable-mutations`,
`--enable-downloads`, `--unsafe-enable-eval`, or `--unsafe-all-domains`.

**Drive only your real Chrome (recommended for the extension).** Add
`--no-cdp-fallback` so the server never launches a separate Chromium, and
`--persist-token` so the pairing token survives restarts — **pair once, never
again**:

```jsonc
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/chrome-mcp",
               "--allow-domain", "example.com", "--enable-mutations",
               "--no-cdp-fallback", "--persist-token"]
    }
  }
}
```

Without `--persist-token` a fresh token is minted every boot (the secure
default), which means re-pairing the extension on each restart. With it, the
token is stored 0600 at `~/.chrome-mcp/token` and reused; the extension's
keepalive auto-reconnects with no manual step. `CHROME_MCP_TOKEN` pins the token
explicitly (and is never written to disk).

**2. Load the extension** (to drive your *real* Chrome): build it, then
`chrome://extensions` → enable Developer mode → **Load unpacked** → select
`extension-dist/`.

**3. Pair it:** run `npx chrome-mcp --print-pairing` to write the handshake and
print its path, open the extension's **Options** page, and paste the `port` +
`token` from `~/.chrome-mcp/handshake.json`. (Without the extension, the CLI
falls back to a Playwright-driven Chromium automatically.)

The tools cover tabs, navigation, interaction (`click`/`type`/`press`/`hover`/
`scroll`/`select_option`), reads (`get_text`/`get_html`/`screenshot`/`eval`/`wait_for`),
an accessibility `snapshot` (interactive elements with stable `ref`s the model can
target instead of guessing CSS selectors), session access (`get_cookies`/`storage`),
helpers (`extract_links`/`read_as_markdown`/`fill_form`/`download_file`), and
`chrome_status`.

`click`/`type` accept `trusted: true` for real OS-level input (works on
React/Vue controlled inputs); interactions auto-wait for the target to appear.

## Status

v0.2.0 — all six build phases complete and green (57 automated tests + a gated
headed extension smoke). End-to-end working: `npx chrome-mcp` ⇄ bridge ⇄
extension ⇄ your real Chrome, with a Playwright CDP fallback. v0.2 adds the
accessibility `snapshot` + element refs, auto-wait, cookies/storage/`select_option`,
trusted input (`chrome.debugger`), a toolbar status badge, and a stable pairing
token (`--persist-token`).

- [x] **Phase 0 — Contracts & skeleton:** `shared/protocol.ts` (wire contract),
      `src/executor/types.ts` (Executor interface), `src/security/policy.ts`
      (default-deny policy + capability gates), `src/config.ts` (CLI/env/policy
      resolution), build + test harness.
- [x] **Phase 1 — MCP server + StubExecutor:** `mcp/server.ts` (clean-stdout
      stdio), `mcp/tools.ts` (23-tool catalog + never-throw dispatch +
      drift-check), validators/envelopes/helpers, `ExecutorManager` +
      `StubExecutor`, `cli.ts`. Point an MCP host at `node dist/src/cli.js` today.
- [x] **Phase 2 — WebSocket bridge + auth:** `bridge/server.ts` (loopback WS,
      hello-token gate, welcome/unauthorized, displacement), `bridge/auth.ts`
      (per-boot 256-bit token, atomic-0600 handshake, SHA-256 `timingSafeEqual`),
      `bridge/connection.ts` (id-correlation, method-aware timeouts, backpressure,
      reject-all-on-close, heartbeat).
- [x] **Phase 3 — ExtensionExecutor + CdpExecutor + selection:**
      `executor/extension-executor.ts` (Executor over the bridge),
      `executor/cdp-executor.ts` (Playwright connect/launch + lock recovery +
      tab resolution), `executor/select.ts` (extension-if-ping-responsive else
      CDP). CLI now starts the bridge, writes the 0600 handshake, and serves a
      real backend. Adds `playwright`.
- [x] **Phase 4 — MV3 extension:** `extension/` — `manifest.json`,
      `sw/ws-client.ts` (dial + hello/welcome + pong), `sw/executor.ts`
      (chrome.scripting/chrome.tabs command impls), `sw/router.ts` (never-throw +
      drift), `sw/background.ts` (top-level listeners + 25s keepalive/reconnect),
      options page (manual pairing), esbuild build → `extension-dist/`. Verified
      by a live `--load-extension` smoke (pair → navigate → get_text). Adds
      `esbuild` + `@types/chrome`.
- [x] **Phase 5 — Helpers, downloads, HITL:** hardened `download_file`
      (`shared/download.ts` — path-traversal/dangerous-ext sanitize + size cap,
      wired into both backends), richer `read_as_markdown`, and a human-in-the-loop
      harness (`hitl/` — `npm run test:hitl [-- --include-mutating]`) with pure,
      unit-tested gating. 50 automated tests.
- [x] **Phase 6 — Packaging & docs:** `files` whitelist (ships `dist/src`,
      `dist/shared`, `extension-dist`, LICENSE, blueprint — not source/tests),
      `prepack` build, `bin`, quickstart + `.mcp.json` snippet. Verified by a
      tarball install smoke (`npm pack` → install → MCP `tools/list`).

## Security posture (default)

**Deny-all safe mode.** With no policy configured: empty domain allowlist,
`eval` off, downloads off, mutating tools off. Opt in explicitly:

```
chrome-mcp --allow-domain example.com --enable-mutations
chrome-mcp --policy ./policy.json          # see policy.example.json
chrome-mcp --unsafe-all-domains            # loud footgun
```

The per-boot 256-bit token in `~/.chrome-mcp/handshake.json` (mode 0600) is the
only trust boundary; it is never written to stdout/stderr.

## Develop

```
npm install
npm run typecheck       # server/test sources
npm run typecheck:ext   # extension sources (@types/chrome)
npm run build:ext       # bundle the extension → extension-dist/
npm test                # builds, then runs node --test on dist/test
RUN_EXT_SMOKE=1 node --test dist/test/extension-smoke.test.js   # live, headed
```

## The extension

`extension/` builds (esbuild) to `extension-dist/`, loaded via
`chrome://extensions` → **Load unpacked** → select `extension-dist/`. Pair it
from the extension's **Options** page using the `port` + `token` from
`~/.chrome-mcp/handshake.json` (run `npx chrome-mcp --print-pairing` to get the
path).

> **v1 uses `chrome.scripting`/`chrome.tabs`, not `chrome.debugger`.** No
> "is being debugged" banner, CSP-safe reads (isolated world), and it's testable
> under Playwright. Trade-off: clicks/typing are synthetic DOM events, not
> OS-level trusted input, and `screenshot` is visible-tab only. A trusted-input
> `chrome.debugger` backend is a documented future upgrade (BLUEPRINT §10).
