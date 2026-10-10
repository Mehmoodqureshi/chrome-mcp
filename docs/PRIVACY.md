# Privacy policy — MCP Browser Extension

Last updated: 2026-10-10

MCP Browser Extension is the browser half of chrome-mcp, an open-source tool
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
- A pairing token and port, stored in the extension's local storage, so the
  server can tell this browser apart from any other local program.
- A random install id, created on first run and sent only to the local server,
  so it can tell two Chrome profiles apart and keep each one's name.
- The connection state, the profile name you chose or were given, and your
  "Outline the tabs" setting, also in local storage.
- The ids of the tabs it opened itself (numbers only, in session storage that
  Chrome clears when it closes), so it reuses only its own blank tabs and never
  one of yours.
- The list of sites the local server currently allows, and up to ten site
  names (host names only, such as `example.com`; never full addresses or page
  content) that the server recently refused, so the Options page can show them
  with an Allow button. They stay in local storage until you allow or dismiss
  them. When you click Allow or Remove, that host name is sent to the local
  server only.

## What it does not do

- It never sends any data to the extension author or to any remote server.
  The only network endpoint it connects to is `127.0.0.1`.
- It does not collect analytics, telemetry, or crash reports.
- It does not run remote code. All code is in the package you install.
- It does nothing until you pair it with a local server, and it acts only on
  the domains that server's allowlist permits. The server ships deny-all by
  default.

## Which sites it can touch

Access is decided by the allowlist of the local server: the sites given with
`--allow-domain`, plus any you allow yourself on the extension's Options page.
The extension requests access to all URLs only so that allowlist can name any
site; without a matching entry, no command runs on a page. The AI agent cannot
add a site: the extension refuses every command aimed at its own pages, so only
you can click Allow.

## Data retention

Nothing is retained by the extension beyond the local-storage items above. You
can clear them by removing the extension. Anything the server saves
(screenshots, downloads, action history, and the sites you allowed from the
Options page, in `allowed-sites.json`) lives in `~/.chrome-mcp` on your own
machine under your control.

## The chrome-mcp server (separate from the extension)

This policy covers the extension, which sends nothing anywhere. The chrome-mcp
server, the npm package you run from your MCP client, makes two kinds of
outside requests:

- **Anonymous usage statistics**, to PostHog: a random install id (not the
  extension's), its version, OS, CPU architecture, Node version, whether the
  session owns or shares the bridge port, how many browsers are paired and, when
  none is, which of a few fixed reasons applies (`no_extension`,
  `token_mismatch`, `version_mismatch`, `profile_mismatch`), counts of tool
  calls and error codes, and for each tool call its name, duration, whether it
  failed and the error code, the AI client's name and version (such as
  `claude-code`), and a random per-session id. It never sends URLs, site names, page content, tool
  arguments, cookies, profile names or anything the extension reads. Events are
  personless and GeoIP lookup is disabled. Turn it off with
  `CHROME_MCP_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `--no-telemetry`. Details:
  https://github.com/Mehmoodqureshi/chrome-mcp#telemetry
- **An update check**, to the npm registry (`registry.npmjs.org`), once at
  startup, asking only for the latest version number of
  `@mehmoodqureshi/chrome-mcp`. It carries no install id or usage data; npm
  sees what any package download shows it (your IP address). When a newer
  version exists, the server starts it through `npx`, which downloads it from
  npm. Turn it off with `CHROME_MCP_AUTO_UPDATE=0` or `--no-auto-update`.

## Contact

Open an issue at https://github.com/Mehmoodqureshi/chrome-mcp/issues.
