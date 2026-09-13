# chrome-mcp

[![CI](https://github.com/Mehmoodqureshi/chrome-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Mehmoodqureshi/chrome-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40mehmoodqureshi%2Fchrome-mcp?label=npm)](https://www.npmjs.com/package/@mehmoodqureshi/chrome-mcp)
[![license](https://img.shields.io/npm/l/%40mehmoodqureshi%2Fchrome-mcp?label=license)](LICENSE)

**Let Claude use the Chrome you are already logged into.** Not a fresh
automated browser that greets every site as a stranger — *your* Chrome, with
your sessions, your cookies, your 2FA already done. If you can see a page in
your browser, your agent can read it, without logging in again and without
pasting credentials anywhere.

Most browser MCP servers launch their own Chromium and hand your agent a
signed-out window. chrome-mcp does the opposite: an MV3 extension dials into a
localhost WebSocket server and drives the browser you already have open, through
`chrome.scripting`/`chrome.tabs`. Works with Claude Code, Claude Desktop, and any
other MCP host.

Distributed as an `npx` CLI (the MCP server) plus a load-unpacked extension.

> **This build is extension-only.** It never launches or attaches a Chromium of
> its own, so **the extension is required, not optional** — without it, no tool
> can run. The CDP flags (`--cdp-fallback`, `--no-cdp-fallback`, `--cdp-endpoint`,
> `--prefer`) are still accepted for back-compat but are **ignored**.

> **Full design:** [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) — architecture, wire
> protocol, the complete tool surface, the extension manifest, the security
> model, and the phased build plan.

## Quickstart

### Up and running in one paste

Hand this to your AI agent (Claude Code, Cursor, Windsurf, anything MCP) and it
installs the server, wires it into the client, and walks you through the two
steps that must happen inside Chrome:

```text
Set up chrome-mcp on this machine by fetching and following
https://raw.githubusercontent.com/Mehmoodqureshi/chrome-mcp/main/SETUP.md
exactly, step by step. Work autonomously and verify each step.
```

Prefer to read before you run an agent on your machine? [`SETUP.md`](SETUP.md)
is the exact file the agent follows. The manual steps are below.

**1. Register the MCP server** with your host.

<details open>
<summary><b>Claude Code (terminal)</b> — one command, no config file to find</summary>

```bash
claude mcp add chrome-mcp -s user -- \
  npx -y @mehmoodqureshi/chrome-mcp \
  --allow-domain example.com --enable-mutations --persist-token
```

Everything **before** `--` belongs to Claude Code; everything **after** it is this
server's command and flags. Keep the `--` or `--allow-domain` gets read as a
Claude Code option.

`-s user` registers it for every project on your machine. Use `-s local` (the
default) for just the current project, or `-s project` to write a `.mcp.json`
your team can commit.

Check it came up with `claude mcp list`. After upgrading the server, reconnect it
with `/mcp` inside a session — no restart needed.

</details>

<details>
<summary><b>Claude Desktop</b> and other MCP hosts — JSON config</summary>

```jsonc
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/chrome-mcp",
               "--allow-domain", "example.com", "--enable-mutations",
               "--persist-token"]
    }
  }
}
```

</details>

By default everything is **deny-all** (no domains, no eval, no mutations). Grant
exactly what you need with `--allow-domain <glob>` (repeatable), `--enable-mutations`,
`--enable-downloads`, `--enable-uploads`, `--unsafe-enable-eval`, or `--unsafe-all-domains`.

> `--enable-uploads` permits `upload_file` (setting local file(s) on a page's file
> `<input>`). It is **off by default** because sending local files to a page is an
> exfiltration risk; it is also gated by the destination-domain allowlist. Pair it
> with `--uploads-dir <path>` to restrict uploads to files inside that directory
> (`..` traversal is blocked) — strongly recommended for unattended use.

**Pair once, never again.** Both examples above include `--persist-token`, which
is what makes the pairing survive a restart — drop it if you'd rather have the
stricter default described next.

Without `--persist-token` a fresh token is minted every boot (the secure
default), which means re-pairing the extension on each restart. With it, the
token is stored 0600 at `~/.chrome-mcp/token` and reused; the extension's
keepalive auto-reconnects with no manual step. `CHROME_MCP_TOKEN` pins the token
explicitly (and is never written to disk).

**2. Load the extension** — **required**; the server can drive nothing without it.

The extension ships prebuilt inside the npm package, and every time the server
boots it copies it to a plain folder right under your home directory:

```
~/chrome-mcp-extension          (macOS / Linux)
%USERPROFILE%\chrome-mcp-extension   (Windows)
```

So after step 1 has started the server once (restart your client, or `/mcp` in
Claude Code), the folder is already there. To create it without a client, or
to print the exact path:

```bash
npx -y @mehmoodqureshi/chrome-mcp --extension-path
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
pick `chrome-mcp-extension` in your home folder. After upgrading the package the
server refreshes the files on its next boot and the extension reloads itself
within 30 seconds; nothing to click. `CHROME_MCP_EXTENSION_DIR` moves the
folder somewhere else. (Working from a git clone instead? Run
`npm install && npm run build:ext` first — `extension-dist/` is gitignored, and
the server mirrors it to the same home folder.)

**3. Pair it — usually nothing to do.** Every time the server boots it writes
`pairing.json` (mode 0600, never shipped in the tarball) into the very
`chrome-mcp-extension` folder you just loaded. The extension reads that file
from its own folder on startup and pairs itself, so the toolbar badge turns
green with no token to paste. Load the extension before the server has ever
run? It re-checks every 30 seconds and pairs as soon as the file appears.

**Where to see the badge:** it sits on the extension's icon in Chrome's
toolbar, not on the `chrome://extensions` page. Chrome hides new extensions
behind the puzzle-piece button at the right of the address bar, so click that,
find **MCP Extension for Chrome**, and click the pin next to it once; the icon then
stays in the toolbar. Hover it for the status in words.

| Badge | Meaning |
|---|---|
| green dot | paired and connected |
| yellow dots | connecting |
| grey circle | not paired yet (no server has run, or no pairing file) |
| red exclamation mark | token rejected; the server rotated it, re-pairs by itself in a moment |

Manual fallback (a copied folder, a read-only home): run
`npx -y @mehmoodqureshi/chrome-mcp --print-pairing`, open the extension's
**Options** page, and paste the `port` + `token` from
`~/.chrome-mcp/handshake.json`. Values saved there take precedence over the
bundled file.

### Running more than one session

The extension dials exactly **one** bridge port, so only one chrome-mcp can drive
your Chrome at a time — but every MCP host session (each Claude tab/window)
spawns its own server. With a pinned `--port`, the newest session **takes the
port over**: it reads the owning pid from `handshake.json`, confirms that process
really is a chrome-mcp, and stops it. Newest tab wins; the older session's browser
tools go quiet until it reconnects. Nothing that isn't a verified chrome-mcp is
ever touched — a port held by some other program is reported, never killed.

Two servers can only run side by side if each has its own port **and** its own
paired extension — i.e. a separate Chrome profile running its own copy of the
extension, pointed at the other port (`--port 9223`). A single Chrome pairs to one
server at a time, so a second server with no extension of its own can drive
nothing.

One server can, however, serve **several browsers at once**: connections are
routed by profile key (`--profile <name>`, matching the profile set in the
extension's Options), so each paired Chrome gets its own routing slot.

Without `--port`, each server binds an ephemeral port (no conflict ever), but the
port changes every boot — so you'd re-pair the extension each time. Pin `--port`
plus `--persist-token` for a pair-once setup.

### Windows

WSL2 is **not** required — native Windows works. One config change is, though:
on Windows `npx` is `npx.cmd`, a batch shim, and MCP hosts spawn the server
without a shell, which cannot execute a `.cmd`. So `"command": "npx"` fails to
start. Wrap it in `cmd /c`:

```jsonc
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@mehmoodqureshi/chrome-mcp",
               "--allow-domain", "example.com", "--enable-mutations",
               "--persist-token"]
    }
  }
}
```

Or from Claude Code: `claude mcp add chrome-mcp -- cmd /c npx -y @mehmoodqureshi/chrome-mcp --allow-domain example.com`

Everything else is the same — load `%USERPROFILE%\chrome-mcp-extension` and pair
as above.

The tools cover tabs, navigation, interaction (`click`/`type`/`press`/`hover`/
`scroll`/`select_option`), reads (`get_text`/`get_html`/`screenshot`/`eval`/`wait_for`),
an accessibility `snapshot` (interactive elements with stable `ref`s the model can
target instead of guessing CSS selectors), session access (`get_cookies`/`storage`),
helpers (`extract_links`/`read_as_markdown`/`fill_form`/`download_file`/`upload_file`),
and `chrome_status`. `upload_file` sets local file(s) on a file `<input>` without the
OS dialog (requires `--enable-uploads`).

`click`/`type` accept `trusted: true` for real OS-level input (works on
React/Vue controlled inputs); interactions auto-wait for the target to appear.

### Driving several tabs at once — `batch`

`batch` runs many tool calls in **one** request — `parallel` (default) or
`serial` (with optional `stopOnError`). Each sub-op goes through the **same**
policy gate, rate limit, and error handling as a direct call (no bypass,
no nesting). Use it to fan work out across tabs:

```jsonc
// open three product pages (background, so they don't fight for focus)…
{ "name": "batch", "arguments": { "ops": [
  { "tool": "tab_new", "args": { "url": "https://a.example/p" } },
  { "tool": "tab_new", "args": { "url": "https://b.example/p" } },
  { "tool": "tab_new", "args": { "url": "https://c.example/p" } }
]}}

// …then read them all at once (wall-clock ≈ the slowest one, not the sum)
{ "name": "batch", "arguments": { "ops": [
  { "tool": "get_text", "args": { "tabId": "<a tabId>" } },
  { "tool": "get_text", "args": { "tabId": "<b tabId>" } },
  { "tool": "get_text", "args": { "tabId": "<c tabId>" } }
]}}
```

In `parallel` mode, tab-scoped ops **must** pass an explicit `tabId` — the
active-tab default is unsafe under concurrency, so it's rejected rather than
silently mis-routed. (`tab_new`, `tabs_list`, `chrome_status` are exempt.)

> **`tab_new` focuses the new tab by default** (so "open X" behaves like opening
> a link, instead of replacing your current page — use `tab_new`, not
> `navigate`, to open without losing the current tab). Pass `active: false` to
> open in the background; parallel batches do this automatically.

### Reaching into iframes and shadow roots

A selector that "should" match but doesn't almost always means the element is
somewhere your selector cannot reach: inside an `<iframe>` (checkout widgets,
OAuth consent screens, embedded editors) or inside a web component's shadow root.

Shadow roots are handled for you — every selector and every `ref` now resolves
through open shadow roots, so anything `snapshot` shows you is something you can
click. (It used to show you elements no click could reach: the snapshot walked
shadow roots, the actions did not.)

Frames are opt-in, because reaching into one is a decision:

```jsonc
frames_list {}                                  // what frames exist, and their URLs
click { "selector": "#pay", "allFrames": true } // find it in whichever frame has it
get_text { "frameId": 7 }                       // pin one frame
```

Every frame is authorized against **its own** URL before anything runs in it, so
an allowlisted page embedding a third-party iframe does not become a way to read
that third party. Frames whose origin isn't on your allowlist are skipped.

### Seeing why a page broke — `console_logs`, `network_log`, `dialogs`

Reading the DOM tells you what a page looks like after it failed, not why. With
`--enable-observers`, an in-page hook records console output, uncaught errors,
and `fetch`/`XMLHttpRequest` traffic, and intercepts native dialogs:

```jsonc
console_logs { "level": "error" }        // the exception the page swallowed
network_log  { "failedOnly": true }      // the 500 behind the blank screen
dialogs      { "policy": "accept" }      // answer confirm() with true from here on
```

It is **off by default and deliberately so**: the hook patches `console`,
`fetch`, `XMLHttpRequest` and the dialog functions on every allowlisted page in
your real browser. When it's on, it is registered only for the domains on your
allowlist, at document_start (so it catches load-time failures), and nothing it
records leaves the page until a tool call reads it — through the same gate as any
other page read.

Dialog interception is also a fix, not just an observation: `alert`/`confirm`/
`beforeunload` block the renderer, so a click that opened one used to hang every
injected script until the command timed out and reported `TIMEOUT` with nothing
to point at. With observers on, the dialog is answered (`dismiss` by default:
confirm → false, prompt → null) and recorded.

> **What `network_log` sees:** the requests page code makes — `fetch` and
> `XMLHttpRequest`, with method, URL, status and duration — plus Resource Timing
> entries (scripts, images, styles) when you ask for them. Not the document
> request, redirects, or headers. That is the cost of not holding a debugger
> session open on your browser.

### Only what changed — `snapshot { diff: true }`

A snapshot is the most expensive read in the tool surface, and the loop that uses
it most (snapshot → click → snapshot) re-sends a page that is mostly identical
every time. Ask for the delta instead:

```jsonc
snapshot { "diff": true }                       // added / removed / changed only
click { "selector": "#save", "snapshotAfter": true }   // what the click changed
```

Nodes are matched across snapshots by role + accessible name, not by `ref` —
refs renumber in document order on every snapshot, so diffing on them would
report an unchanged button as removed-and-re-added the moment anything above it
appears.

### Targeting by role and name

Actions accept a locator instead of a CSS selector, so you don't need a snapshot
first just to learn a ref:

```jsonc
click { "role": "button", "name": "Sign in" }
type  { "role": "textbox", "name": "Email", "text": "a@b.com" }
```

Resolution is server-side and refuses to guess: an ambiguous locator fails with
the candidates listed rather than acting on the first one (pass `nth` to pick).

### Printing — `print_pdf`

```jsonc
print_pdf { "landscape": true }
```

Renders through Chrome's own print pipeline and saves to the task's `results/`
dir, returning the path and size. The bytes themselves are never returned — a
PDF is megabytes of base64 no model can read.

## Status

v0.5.0 — **safe multi-tab concurrency.** Adds the `batch` fan-out tool, makes
parallel tab automation race-free (explicit-`tabId` guard; per-tab
`chrome.debugger` serialization; collision-free `tab_new`), captures screenshots
via `chrome.debugger` (a specific tab without stealing focus — plus true
full-page and element capture), and focuses newly opened tabs by default. 111
automated tests + a gated headed extension smoke.

v0.2.0 — all six build phases complete and green. End-to-end working:
`npx chrome-mcp` ⇄ bridge ⇄ extension ⇄ your real Chrome, with a Playwright CDP
fallback. v0.2 adds the accessibility `snapshot` + element refs, auto-wait,
cookies/storage/`select_option`, trusted input (`chrome.debugger`), a toolbar
status badge, and a stable pairing token (`--persist-token`).

- [x] **Phase 0 — Contracts & skeleton:** `shared/protocol.ts` (wire contract),
      `src/executor/types.ts` (Executor interface), `src/security/policy.ts`
      (default-deny policy + capability gates), `src/config.ts` (CLI/env/policy
      resolution), build + test harness.
- [x] **Phase 1 — MCP server + StubExecutor:** `mcp/server.ts` (clean-stdout
      stdio), `mcp/tools.ts` (28-tool catalog + never-throw dispatch +
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
chrome-mcp --enable-observers              # console/network/dialog capture (patches page globals)
chrome-mcp --redact                        # scrub secret-shaped strings out of page reads
```

**What comes back is gated too.** The allowlist decides which pages may be read;
it says nothing about what is on them. A logged-in page routinely renders a
session token into a script tag or an API key onto a settings screen.

- **Password field values are always suppressed** — in `get_html`, and in
  `snapshot`, where the field still appears (so you can type into it) flagged
  `secret: true` with no value. No flag, no opt-in: nobody wants those characters.
- `--redact` additionally scrubs secret-shaped strings — JWTs, AWS/GitHub/Slack/
  Google keys, `Bearer` headers, private-key blocks — out of `get_text`,
  `get_html`, `read_as_markdown` and `eval`. It is opt-in because a pattern will
  eventually fire on something you actually wanted. `--redact-pattern <regex>`
  adds your own (and implies `--redact`); an invalid one fails at startup rather
  than silently never matching.
- Redaction runs **before** the output cap, so a truncated read cannot leak what
  a full one would have hidden.

Every call is recorded to the task's `history.jsonl` with the URL it touched, the
policy verdict (`allowed`/`denied`), how long it took, how many bytes came back,
and how many secrets were scrubbed — so "what did the agent do in my browser" has
an answer after the fact.

The per-boot 256-bit token in `~/.chrome-mcp/handshake.json` (mode 0600) is the
only trust boundary; it is never written to stdout/stderr. On POSIX the mode is
re-verified after every write and the server **fails closed** if the file ends up
group/other-accessible. Windows has no such bits — `chmod` there only toggles the
read-only attribute — so the check is skipped and the token's confidentiality
rests on the per-user ACL of `%USERPROFILE%\.chrome-mcp`.

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
`chrome://extensions` → **Load unpacked** → select `~/chrome-mcp-extension`, the
mirror the server refreshes from `extension-dist/` on every boot (loading
`extension-dist/` directly also works). It pairs itself from the `pairing.json`
the server writes into that folder; the **Options** page paste of `port` +
`token` from `~/.chrome-mcp/handshake.json` (run
`npx -y @mehmoodqureshi/chrome-mcp --print-pairing` to get the path) is only
the fallback.

> **Reads/interaction use `chrome.scripting`/`chrome.tabs`** — no "is being
> debugged" banner, CSP-safe reads (isolated world), testable under Playwright.
> `chrome.debugger` is used only where it's needed and worth it: `trusted: true`
> input (real OS-level events on React/Vue inputs) and `screenshot` (captures a
> specific tab **without** activating it — safe under parallel `batch` — with
> true full-page and element capture). Those ops briefly show the debug banner
> while attached.
