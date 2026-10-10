## Unreleased

- feat: **one-click Connect, for every install.** The server registers a native
  messaging helper with Chrome, Brave, Edge, Chromium, Arc and Vivaldi on each
  start (the registry on Windows; `--no-native-host` turns it off). The
  extension's Connect button, in the popup and in Settings (which a fresh
  install now opens), asks it for the port, token and the server's profile and
  pairs. Chrome only lets our extension id reach it. The permission is optional,
  so existing installs are untouched until someone clicks. After a token change
  the extension refetches it by itself.
- feat: **unpacked builds share the store id.** They carry the store's public
  key (the store zip strips it, see `pack-ext.mjs`), so the helper allows one
  id, and the extension reports its install type so the server can still tell
  store copies from unpacked ones.
- feat: **unpacked users are moved to the store copy.** The popup shows an
  "automatic updates" banner (and "update available" when behind the bundled
  build), `chrome_status` reports the extension's version and source with a tip,
  and telemetry gains `ext_version` / `ext_source`.
- fix: **every session refreshes the unpacked extension folder**, not just the
  first, and **never with an older build**, so a server left running for days
  can no longer pin users to old files.

- chore: **user-facing text says MCP Browser Extension, not chrome-mcp.** The
  extension's Options page, popup and store description, the server's startup
  instructions, pairing steps, error messages, first-run telemetry notice and
  auto-update notice, the MCP server name (`mcp-browser-extension`, also the
  PostHog MCP Analytics server label), and the README, SETUP, privacy policy and
  store notes. Unchanged on purpose: the npm package `@mehmoodqureshi/chrome-mcp`,
  the `chrome-mcp` command, the `"chrome-mcp"` key in MCP configs, the
  `~/.chrome-mcp` data folder and the repo, so every existing setup keeps working.

## 0.9.20 - 2026-10-10

Server-only; the extension stays at 0.9.19.

