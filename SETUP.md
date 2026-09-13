# chrome-mcp — agent setup instructions

**You are an AI agent. Follow these steps to set up chrome-mcp end-to-end on this
machine and prove it works.** chrome-mcp lets an MCP client drive the human's
real Chrome browser: real logins, real cookies, no separate Chromium. It has two
halves that must be paired: a stdio MCP server (npm package
`@mehmoodqureshi/chrome-mcp`) and a Manifest V3 extension that ships inside the
same package. Work autonomously; pause only for the two actions that must happen
inside Chrome's own UI (loading the extension, pasting the pairing token).

## Ground rules

- Verify each step's result before moving on. If a command fails, diagnose and
  fix it. Do not proceed on a broken step.
- The server is **deny-all by default**: no domains, no clicks, no eval, no
  downloads, no uploads. Ask the human which domains they want to automate and
  grant only those with `--allow-domain`. Never reach for `--unsafe-all-domains`
  or `--unsafe-enable-eval` unless the human asks for them by name.
- Never print or log the pairing token. It lives in a 0600 file; show the human
  its path, not its contents.
- Requires Node 18 or newer (`node --version`) and Chrome 116 or newer.
- On Windows, MCP hosts must launch the server through `cmd /c npx ...`. See
  step 3.

## Step 1 — Confirm the environment

Run and record the output:

```
node --version
npm --version
```

If Node is below 18, stop and tell the human to upgrade before anything else.

## Step 2 — Install the extension folder

No global install is needed. This one command fetches the package, copies the
extension to a plain folder directly under the home directory, and prints its
path:

```
npx -y @mehmoodqureshi/chrome-mcp --extension-path
```

It prints `~/chrome-mcp-extension` (on Windows `%USERPROFILE%\chrome-mcp-extension`).
Verify with `ls` (or `dir`) that the folder holds `manifest.json` and
`background.js`. Record the path; the human needs it in step 4. The install is
small and downloads no browser: the server drives the Chrome the human already
has. The server refreshes this folder on every boot, so upgrades need no
re-copy, only a Reload on `chrome://extensions`.

## Step 3 — Wire the server into this MCP client

Ask the human which domains they want to automate. Build the argument list from
their answer: one `--allow-domain <glob>` per domain, plus `--enable-mutations`
if they want the agent to click, type, and navigate (almost always yes). Add
`--persist-token` so the pairing survives restarts. Leave every other gate off
unless they ask.

**Claude Code** (registers for every project on this machine):

```
claude mcp add chrome-mcp -s user -- \
  npx -y @mehmoodqureshi/chrome-mcp \
  --allow-domain example.com --enable-mutations --persist-token
```

Everything before `--` belongs to Claude Code. Everything after it is the
server's own command line. Keep the `--` or `--allow-domain` gets read as a
Claude Code option. Verify with `claude mcp list`: chrome-mcp should be listed.
It will show as connected once the server boots, even before the extension has
paired.

**Claude Desktop, Cursor, Windsurf, VS Code, and other JSON-configured hosts:**
add this to the host's MCP config file (the exact path differs per client; VS
Code uses a top-level `servers` key instead of `mcpServers`).

```json
{
  "mcpServers": {
    "chrome-mcp": {
      "command": "npx",
      "args": ["-y", "@mehmoodqureshi/chrome-mcp",
               "--allow-domain", "example.com",
               "--enable-mutations",
               "--persist-token"]
    }
  }
}
```

**Windows:** the command must be `cmd` with args `["/c", "npx", "-y",
"@mehmoodqureshi/chrome-mcp", ...]`, or for Claude Code:
`claude mcp add chrome-mcp -s user -- cmd /c npx -y @mehmoodqureshi/chrome-mcp --allow-domain example.com --enable-mutations --persist-token`.

Tell the human to restart the client (or run `/mcp` in Claude Code) so the
server loads. The first boot writes `~/.chrome-mcp/handshake.json` (mode 0600)
holding the bridge port and the pairing token, and with `--persist-token` it
also stores the token at `~/.chrome-mcp/token` for reuse.

