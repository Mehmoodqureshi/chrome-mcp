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

**Name (45 chars max):** MCP Browser Extension

> Matches the manifest `name`. Google's branding rules allow "for Chrome" as a
> trailing qualifier; what they refuse is a name that leads with the trademark,
> so keep the word order exactly as above.

**Summary (132 chars max):**
Connect your signed-in Chrome to MCP clients through a local server. Optional remote tunnels and profile proxies. Deny-all by default.

**Description:**
MCP Browser Extension is an open-source MCP server and extension (MIT) that lets an AI agent on your own computer use the Chrome you already have open: your sessions, your cookies, your logins, with no separate automated browser.

How it works
- You start the MCP Browser Extension server (npm package @mehmoodqureshi/chrome-mcp) from your MCP client (Claude Code, Claude Desktop, Cursor, Windsurf, or any other MCP host).
- This extension connects to that server on 127.0.0.1 and carries out its commands: tabs, navigation, clicks, typing, page reads, screenshots, downloads.
- The extension sends browser results to your local server, which forwards them to your configured MCP client. An optional tunnel allows remote clients to connect using a private access key. Optional proxy IP checks contact ipinfo.io or api.ipify.org.

Safety
- The server is deny-all by default. You choose which domains the agent may touch; everything else is refused before a command runs.
- Clicking and typing, downloads, uploads, and script evaluation are each separate opt-ins on the server.
- Every call is recorded to a local history file so you can see what the agent did afterwards.

Setup
1. Install and register the server: see https://github.com/Mehmoodqureshi/chrome-mcp
2. Install this extension.
3. Click the toolbar icon, open Settings, and click Connect to pair with your local server. Manual port and token pairing is also available. A green badge means connected.

Source, docs, and issues: https://github.com/Mehmoodqureshi/chrome-mcp

**Category:** Developer Tools
**Language:** English
**Homepage URL:** https://mcp-browser-extension.com
**Support URL:** https://github.com/Mehmoodqureshi/chrome-mcp/issues

## 3. Graphic assets

- Icon 128x128: `extension/icons/icon128.png` (uploaded automatically from the manifest).
- Screenshots, at least one, 1280x800 or 640x400 PNG: take one of the Options page showing the green "connected" status, and one of Chrome with the toolbar badge. Real screenshots only; the store rejects mockups.
- Small promo tile 440x280 (optional).

## 4. Privacy tab

**Single purpose:** Connects this browser to the MCP Browser Extension server running on the same computer so a local AI agent can drive it.

**Permission justifications:**
- `tabs`: list, open, close and switch tabs on the server's instruction.
- `scripting`: run the read and interaction commands (text, HTML, click, type) inside allowlisted pages, and draw the optional outline that marks tabs the agent is working in (a user stylesheet, removed when the agent stops or the server disconnects).
- `downloads`: save files the server asks for into the local task folder.
- `storage`: keep the pairing token, a random install id (sent only to the local server), the ids of tabs it opened (session storage, so it never reuses one of the user's tabs), connection state, profile name, the user's "Outline the tabs" setting, and the local server's allowed sites plus up to ten recently refused host names, so the Options page can offer an Allow button. Nothing in storage leaves the computer.
- `alarms`: a 30-second keepalive so the service worker stays connected.
- `cookies`: read cookies of allowlisted sites when the server asks, so the agent can use existing sessions.
- `webNavigation`: know when a navigation the server triggered has committed or finished loading, so `navigate` / `reload` / `back` / `forward` return as soon as the page is ready instead of polling. Never used to observe browsing the server did not request.
- `debugger`: trusted OS-level input on framework-controlled inputs and screenshots of a specific tab without focusing it. Attached only for those commands and detached afterwards.
- `nativeMessaging` (optional, requested only when the user clicks Connect): fetch the port and token from the local MCP Browser Extension server's helper, so pairing is one click instead of copying a token. The helper runs on the user's computer, is registered by the server the user installed, and only answers the pairing.
- `proxy`: route this Chrome profile through a proxy the user types on the Options page (off by default). Chrome applies a proxy to a whole profile, so users set it in a profile kept for agent work. Never set by the agent or the server; the agent can only read whether it is on.
- `webRequest` + `webRequestAuthProvider`: answer the login prompt of that user-configured proxy with the username and password the user saved. Only proxy challenges (`isProxy`) from the configured proxy host are answered; every other request is left untouched.
- `privacy` (optional, requested only when the user ticks "Stop WebRTC from revealing the real IP"): set WebRTC to proxied connections only while the proxy is on.
- `host_permissions <all_urls>`: the server's domain allowlist decides which sites may be touched; the extension needs the broad grant so that allowlist can name any site. No command runs on a page that is not allowlisted.

**Remote code:** No. All code is bundled.

**Proxy (0.9.22):** the proxy host, port, username and password stay in the extension's local storage in that Chrome profile and are never sent to the server. To show which IP sites see, the extension fetches `https://ipinfo.io/json` (falling back to `https://api.ipify.org`) only when the user clicks Check IP or the agent calls `proxy_status`.

**Data usage:** check "Website content", "Authentication information" (cookies), "Web history" (from 0.9.16 the extension keeps up to ten recently refused host names locally for the Allow button), and "Personal communications" if the user's allowlist includes such sites. Certify: not sold, not used for unrelated purposes, not used for creditworthiness. Browser results go to the local server and then the configured MCP client, including remote clients when the user enables a tunnel. Proxy IP checks contact the services described above.

**Privacy policy URL:** https://mcp-browser-extension.com/docs/privacy

## 5. Distribution

Start with **Unlisted**: anyone with the link can install, nothing shows in search, and the review is the same. Switch to Public once a version has passed review.

## 6. Known difference from the unpacked install

A store-installed extension lives in Chrome's own profile folder, which the
server cannot write into, so the zero-paste pairing that works for
`~/chrome-mcp-extension` does not apply. Store users pair once from the Options
page. Keep `--persist-token` in the server config so they never do it again.
