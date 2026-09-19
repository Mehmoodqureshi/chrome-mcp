# Privacy policy — MCP Extension for Chrome

Last updated: 2026-09-18

MCP Extension for Chrome is the browser half of chrome-mcp, an open-source tool
(MIT, https://github.com/Mehmoodqureshi/chrome-mcp) that lets an AI agent
running on your own computer drive the Chrome you already use.

## What the extension does

It opens a WebSocket connection to a chrome-mcp server running on the same
machine, at `127.0.0.1` only, and carries out the commands that server sends:
listing and opening tabs, navigating, clicking, typing, reading page text and
HTML, taking screenshots, reading cookies and site storage, and saving
downloads. The server is started by you, on your computer, from your MCP
client (for example Claude Code or Claude Desktop).

## What data it handles

- Page content, screenshots, cookies, and site storage of the tabs the server
  asks about. This data is sent only to the local server over the loopback
  interface. The server hands it to the AI client you configured.
- A pairing token, stored in the extension's local storage, so the server can
  tell this browser apart from any other local program.
- The connection state and the profile name you chose, also in local storage.

## What it does not do

- It never sends any data to the extension author or to any remote server.
  The only network endpoint it connects to is `127.0.0.1`.
- It does not collect analytics, telemetry, or crash reports.
- It does not run remote code. All code is in the package you install.
- It does nothing until you pair it with a local server, and it acts only on
  the domains that server's allowlist permits. The server ships deny-all by
  default.

## Which sites it can touch

Access is decided by the allowlist you give the local server
(`--allow-domain`). The extension requests access to all URLs only so that
allowlist can name any site; without a matching entry, no command runs on a
page.

## Data retention

Nothing is retained by the extension beyond the local-storage items above. You
can clear them by removing the extension. Anything the server saves
(screenshots, downloads, action history) lives in `~/.chrome-mcp` on your own
machine under your control.

## The chrome-mcp server (separate from the extension)

This policy covers the extension, which sends nothing anywhere. The chrome-mcp
server — the npm package you run from your MCP client — sends anonymous usage
statistics: a random install id, its version, OS, CPU architecture, Node
version, and counts of tool calls and error codes. It never sends URLs, page
content, tool arguments, cookies or anything the extension reads. Turn it off
with `CHROME_MCP_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `--no-telemetry`. Details:
https://github.com/Mehmoodqureshi/chrome-mcp#telemetry

## Contact

Open an issue at https://github.com/Mehmoodqureshi/chrome-mcp/issues.
