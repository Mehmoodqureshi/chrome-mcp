# Publishing the extension to the Chrome Web Store

Everything below is what the developer dashboard asks for, ready to paste.
Upload is manual: https://chrome.google.com/webstore/devconsole with the
Google account that owns the listing (one-time 5 USD developer registration).

## 1. Build the upload

```bash
npm run pack:ext
```

Produces `chrome-mcp-extension-<version>.zip` at the repo root from a fresh
`extension-dist/` build, with `pairing.json` excluded. The manifest `version`
must be higher than the last one uploaded; it tracks `package.json`.

## 2. Store listing

**Name (45 chars max):** MCP Extension for Chrome

> Matches the manifest `name`. Google's branding rules allow "for Chrome" as a
> trailing qualifier; what they refuse is a name that leads with the trademark,
> so keep the word order exactly as above.

**Summary (132 chars max):**
Lets a local chrome-mcp server drive the Chrome you are already logged into. Pairs with your own machine only. Deny-all by default.

**Description:**
MCP Extension for Chrome is the browser half of chrome-mcp, an open-source MCP server (MIT) that lets an AI agent on your own computer use the Chrome you already have open: your sessions, your cookies, your logins, with no separate automated browser.

How it works
- You start the chrome-mcp server from your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, or any other MCP host).
- This extension connects to that server on 127.0.0.1 and carries out its commands: tabs, navigation, clicks, typing, page reads, screenshots, downloads.
- Nothing leaves your machine. The only endpoint the extension ever talks to is localhost.

Safety
- The server is deny-all by default. You choose which domains the agent may touch; everything else is refused before a command runs.
- Clicking and typing, downloads, uploads, and script evaluation are each separate opt-ins on the server.
- Every call is recorded to a local history file so you can see what the agent did afterwards.

Setup
1. Install and register the server: see https://github.com/Mehmoodqureshi/chrome-mcp
2. Install this extension.
3. Open the extension's Options page and paste the port and token from ~/.chrome-mcp/handshake.json. A green badge on the toolbar icon means connected.

Source, docs, and issues: https://github.com/Mehmoodqureshi/chrome-mcp

**Category:** Developer Tools
**Language:** English
**Homepage URL:** https://chrome-mcp-omega.vercel.app
**Support URL:** https://github.com/Mehmoodqureshi/chrome-mcp/issues

## 3. Graphic assets

- Icon 128x128: `extension/icons/icon128.png` (uploaded automatically from the manifest).
- Screenshots, at least one, 1280x800 or 640x400 PNG: take one of the Options page showing the green "connected" status, and one of Chrome with the toolbar badge. Real screenshots only; the store rejects mockups.
- Small promo tile 440x280 (optional).

## 4. Privacy tab

**Single purpose:** Connects this browser to a chrome-mcp server running on the same computer so a local AI agent can drive it.

**Permission justifications:**
- `tabs`: list, open, close and switch tabs on the server's instruction.
- `scripting`: run the read and interaction commands (text, HTML, click, type) inside allowlisted pages.
- `activeTab`: act on the tab the user is looking at when no tab id is given.
- `downloads`: save files the server asks for into the local task folder.
- `storage`: keep the pairing token, connection state and profile name.
- `alarms`: a 30-second keepalive so the service worker stays connected.
- `cookies`: read cookies of allowlisted sites when the server asks, so the agent can use existing sessions.
- `webNavigation`: know when a navigation the server triggered has committed or finished loading, so `navigate` / `reload` / `back` / `forward` return as soon as the page is ready instead of polling. Never used to observe browsing the server did not request.
- `debugger`: trusted OS-level input on framework-controlled inputs and screenshots of a specific tab without focusing it. Attached only for those commands and detached afterwards.
- `host_permissions <all_urls>`: the server's domain allowlist decides which sites may be touched; the extension needs the broad grant so that allowlist can name any site. No command runs on a page that is not allowlisted.

**Remote code:** No. All code is bundled.

**Data usage:** check "Website content", "Authentication information" (cookies), and "Personal communications" if the user's allowlist includes such sites. Certify: not sold, not used for unrelated purposes, not used for creditworthiness. All data is transferred only to a local server on the user's own machine.

**Privacy policy URL:** https://chrome-mcp-omega.vercel.app/docs/privacy

## 5. Distribution

Start with **Unlisted**: anyone with the link can install, nothing shows in search, and the review is the same. Switch to Public once a version has passed review.

## 6. Known difference from the unpacked install

A store-installed extension lives in Chrome's own profile folder, which the
server cannot write into, so the zero-paste pairing that works for
`~/chrome-mcp-extension` does not apply. Store users pair once from the Options
page. Keep `--persist-token` in the server config so they never do it again.