- feat: **fuller PostHog MCP Analytics, still nothing about what agents do.**
  Sessions now end after 30 idle minutes (PostHog's own rule), so the Sessions
  view shows real stretches of work. A connecting client is recorded as
  `$mcp_initialize` (client, server, protocol revision) with a `$mcp_tools_list`
  of the tool names offered, which shows tools agents never call. Each
  `$mcp_tool_call` adds the protocol revision, the tool's group
  (`$mcp_tool_category`), and the model when the client names it in its own
  request metadata (Codex does). Intent, missing-capability reports,
  conversation ids, arguments, results, messages and exceptions stay off: they
  would carry agent text, URLs or file paths, or add fields to every tool.

## 0.9.19 - 2026-10-10

A popup on the toolbar icon, and PostHog MCP Analytics. The extension moves to
0.9.19.

- feat (extension): **clicking the toolbar icon opens a popup**, anchored to the
  icon, instead of a whole Options tab. It shows whether this browser is paired,
  whether the agent may use the site you are on (with a one-click Allow), the
  sites it was just refused (Allow or Dismiss), the allowed sites (Remove for
  those added from the extension), and the tab-outline switch. Light and dark
  themes; each site gets a coloured letter badge rather than a favicon fetched
  from a third party. Settings opens the Options page for pairing.
- feat: **PostHog MCP Analytics.** Each tool call is also sent as a
  `$mcp_tool_call` event, so PostHog's MCP Analytics dashboard shows tools,
  latency, failures and clients. Only the tool name, duration, failure flag and
  error code, client name and version, and a random session id: never
  `$mcp_parameters`, `$mcp_response` or error messages. Batched every 15 s;
  telemetry opt-outs turn it off too.
- docs: blocked-site messages and pairing steps point to the toolbar popup.

## 0.9.18 - 2026-10-10

The agent stops touching the tab you are working in. The extension moves to
0.9.18.

- feat: **the agent works in its own tab.** Each session keeps an agent's tab:
  the one it last opened or picked. Calls without a `tabId` go there instead of
  to whatever tab you are looking at. `tab_new` now opens in the background by
  default (`active: true` brings it forward), and `navigate` with no tab of its
  own opens one instead of replacing your page. Before the agent opens a tab,
  reads still see your active tab, so "look at this page" works; to act on your
  page it passes that tab's id. If you close the agent's tab, calls fall back to
  the active tab. `chrome_status` reports `agentTab`, and the server
  instructions tell the agent all this.
- fix (extension): **`tab_new` only reuses blank tabs chrome-mcp opened.** It
  used to take over any blank tab, including a New Tab page you had just opened
  to type into. The tabs it opened are remembered in session storage.

## 0.9.17 - 2026-10-10

A server-only fix; the extension stays at 0.9.16.

- fix: **a call right after a background `tab_new` no longer fails with
  TAB_NOT_FOUND.** Chrome leaves a background tab out of the tab list until its
  navigation commits, so the policy gate could not place it and refused the next
  call aimed at it, most often from a second Claude session sharing the browser
  (it has no URL cache to fall back on). The server now remembers tabs it just
  opened and, for those only, waits up to 5 s for the URL. Any other unknown tab
  still fails at once. Found while automating the website's screenshots.

## 0.9.16 - 2026-10-10

Fixes for the problems new installs hit most, from the usage data: Chrome never
pairing (the top error, 13 installs), sites blocked with no way to allow them
short of a restart (7 installs), reads failing right after a click, and most
sessions running weeks-old versions. The extension moves to 0.9.16.

- feat: **pairing help that names what went wrong.** `chrome_status` now reports
  a `pairState` (`ok`, `no_extension`, `token_mismatch`, `version_mismatch`,
  `profile_mismatch`) and, when nothing is paired, a `setup` list with the exact
  steps for that case: the Web Store link, the port, where the token is, or
  which `profile_use` to call. Every NO_BACKEND error carries the same steps,
  and the server's MCP instructions tell the agent to relay them instead of
  retrying. A rejected token is remembered, so a stale token is no longer
  reported as "no browser".
- feat: **allow a site from the extension, no restart.** A refused site shows a
  `?` on the toolbar icon; the Options page (the icon now opens it) lists it with
  an Allow button and takes any other site too. The hub widens the live policy,
  saves it to `allowed-sites.json`, and pushes it to every paired browser and
  peer session. The agent cannot approve a site for itself: the extension
  refuses every command aimed at its own pages. `--no-site-grants` turns this
  off. The POLICY_DENIED message now points to the Allow button.
- feat: **reads wait for their element.** `get_text`, `get_html` and
  `screenshot` with a selector wait up to 1.5 s for it to render (click and type
  already waited 5 s), which covers the click-then-read race behind most
  SELECTOR_NOT_FOUND errors. When an element is still missing, the error now
  lists similar selectors that are on the page.
- feat: **every install stays on the latest release.** npx reuses the copy it
  cached first, so most sessions ran versions weeks old. An installed copy now
  checks npm at startup (1.5 s timeout) and, when a newer release exists, hands
  off to `npx -y @mehmoodqureshi/chrome-mcp@<latest>` with the same arguments
  and stdio passed straight through. A git checkout, offline start or failed
  spawn runs the current copy; `--no-auto-update` or `CHROME_MCP_AUTO_UPDATE=0`
  turns it off. Setup snippets in the README, SETUP and the extension's Options
  page now say `@latest` too.
- fix: **sessions killed without a clean exit now shut down.** Some Windows hosts
  kill the launcher without closing stdin, leaving the server holding the port.
  It now notices when its parent process is gone or stdout breaks.
- telemetry: the first usage summary is sent a minute after the first call
  instead of at the first 10-minute tick, so short sessions are counted, and a
  `pair_check` event a minute after startup records the pair state above. No new
  personal data: still counts and fixed codes only.

## 0.9.15 - 2026-10-09

The extension asks for one permission fewer. No behaviour changes. The
extension moves to 0.9.15.

- chore: **the extension no longer requests `activeTab`.** It already holds
  host access to all sites (narrowed at run time by the server's domain
  allowlist), which covers everything `activeTab` granted; finding the tab you
  are looking at only needs `tabs`. Checked in a real Chrome: screenshots of
  the front tab and of a background tab, reading, snapshots and opening tabs
  all work without it.
- docs: the Chrome Web Store permission justifications in `docs/WEBSTORE.md`
  now cover the tab outline (`scripting`) and its setting (`storage`).

## 0.9.14 - 2026-10-09

The extension is now called MCP Browser Extension, and the project site moved
to https://mcp-browser-extension.vercel.app. No behaviour changes. The
extension moves to 0.9.14.

- chore: **the extension is renamed MCP Browser Extension** (was "MCP
  Extension for Chrome"), in its manifest, toolbar tooltips and Options page
  title. The Chrome Web Store item id is unchanged, so existing installs and
  store links keep working.
- docs: the site address is now https://mcp-browser-extension.vercel.app in
  `package.json`, `server.json`, the extension's homepage link and the store
  notes. The old chrome-mcp-omega.vercel.app address redirects there.
- docs: the `--tools` section of the README now reflects the 40-tool catalog:
  28 KB (about 7.1k tokens) for the full list, and a 78% cut for the
  seven-tool example.

## 0.9.13 - 2026-09-26

You can now see which tabs the agent is working in, and screenshots no longer
come back stale. The extension moves to 0.9.13.

- feat: **a border marks every tab chrome-mcp is working in.** It takes the
  site's own theme colour when that stands out from the page, and is blue
  otherwise (a lighter blue on dark pages). It is drawn with a user stylesheet,
  so `get_html`, `get_text` and `snapshot` never see it, and it is taken down
  for screenshots and PDFs. It follows the tab to each new page, goes away when
  the tab leaves the allowed sites or the server disconnects, and can be turned
  off on the extension's Options page ("Outline the tabs chrome-mcp is working
  in").
- fix: **screenshots always render a fresh frame.** A plain viewport capture
  of the tab in front returned the frame last shown on screen, which could
  predate a change made just before the call and sometimes left a grey strip at
  the bottom. Viewport captures now ask Chrome to paint the page for the shot.
- docs: a README section on using Claude in your signed-in Chrome (Gmail,
  GitHub, dashboards), and Chrome Web Store links in the intro and install
  steps.
- 8 new tests (329 total, 2 skipped).

## 0.9.12 - 2026-09-24

Two fixes for running more than one chrome-mcp, and for long forms. The
extension moves to 0.9.12 (the Web Store still carries the older build).

- fix: **a second chrome-mcp no longer steals the extension's pairing.** Any
  server that owned its own port wrote `~/chrome-mcp-extension/pairing.json`,
  so a second one started with its own `CHROME_MCP_DATA` or
  `CHROME_MCP_WS_PORT` re-pointed the user's extension at itself and the first
  server lost its browser. A hub now leaves the file alone when it names a
  different port that is still listening, and logs that it did. A file naming
  its own port (failover), a dead port, or no file at all is still written.
- fix: **`fill_form` has time for long forms.** One flat 60 s budget covered
  the whole batch, while every field may wait 5 s for its element, so a long
  form timed out server-side while the extension kept typing. The wire timeout
  now grows with the field count (10 s + 6 s per field, 60 s to 10 min), and
  the extension stops starting fields once that deadline passes, returning a
  `TIMEOUT` that says how many landed, instead of writing into the page after
  the caller was told it failed.
- 4 new tests (321 total, 2 skipped).

## 0.9.11 - 2026-09-23

Metadata only; no code changed and the extension stays at 0.9.8.

- chore: **listed on the official MCP registry** as
  `io.github.Mehmoodqureshi/chrome-mcp`. `package.json` gains the `mcpName`
  field the registry uses to prove the npm package belongs to this repo, and a
  new `server.json` holds the registry entry. Its `version` fields must move
  with `package.json` on every release that is re-published to the registry.

## 0.9.10 - 2026-09-23

The model no longer reads tools it can never use, and still knows how to
switch them on.

- perf: **tools whose capability is off are left out of `tools/list`.** The
  catalog is re-sent to the model on every turn, and a tool the policy has
  switched off can only ever answer `POLICY_DENIED`. Under the default policy
  that is 20 of 40 tools. Each tool now declares the wire method it is gated on
  (`TOOL_GATE`), the catalog filter asks the same `evaluatePolicy` the gate
  runs, and startup fails if a new tool forgets to declare one. A blocked
  *domain* never hides a tool, since another tab may be allowlisted. The server
  logs which tools it dropped and the flag that brings them back.
- feat: **`chrome_status` names what is switched off.** With `navigate` hidden,
  the model could no longer learn from a `POLICY_DENIED` that
  `--enable-mutations` exists, and would tell the user it cannot browse.
  `chrome_status` now returns `disabledCapabilities` (each capability, its flag
  and the tools it hid) plus a `capabilityHint`, so the model can point the
  user at the one flag to add. Both fields are omitted when nothing is off.
- 13 new tests (317 total, 2 skipped).

## 0.9.9 - 2026-09-22

Documentation only; no code changed and the extension is untouched, so it stays
at 0.9.8.

- docs: the install steps now point at the **Chrome Web Store listing** as the
  one-click route beside the unpacked folder, in both the README and `SETUP.md`.
  Both note that the listed build passes review separately and can trail the npm
  package by a version, which capability negotiation turns into missing features
  rather than a break.

## 0.9.8 - 2026-09-22

Forms fill in one round-trip instead of one per field, without loosening the
policy gate that protects what gets typed where.

- feat: **`fill_form` writes every field in a single wire command.** A ten-field
  form cost ten server-to-extension round-trips; it now costs one, and the page
  gets one chance to re-render mid-fill instead of ten. The `{filled, submitted}`
  contract is unchanged, and `submitSelector` still clicks as a separate step
  after the fills land.
- **Falls back automatically.** The extension advertises a `fill-form`
  capability in its handshake; a server paired with an older extension (or
  driving CDP) goes back to one write per field, so upgrading either side alone
  is safe.
- **The policy gate still runs per field.** Batching would otherwise let a page
  navigate after the first field and collect the rest — passwords included — so
  the allowlist is re-checked against the tab's current URL before every write,
  and frame grants are re-probed. A field that lands off-allowlist stops the
  batch with `POLICY_DENIED`. The sequencing moved to `shared/fill-form.ts`,
  next to the policy decision it depends on.
- A failed field now reports how far the batch got (`field 2 of 3 (#x) failed
  after 1 filled`), so a caller knows a blind retry would re-write the fields
  that already landed.
- 6 new tests (304 total, 2 skipped).

## 0.9.7 - 2026-09-19

Anonymous usage statistics from the server, so the project can see how many
installs are active, which versions and platforms are in use, and which tools
fail most.

- feat: **server telemetry via PostHog.** The chrome-mcp server sends a random
  install id, its version, OS, CPU architecture and Node major version, whether
  the session owns the bridge port or shares it, how many browsers are paired,
  and per-tool call and error **counts** with error codes, batched every 10
  minutes. Never URLs, domains, tool arguments, page content, screenshots,
  cookies, profile names, tokens, file paths or anything typed. Events are
  personless and GeoIP lookup is disabled. A notice is printed on first run.
- feat: **opt out** with `CHROME_MCP_TELEMETRY=0` (or `false` / `off`),
  `DO_NOT_TRACK=1`, or the new `--no-telemetry` flag.
- The **browser extension still sends nothing**; it only talks to `127.0.0.1`.
  README gains a Telemetry section and PRIVACY.md describes the server side.
- 6 new tests (295 total, 2 skipped).

## 0.9.6 - 2026-09-18

Many sessions, many browsers. Two Claude terminals used to fight over Chrome:
every session starts its own chrome-mcp, the extension dials one port, and the
newest session killed the previous one's server to take it. Now they share.

- feat: **several sessions drive Chrome at once.** The first chrome-mcp to bind
  the port becomes the hub and owns the extension connections. A later one that
  finds the port held by a live chrome-mcp joins it as a peer over the same
  port, authenticated with the token from the 0600 handshake, and relays its
  calls through the hub. Each session keeps its own active profile. When the
  hub's session ends, its peers race for the port: the winner keeps the same
  token, so the extension re-pairs by itself, and the rest join it. A call in
  flight at that moment fails once with `EXTENSION_DISCONNECTED` and idempotent
  calls are retried. The old takeover (verify, then stop) is kept only for a
  chrome-mcp too old to share. Sessions share one browser's tabs, so give each
  its own tabs or its own profile.
- feat: **browsers name themselves.** Chrome won't tell an extension which
  profile it runs in, so every browser that left Profile blank paired as
  `default` — and a second one silently knocked the first off. Each install
  now keeps a random id and the server names it `default`, `profile-2`,
  `profile-3`…, remembered in `~/.chrome-mcp/profiles.json`. A Profile typed
  into Options still wins.
- feat: **`profile_rename`** gives an auto-named browser a friendly name
  (`profile-2` → `work`). The live connection is re-keyed in place, the name
  survives restarts, and the profile's artifacts move with it when the new
  name has no folder yet.
- fix: **`chrome_status` answers when the active profile has no browser** —
  exactly when you need it — and lists every paired browser, how it was named,
  and its active tab as a hint.
- fix: **pairing errors name the profile.** An unpaired profile used to report
  `pair the extension, attach a --cdp-endpoint, or enable the CDP fallback`,
  suggesting flags this build ignores. It now says which profile has no browser
  and exactly what to set in that Chrome's Options.
- fix: **Options saves without re-pasting the token.** The token field is never
  prefilled, and Save refused an empty one, so changing only the Profile
  silently did nothing. A blank token now keeps the stored one, and the page
  shows the name this browser was paired as.
- Verified live with two Chrome profiles and three concurrent sessions. 16 new
  tests (289 total, 2 skipped).

## 0.9.5 - 2026-09-17

Typing into rich editors. `clear: true` never worked on a contenteditable, so
every social composer, comment box and rich text field ended up with the old
text and the new text in the same place.

- fix: **`type` and `focus` handle contenteditable.** `setValue()` looks for a
  `value` setter on the element's prototype. A `<div>` has none, so `clear`
  assigned a dead JS property, the visible text survived, and the new text was
  typed in beside it. Both ops now branch on `isContentEditable` and clear by
  selecting the host's contents and issuing `execCommand('delete')` —
  deprecated, and still the only call that emits the `beforeinput`/`input` pair
  React, Lexical and Quill listen for. Assigning `textContent` updates the DOM
  but leaves their model stale, and the old text returns on the next keystroke.
- fix: **`trusted: true` clears through Chrome's own editing command.**
  `trustedType()` used to clear via the DOM and then send CDP
  `Input.insertText`. A controlled editor re-renders after a DOM-level delete
  and discards the selection, so the keystrokes landed nowhere and the field
  came out EMPTY — worse than duplicated. It now focuses, dispatches
  `selectAll` as a CDP editing command (what Cmd+A does), and lets `insertText`
  replace the selection. One debugger attach still covers the select, the text
  and any `pressEnter`.
- Verified live against X's Draft.js composer on both paths: type, then type
  again with `clear`, leaves exactly one copy. Four regression tests added
  (273 total, 2 skipped).

## 0.9.4 - 2026-09-16

Context pass. The tool catalog is the one cost you pay on **every** turn just
for having this server connected — `tools/list` is re-sent to the model each
time — and it had grown to 32.7 KB. Nothing changes what the tools do.

- feat: **`--tools <list>`** — advertise only the tools a run actually needs.
  Comma-separated and repeatable (`--tools navigate,get_text --tools click`).
  Anything left out is hidden from `tools/list` AND refused if called, including
  from inside a `batch` op, so trimming the surface is a real restriction and not
  a display filter. Unknown names fail at startup with the catalog printed,
  rather than silently dropping a tool you meant to keep. A seven-tool
  read-and-click surface (`tabs_list,tab_new,navigate,snapshot,click,type,get_text`)
  advertises **6.0 KB / ~1.5k tokens** instead of 32.7 KB / ~8.2k — an 82% cut
  for a run that was never going to print a PDF.
- perf: the element-targeting block (`selector` / `ref` / `role` / `name` /
  `nth` / `frameId` / `allFrames`) is now **one shared schema shape** spread
  whole by `click` / `type` / `select_option` / `hover`, instead of three
  objects restated per tool, and its prose is written for the fact that it is
  repeated across a dozen tools: every byte there is paid a dozen times per
  turn. The detail that moved out still lives where it is needed once —
  `frames_list` explains frames, `auth_check` explains auth walls, the README
  explains both. Same fields, same validation, same behaviour.
- perf: the repeated per-field descriptions (`failOnAuthWall` on 12 tools,
  `allFrames` and `frameId` on 18, `tabId` on 29, `snapshotAfter`, `maxBytes`)
  are trimmed to the sentence an agent needs at the call site.
- Measured over a real `tools/list` (39 tools, compact JSON):
  **32,747 B → 27,429 B, -16.2%** (~8.2k → ~6.9k tokens per turn). The largest
  tools: `click` 1855 → 1413 B, `type` 1854 → 1412 B, `select_option`
  1689 → 1247 B, `snapshot` 1322 → 1052 B, `hover` 1283 → 1001 B. A test now
  holds the whole payload under a 28 KB budget, so the next tool has to be
  worth its bytes. (The remaining 1.9 KB of `$schema` preambles is emitted by
  the MCP SDK's zod conversion and is not ours to drop.)
- The extension is unchanged in this release and stays at 0.9.3 — no reload
  needed.

## 0.9.3 - 2026-09-15

Latency pass. Nothing changes what the tools do; each item removes a round-trip,
a polling loop, or bytes from the hot path.

- perf: `navigate` / `reload` / `back` / `forward` / `tab_new` are event-driven.
  The extension used to poll `chrome.tabs.get` every 100ms until the tab said
  `complete`, and ignored `waitUntil`. It now arms `chrome.webNavigation` (and
  `tabs.onUpdated` as belt-and-braces) BEFORE triggering the navigation and
  returns on the event, so a 40ms page costs 40ms; `domcontentloaded` really
  returns before the load event, `networkidle` waits a further 500ms of quiet,
  and same-document navigations (`pushState`, hash) settle immediately. Needs
  the new `webNavigation` permission (same warning text as `tabs`, so no new
  Web Store prompt); reload the unpacked extension to pick it up.
- perf: screenshots default to **JPEG (quality 70) at CSS-pixel size** instead
  of PNG at device pixels — on a Retina display that is 5-10x fewer bytes
  through the bridge and into the model's context, with no legible difference.
  New `screenshot` args: `format: "png"` for lossless, `quality` 1-100, `scale`
  (1 = CSS px, 2 = device px on a 2x display, 0.5 to shrink). CDP capture also
  passes `optimizeForSpeed`. Saved artifacts get a `.jpg` / `.png` extension
  to match. The CDP backend honours the same options via Playwright.
- perf: the `chrome.debugger` session lingers **1.5s** after its last op
  instead of detaching immediately, so a screenshot → trusted click →
  screenshot loop attaches once, not three times (each attach/detach cost a few
  hundred ms and flashed the "is being debugged" bar). A session Chrome drops
  mid-window is re-attached transparently. Trusted `type` with `pressEnter`
  sends the text and the Enter over one attach.
- perf: element ops wait **and** act in ONE page injection. `click`, `type`,
  `hover`, `select_option` and the trusted `focus`/`point` probes used to
  inject a `waitSelector` poll and then inject the op; `pageOp` now polls for
  its own target (up to 5s) and runs the op the tick it appears.
- perf: the target tab is resolved **once** per command. The router resolves
  it up front and shares it with the policy gate, the executor and the
  result frame's `tabUrl`, instead of three `chrome.tabs.query` calls. A stale
  tab handle now surfaces as `TARGET_GONE` rather than a policy denial against
  an empty URL.
- perf: **per-tab URL cache** on the server. The gate's cache only ever covered
  the active tab, so every op of a parallel `batch` (which must pass `tabId`)
  paid a `tabs_list` round-trip. A result for an explicitly-targeted tab now
  caches that tab's landing URL, and a `tabs_list` result primes the cache for
  EVERY tab it lists — the listing that opens a batch is the one round-trip
  the whole batch gates on. Entries live 2s (was 1s); the extension re-gates
  every command against the live URL regardless, fail-closed.
- perf: role+name locators are matched **in the page**. `resolveLocator` used
  to pull up to 400 nodes over the bridge and stamp `data-mcp-ref` on all of
  them to pick one. `collectSnapshot` now takes the locator, scores in place
  with the same tiers, returns only the strongest-tier hits and tags only
  those (under a distinct `l…-N` ref prefix so they cannot collide with a
  prior snapshot's `eN`), and reports `nearby` same-role names for the
  not-found message. The server re-scores what it receives, so both ends agree.
- perf: `snapshot` does less layout work. Visibility uses the native
  `checkVisibility` (one call covers display/visibility/content-visibility on
  the element and its ancestors) plus a single rect check, dropping two
  `getComputedStyle` calls per candidate; the manual ancestor walk remains as
  the fallback. All reads (names, values, visibility) now happen BEFORE any
  `data-mcp-ref` is written — the old read/write interleave forced a style
  recalc per element. The shadow-host scan iterates the live NodeList instead
  of copying every element into an array.
- perf: the extension **redials on a short backoff** (1s, 2s, 4s, 8s, 10s)
  when the socket drops, instead of waiting for the 30s keepalive alarm, so a
  server restart or laptop wake costs seconds; the alarm stays as the fallback
  if the worker was evicted. (The server's 15s ping already resets the MV3
  idle timer on Chrome >= 116, so a connected worker is not evicted.)

## 0.9.2 - 2026-09-14

- feat: auth-wall detection. A session cookie that expires mid-run used to
  surface as `SELECTOR_NOT_FOUND` or `TIMEOUT` on the next step, so an eval
  harness scored the run as an agent failure. `snapshot` now attaches an
  `authWall` verdict (`confidence`, `signals`) whenever the page looks like a
  sign-in wall, a new `auth_check` tool returns `{ authRequired, confidence,
  signals }` for the current tab, and `auth_check`, `snapshot` and `navigate`
  accept `failOnAuthWall: true` to fail with a distinct `[AUTH_REQUIRED]`
  error instead. Detection is pure and server-side (`shared/auth-wall.ts`):
  sign-in URL routes, identity-provider hosts, title, password fields and
  sign-in controls. `high` needs two independent cues; `failOnAuthWall` fires
  only on `high`, so a settings page with a password field never aborts a run.
- feat: `--fail-on-auth-wall` turns the guard on for the whole session. Every
  step that can move the tab (`navigate`, `click`, `type`, `select_option`,
  `press`, `fill_form`, `back`, `forward`, `reload`) checks the page it landed
  on and fails with `[AUTH_REQUIRED]` when it is a sign-in wall; a `wait_for`
  that times out on such a page reports `[AUTH_REQUIRED]` instead of
  `[TIMEOUT]`. The same tools accept `failOnAuthWall: true` per call. Cost is
  one snapshot per guarded step, zero when off. The tool never re-authenticates:
  `[AUTH_REQUIRED]` is where a harness pauses for a human.
  Off by default; no wire change, no extension change. 29 new tests.

## 0.9.1 - 2026-09-13

- feat: the extension reloads itself after an upgrade. An unpacked extension
  reads its own files from disk, so it compares the manifest version on disk
  with the one Chrome loaded, on boot and every 30 seconds, and reloads once
  per new version. After the server mirrors a new build into
  `~/chrome-mcp-extension`, the running extension picks it up with nothing to
  click. No-op for Web Store installs; a storage guard prevents reload loops.
- feat: Web Store packaging. The extension is now named "MCP Extension for
  Chrome", ships icons at 16/32/48/128 (an original ring-and-dot mark, no
  Google branding), and `npm run pack:ext` builds the upload zip with
  `pairing.json` excluded. `docs/PRIVACY.md` and `docs/WEBSTORE.md` hold the
  privacy policy and every dashboard field ready to paste.
- fix: the Options page no longer says "Not paired yet" under a connected
  status for a browser paired before the pairing-source field existed.
- fix: docs and the Options page spell out `npx -y @mehmoodqureshi/chrome-mcp`;
  bare `npx chrome-mcp` resolves to an unrelated package of the same name.

## 0.9.0 - 2026-09-13

- feat: the extension installs to a folder you can find. On every boot, and on
  `--extension-path`, the server mirrors the bundled extension into
  `~/chrome-mcp-extension` (`%USERPROFILE%\chrome-mcp-extension` on Windows;
  `CHROME_MCP_EXTENSION_DIR` overrides) and writes `pairing.json` there. Load
  unpacked now points at a plain folder under your home directory instead of a
  path buried under `npm root -g`, and no global install is needed:
  `npx -y @mehmoodqureshi/chrome-mcp --extension-path` creates it and prints
  the path. Unchanged boots write nothing; after an upgrade the next boot
  refreshes the files and logs a reminder to click Reload on
  `chrome://extensions`. Anyone who loaded the extension straight from the
  package folder on 0.8.0 keeps pairing, since that folder still gets
  `pairing.json` too.
- docs: README and SETUP.md say where the status badge lives (on the toolbar
  icon, behind the puzzle-piece button until pinned) and what each badge means.
- fix: docs and the Options page no longer say `npx chrome-mcp`, which resolves
  to an unrelated npm package of the same name; every example spells out
  `npx -y @mehmoodqureshi/chrome-mcp`.

## 0.8.0 - 2026-09-13

- feat: zero-paste pairing. On every boot the server writes `pairing.json`
  (mode 0600) into its bundled `extension-dist/`; an extension loaded unpacked
  from that folder reads the file from its own package and pairs itself, so
  Load unpacked is the only manual step. The Options-page paste stays as the
  fallback and values saved there take precedence. After a reject (a rotated
  token without `--persist-token`) the extension re-reads the file and retries
  once; while unpaired it re-checks on every keepalive tick, so loading the
  extension before the server ever ran still pairs on its own. The file is
  excluded from the npm tarball and is not web-accessible.
- feat: `SETUP.md`, step-by-step instructions written for an AI agent to
  install, wire, pair and verify chrome-mcp end to end. The README opens with
  the one-paste prompt that points at it.
- feat: `--extension-path` prints the absolute path of the bundled extension
  folder, the thing to pick in Load unpacked, for a global install, an npx
  cache entry and a git checkout alike.
- fix: a fresh install no longer downloads a Chromium it never uses. Playwright
  moves to devDependencies (tests and HITL only) and the postinstall hook is
  gone; the CDP executor is loaded lazily and raises a clear error if anyone
  asks for it. Install from the tarball drops from a browser download to about
  seven seconds and 93 packages.
- fix: `--print-pairing` help said it exits after writing the handshake; it
  keeps the bridge up until Ctrl-C, which is what manual pairing needs.
- chore: the extension manifest version now tracks the package (it had sat at
  0.5.0 since June).

## 0.7.1 - 2026-09-11

- fix: `--log-level silent` now silences the task workspace too. The memory
  writers (`results/`, `screenshots/`, `history.jsonl`) kept a private copy of
  `logErr` from before logging moved into `mcp/log.ts`, so a failed persist still
  wrote to stderr after you asked for silence. They now share the gated logger.

## 0.7.0 - 2026-09-01

- fix: a `ref` (or selector) that lands inside an open shadow root can now be
  acted on. `snapshot` has always walked shadow roots and stamped `data-mcp-ref`
  on what it found there, while every action resolved that ref with a plain
  `document.querySelector` — which cannot cross a shadow boundary. The snapshot
  was advertising elements that no `click` or `type` could ever reach, and the
  failure surfaced as `SELECTOR_NOT_FOUND` with nothing to point at. Every
  DOM-touching command now resolves through one shared page-side resolver
  (`shared/page-fns.ts`) that descends open shadow roots, so what a snapshot
  shows is what an action can hit. Affects any site built on web components.
- feat: frames are addressable. `frames_list` reports the top document and every
  iframe the extension can inject into, with each frame's URL; every
  target-taking tool accepts `frameId` to pin one, or `allFrames: true` to find
  the element in whichever frame has it. Until now every selector ran in the top
  frame only, so an embedded checkout, OAuth consent screen or editor was
  unreachable and looked like a broken selector. Each frame is authorized
  against ITS OWN url before anything runs there — an allowlisted page embedding
  a third-party iframe is not a way to read that third party — and the probe that
  resolves frame URLs runs BEFORE the command, so a mutation never fires inside a
  frame nobody authorized.
- feat: `console_logs`, `network_log` and `dialogs` (behind `--enable-observers`).
  Nothing captured console output, uncaught errors, or network traffic, so an
  agent could see what a page looked like after it broke but never why. An
  in-page hook, registered at document_start for allowlisted domains only,
  records `console.*`, uncaught errors and unhandled rejections, and
  `fetch`/`XMLHttpRequest` (plus Resource Timing on request). Off by default and
  deliberately so: it patches page globals in your real browser. It does not see
  the document request, redirects or headers — the cost of not holding a debugger
  session open across commands.
- fix: a click that opens `alert`/`confirm`/`prompt` no longer hangs. Those block
  the renderer, so every injected script on the page stalled until the command
  timed out and reported `TIMEOUT` — a misleading error for a very ordinary flow
  (delete buttons, "leave site?"). With observers on, dialogs are answered
  (`dismiss` by default: confirm → false, prompt → null; `dialogs { policy:
  "accept" }` switches it) and recorded, and a page's `beforeunload` handler can
  no longer strand an automated navigation.
- feat: password field values never leave the page. `get_html` blanks the `value`
  of every `<input type=password>`, and `snapshot` reports the field flagged
  `secret: true` with no value — it is still targetable, its contents are simply
  not something any caller wanted. Unconditional: no flag to remember.
- feat: `--redact` scrubs secret-shaped strings — JWTs, AWS/GitHub/Slack/Google
  keys, `Bearer` headers, private-key blocks — out of `get_text`, `get_html`,
  `read_as_markdown` and `eval`, with `--redact-pattern <regex>` for your own
  (repeatable; implies `--redact`; an invalid pattern fails at startup rather
  than silently never matching). Opt-in, because a pattern eventually fires on
  something you meant to read. Redaction runs BEFORE the output cap, so a
  truncated read cannot leak what a full one would have hidden.
- feat: `snapshot { diff: true }` returns only what changed since the previous
  snapshot of that tab (added / removed / state-changed), and every action takes
  `snapshotAfter: true` to report what it changed. The snapshot is the most
  token-expensive read in the tool surface and the loop that leans on it hardest
  re-sent a near-identical page every time. Nodes are matched across snapshots by
  role + accessible name rather than by `ref`: refs renumber in document order on
  every snapshot, so diffing on them would report an unchanged button as
  removed-and-re-added the moment anything above it appeared.
- feat: actions accept a `role` + `name` locator instead of a CSS selector, so
  clicking "Sign in" no longer costs a full snapshot read first. Resolution is
  server-side, strongest-match-first, and refuses to guess: an ambiguous locator
  fails with the candidates listed (pass `nth` to choose) rather than acting on
  whichever matched first.
- feat: `print_pdf` renders the page through Chrome's own print pipeline into the
  task's `results/` dir, returning the path and size. The base64 is deliberately
  not returned — a PDF is megabytes no model can read.
- feat: the action log records what a call actually touched — the URL the policy
  was evaluated against, the verdict (`allowed`/`denied`), duration, bytes
  returned, and secrets scrubbed. "What did the agent do in my browser" had no
  answer after the fact; the facts existed only inside the call. Carried on
  `AsyncLocalStorage` so a parallel `batch` cannot attribute one op's URL to
  another's log line.

- ci: drop `publish.yml`. Publishing from CI was abandoned back in 0.4.x — the
  granular npm token cannot bypass 2FA, so every run failed with `EOTP` — and the
  workflow fires on exactly the commits that matter (a version bump), turning each
  release red for no reason. The 0.6.7 release failed it again. Publishing is
  local, via `daily-publish`. Restoring a CI route would mean OIDC Trusted
  Publishing, which is not set up.

Note: no npm release — workflows are not part of the published tarball, so 0.6.7
on npm is unaffected.

## 0.6.7 - 2026-08-03

- feat: `get_html`, `get_text` and `read_as_markdown` take a `maxBytes` cap
  (default 256 KB, matching the long-standing `eval` cap) and report
  `truncated` / `totalBytes` / `returnedBytes` when it bites. These were the last
  uncapped read paths, so one call on a content-heavy page could consume an agent's
  entire context window with no way to ask for less. HTML is cut at a tag boundary
  so every returned element is well-formed, and the slice never splits a UTF-8
  character. The FULL payload is still written to the task's `results/` dir — only
  what crosses into the model's context is bounded.
- feat: `batch` takes a `maxResultBytes` budget (default 1 MB). Each op was bounded
  on its own, but a batch multiplies: 50 `screenshot` or `get_html` ops composed
  into one unbounded result, which is exactly the case `batch` is most useful for.
  Ops past the budget are replaced by a one-line summary naming the tool, block
  count and size, and the header reports `omittedOps`/`omittedBytes`. The first op
  always comes through whole, so a single over-budget op still returns something.
- feat: a read that hits `EXTENSION_DISCONNECTED` mid-flight is retried once after
  re-pairing. MV3 recycles the extension's service worker on its own schedule, so a
  command can be in flight when the socket goes away — a fault with nothing to do
  with the call, which users were fixing by re-issuing the identical request by
  hand. Only idempotent tools are eligible: repeating a `click` or `type` could
  submit a form twice, so mutations still fail on the first attempt.
- fix: `--log-level` is honored. It was parsed and validated but never consumed, so
  `--log-level silent` in an editor MCP config still emitted stderr noise the user
  had explicitly asked to turn off. `silent` now suppresses stderr entirely and
  `debug` enables verbose tracing (resolved config at startup, retry decisions).

## 0.6.6 - 2026-07-30

- fix(security): the domain policy now authorizes the tab a call actually targets.
  A tool given an explicit `tabId` was gated against whichever tab happened to be
  active, so with an allowlisted page in front, a `tabId`-addressed `get_text` /
  `get_html` / `screenshot` / `eval` / `click` (and every other tab-scoped tool)
  could reach a tab whose origin was never checked. The reported-URL cache, which
  only ever describes the active tab, is bypassed when a `tabId` is given.
- fix(security): when the browser reports open tabs but none active, the gate no
  longer silently falls back to `tabs[0]`; an unknown `tabId` is reported as
  `TAB_NOT_FOUND` instead of being gated against a different tab.

## 0.6.5 - 2026-07-28

- fix: surface tabs_list failures instead of defaulting policy to about:blank
- fix: a tab that reports no URL now says so, instead of being denied as a nameless origin
- fix: tools whose policy verdict needs no URL (tab_new/tab_select/tab_close) no
  longer fail when the tab list is unreadable
- fix: the extension policy mirror now fails closed — it refuses every command
  until the server's policy arrives, rather than running ungated
- feat: tool errors carry their executor code (e.g. `[EXTENSION_DISCONNECTED]`)
  so a caller can tell a retryable bridge fault from a policy denial
- perf: halve the round-trips per gated tool call — the extension reports the
  tab's landing URL on each result (new `tab-url` capability) and the server
  gates from it instead of running `tabs_list` first
- docs: quickstart now shows the `claude mcp add` one-liner for terminal-only
  Claude Code users, alongside the Claude Desktop JSON

## 0.6.4 - 2026-07-17

- feat: support native Windows (not just WSL)
- fix: reclaim a pinned port from a stale server instead of failing to start

## 0.6.3 - 2026-07-14

- feat: add dedupe and limit options to the extract_links tool

## 0.6.2 - 2026-07-13

- fix: normalize URL/port/path forms in --allow-domain allowlist entries so they match the bare host

