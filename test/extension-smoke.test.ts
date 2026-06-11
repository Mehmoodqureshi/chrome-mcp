/**
 * Phase 4 verification (gated behind RUN_EXT_SMOKE — needs a real, headed
 * Chrome to load an unpacked extension). Loads extension-dist, pairs it with a
 * live BridgeServer by seeding chrome.storage, then drives a real round-trip:
 * navigate → get_text against a local page. Proves the WS client, the handshake,
 * the router, and the chrome.scripting executor all work end-to-end.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright';

import { BridgeServer } from '../src/bridge/server';

const RUN = !!process.env.RUN_EXT_SMOKE;
const MARKER = 'HELLO-CMCP-4242';

function startPage(): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body><h1>${MARKER}</h1></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, server });
    });
  });
}

async function waitFor(predicate: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('extension pairs and round-trips navigate → get_text', { skip: !RUN }, async () => {
  const token = 'smoke-token-xyz';
  const bridge = new BridgeServer({ token, serverVersion: 'smoke', port: 0, heartbeatMs: 0 });
  const port = await bridge.start();
  const page = await startPage();

  const extPath = join(process.cwd(), 'extension-dist');
  const userDataDir = mkdtempSync(join(tmpdir(), 'cmcp-ext-'));
  let ctx: BrowserContext | null = null;

  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--no-first-run'],
    });

    // Grab the extension's service worker.
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 10_000 });

    // Seed pairing config; storage.onChanged in the SW triggers the connect.
    await sw.evaluate(
      ([p, t]) =>
        (globalThis as unknown as { chrome: { storage: { local: { set(v: unknown): Promise<void> } } } }).chrome.storage.local.set({
          wsPort: p,
          token: t,
        }),
      [port, token] as [number, string],
    );

    await waitFor(() => bridge.hasActiveExtension(), 12_000, 'extension to pair');

    // Drive a real navigation + read through the bridge.
    const nav = (await bridge.sendCommand('navigate', { url: page.url })) as { url: string };
    assert.match(nav.url, /^http:\/\/127\.0\.0\.1/);

    const text = (await bridge.sendCommand('get_text', {})) as { text: string };
    assert.match(text.text, new RegExp(MARKER));
  } finally {
    await ctx?.close();
    await bridge.stop();
    page.server.close();
  }
});
