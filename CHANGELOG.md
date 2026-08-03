## Unreleased

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

