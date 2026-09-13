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