## Step 4 — Load the extension (human action inside Chrome)

You cannot do this step yourself. Give the human these exact instructions:

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `chrome-mcp-extension` folder in
   their home directory (the path from step 2).
4. Confirm an extension named **Chrome MCP Bridge** now appears in the list.

Wait for the human to confirm before continuing.

## Step 5 — Pairing (automatic; verify it)

Pairing needs no paste. Every time the server boots it writes `pairing.json`
(mode 0600) into the same `chrome-mcp-extension` folder the human loaded in step 4.
The extension reads that file from its own folder and pairs itself. So make
sure a server has booted at least once since step 2, in either of these ways:

- the client started one in step 3 (a restart or `/mcp` reconnect is enough), or
- start one yourself in pairing mode and leave it running in the background:

  ```
  npx -y @mehmoodqureshi/chrome-mcp --print-pairing --persist-token
  ```

Verify the file exists (do not print it):

```
ls "$(npx -y @mehmoodqureshi/chrome-mcp --extension-path)/pairing.json"
```

Then tell the human where to look. The status badge is on the extension's
icon in Chrome's toolbar, not on the `chrome://extensions` page. Chrome hides
new extensions behind the puzzle-piece button at the right of the address bar,
so give them these exact steps:

1. Click the puzzle-piece button at the right of the address bar.
2. Find **Chrome MCP Bridge** in the list and click the pin icon next to it.
   The extension icon now stays in the toolbar.
3. Look at the small badge on that icon. Hovering it shows the status in words.

Badge meanings: a green dot means paired and connected. Yellow dots mean
connecting. A grey circle means not paired yet, usually because no server has
run since the extension was loaded. A red exclamation mark means the token was
rejected, which the extension fixes by itself within a few seconds by re-reading
the pairing file.

A green dot can take up to 30 seconds if the extension was loaded before the
server first ran. Wait for the human to confirm the green dot.

**Manual fallback**, only if the badge stays grey after a minute (a copied
extension folder or a read-only global install): read the port without
printing the token,

```
node -e "console.log(require(require('os').homedir()+'/.chrome-mcp/handshake.json').port)"
```

then have the human open **Details** on Chrome MCP Bridge, then **Extension
options**, enter that **Port**, open `~/.chrome-mcp/handshake.json` in a text
editor and paste its `token` into the **Token** field, leave **Profile** as
`default`, and click **Save**. The status line should read **connected** within
a few seconds. Values saved by hand take precedence over the bundled file.

If you started a pairing-mode server in this step, stop it now with Ctrl-C. The
client's own server takes the port over on its next boot, and with
`--persist-token` the extension reconnects to it with no further pairing.

## Step 6 — Prove the chain end-to-end

From the restarted client session, call the MCP tools in this order and check
each result:

1. `chrome_status` — reports the backend as the extension and the session as
   connected.
2. `tabs_list` — returns at least one tab from the human's real Chrome.
3. `navigate` to a URL on one of the allowlisted domains, then `snapshot` —
   returns interactive elements with `ref` ids.
4. `navigate` to a domain that is **not** allowlisted — must be refused with a
   policy error. This confirms deny-all is working, which matters more than the
   happy path.

If `chrome_status` shows the extension disconnected, the pairing in step 5 did
not stick. Re-check the port and token before anything else.

## Step 7 — Report

Summarize for the human:

- Node and package versions installed.
- The absolute `chrome-mcp-extension` path they loaded.
- Which MCP client was configured, at which scope, with which domains and gates.
- Whether the badge went green, and whether `tabs_list`, an allowed
  navigation, and a refused navigation each verified.
- Anything still open on their side, such as restarting the client.

For any failure, name the exact symptom, what you tried, and the matching
section of the README's troubleshooting notes at
`https://github.com/Mehmoodqureshi/chrome-mcp#readme`.
