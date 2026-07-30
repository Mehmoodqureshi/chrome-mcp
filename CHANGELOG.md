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

