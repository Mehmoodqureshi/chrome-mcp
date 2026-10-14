/** Real browser restarts, isolated from the person's Chrome. Run with RUN_EXT_RESTART=1. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type CDPSession, type Worker } from 'playwright';
import { syncExtension } from '../src/extension-install';
import { inspectExtensionProfiles, repairExtensionProfiles } from '../src/extension-repair';
import { STORE_EXTENSION_ID } from '../shared/protocol';

const RUN = process.env.RUN_EXT_RESTART === '1';
const key = readFileSync(join(process.cwd(), 'extension/store-public-key.txt'), 'utf8').trim();
const manifest = { manifest_version: 3, name: 'MCP Browser Extension restart fixture', version: '1.0',
  background: { service_worker: 'background.js' }, permissions: ['storage'] };
const marker = { profile: 'restart-test', pairingMarker: 'preserve-local-settings' };

async function worker(ctx: BrowserContext, id: string): Promise<Worker> {
  return ctx.serviceWorkers().find(w => w.url().includes(id)) ??
    ctx.waitForEvent('serviceworker', { predicate: w => w.url().includes(id), timeout: 10_000 });
}
async function list(cdp: CDPSession): Promise<Array<{ id: string; enabled: boolean; version: string }>> {
  return (await cdp.send('Extensions.getExtensions')).extensions;
}
async function reload(ctx: BrowserContext, id: string): Promise<void> {
  await (await worker(ctx, id)).evaluate(() => (globalThis as any).chrome.runtime.reload()).catch(error => {
    if (!/closed|destroyed|Target/i.test(String(error))) throw error;
  });
}

for (const keyed of [false, true]) {
  test(`real restart: an updated ${keyed ? 'keyed' : 'legacy keyless'} install retains its ID and settings`, { skip: !RUN }, async () => {
    const base = mkdtempSync(join(tmpdir(), 'mcp-stable-id-'));
    const ext = join(base, 'installed'); const bundle = join(base, 'bundle'); const profile = join(base, 'browser');
    for (const dir of [ext, bundle]) {
      mkdirSync(dir);
      writeFileSync(join(dir, 'background.js'), 'chrome.runtime.onStartup.addListener(() => {});');
    }
    writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, ...(keyed ? { key } : {}) }));
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0', key }));
    let ctx: BrowserContext | undefined;
    const start = async () => {
      ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
      return ctx.browser()!.newBrowserCDPSession();
    };
    try {
      let cdp = await start();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: ext });
      await (await worker(ctx!, id)).evaluate(value => (globalThis as any).chrome.storage.local.set(value), marker);
      assert.equal(syncExtension(bundle, ext).ok, true);
      await reload(ctx!, id);
      await ctx!.close(); ctx = undefined;
      for (let boot = 0; boot < 2; boot++) {
        cdp = await start();
        const extensions = await list(cdp);
        assert.deepEqual(extensions.map(e => e.id), [id]);
        assert.equal(extensions[0].enabled, true);
        assert.equal(extensions[0].version, '2.0');
        const storage: unknown = await (await worker(ctx!, id)).evaluate(() => (globalThis as any).chrome.storage.local.get(null));
        assert.deepEqual(storage, marker);
        await ctx!.close(); ctx = undefined;
      }
    } finally { await ctx?.close(); }
  });
}

test('real restart: reproduce the old ID-changing update, then repair it without losing settings', { skip: !RUN }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'mcp-repair-restart-'));
  const ext = join(base, 'installed'); const profile = join(base, 'browser');
  mkdirSync(ext);
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(ext, 'background.js'), 'chrome.runtime.onStartup.addListener(() => {});');
  let ctx: BrowserContext | undefined;
  const start = async () => {
    ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    return ctx.browser()!.newBrowserCDPSession();
  };
  try {
    let cdp = await start();
    const { id: oldId } = await cdp.send('Extensions.loadUnpacked', { path: ext });
    // Reproduce the released updater's behavior: add the store key in place.
    writeFileSync(join(ext, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0', key }));
    await reload(ctx!, oldId);
    await (await worker(ctx!, STORE_EXTENSION_ID)).evaluate(value => (globalThis as any).chrome.storage.local.set(value), marker);
    await ctx!.close(); ctx = undefined;
    cdp = await start();
    assert.deepEqual(await list(cdp), [], 'the real browser must reproduce the missing extension');
    await ctx!.close(); ctx = undefined;
    assert.deepEqual(inspectExtensionProfiles([profile]).profiles[0].staleIds, [oldId]);
    const repair = repairExtensionProfiles({ roots: [profile], backupDir: join(base, 'backups'), apply: true,
      checkBrowsersClosed: () => assert.equal(ctx, undefined, 'only this isolated test browser is being repaired') });
    assert.equal(repair.applied, true);
    cdp = await start();
    assert.deepEqual((await list(cdp)).map(e => ({ id: e.id, enabled: e.enabled })), [{ id: STORE_EXTENSION_ID, enabled: true }]);
    assert.deepEqual(await (await worker(ctx!, STORE_EXTENSION_ID)).evaluate(() => (globalThis as any).chrome.storage.local.get(null)), marker);
  } finally { await ctx?.close(); }
});
