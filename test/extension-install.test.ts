/**
 * extension-install: the bundled extension is mirrored into a plain folder under
 * the home dir (or CHROME_MCP_EXTENSION_DIR). Copies only what changed, never
 * touches pairing.json in the target, never throws, and always returns a
 * loadable folder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extensionInstallDir, syncExtension, EXTENSION_DIR_NAME } from '../src/extension-install';

function fakeBundle(): string {
  const from = mkdtempSync(join(tmpdir(), 'cmcp-bundle-'));
  writeFileSync(join(from, 'manifest.json'), '{"manifest_version":3,"name":"t","version":"0.0.1"}');
  writeFileSync(join(from, 'background.js'), 'console.log(1)');
  writeFileSync(join(from, 'options.html'), '<p>hi</p>');
  // A pairing file in the SOURCE must never be mirrored — it belongs to the server, per target.
  writeFileSync(join(from, 'pairing.json'), '{"port":1,"token":"src"}');
  mkdirSync(join(from, 'subdir'));
  writeFileSync(join(from, 'subdir', 'ignored.txt'), 'x');
  return from;
}

test('syncExtension: mirrors top-level files, is idempotent, and re-copies only what changed', () => {
  const from = fakeBundle();
  const to = join(mkdtempSync(join(tmpdir(), 'cmcp-home-')), EXTENSION_DIR_NAME);

  const first = syncExtension(from, to);
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.dir, to);
  assert.deepEqual(first.copied.sort(), ['background.js', 'manifest.json', 'options.html']);
  assert.equal(existsSync(join(to, 'pairing.json')), false, 'source pairing.json is not mirrored');
  assert.equal(existsSync(join(to, 'subdir')), false, 'only top-level files are mirrored');

  const second = syncExtension(from, to);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.copied, [], 'unchanged boot writes nothing');

  writeFileSync(join(from, 'background.js'), 'console.log(2)');
  const third = syncExtension(from, to);
  assert.deepEqual(third.copied, ['background.js']);
  assert.equal(readFileSync(join(to, 'background.js'), 'utf8'), 'console.log(2)');
});

test('syncExtension: leaves the target pairing.json alone and never throws on a bad source', () => {
  const from = fakeBundle();
  const to = join(mkdtempSync(join(tmpdir(), 'cmcp-home-')), EXTENSION_DIR_NAME);
  syncExtension(from, to);
  writeFileSync(join(to, 'pairing.json'), '{"port":38017,"token":"mine"}');
  syncExtension(from, to);
  assert.equal(readFileSync(join(to, 'pairing.json'), 'utf8'), '{"port":38017,"token":"mine"}');

  const missing = syncExtension(join(from, 'nope'), to);
  assert.equal(missing.ok, false);
  assert.equal(missing.dir, join(from, 'nope'), 'falls back to the source path so the caller still has a folder');
  assert.ok(missing.error);

  const notABundle = mkdtempSync(join(tmpdir(), 'cmcp-empty-'));
  const noManifest = syncExtension(notABundle, to);
  assert.equal(noManifest.ok, false);
  assert.match(noManifest.error ?? '', /manifest\.json/);
});

test('extensionInstallDir: defaults to ~/chrome-mcp-extension; CHROME_MCP_EXTENSION_DIR overrides', () => {
  const prev = process.env.CHROME_MCP_EXTENSION_DIR;
  try {
    delete process.env.CHROME_MCP_EXTENSION_DIR;
    assert.ok(extensionInstallDir().endsWith(EXTENSION_DIR_NAME));
    process.env.CHROME_MCP_EXTENSION_DIR = join(tmpdir(), 'custom-ext');
    assert.equal(extensionInstallDir(), join(tmpdir(), 'custom-ext'));
  } finally {
    if (prev === undefined) delete process.env.CHROME_MCP_EXTENSION_DIR;
    else process.env.CHROME_MCP_EXTENSION_DIR = prev;
  }
});

test('the mirror never puts an older extension over a newer one', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { syncExtension, compareVersions } = await import('../src/extension-install');
  const from = mkdtempSync(join(tmpdir(), 'cmcp-old-'));
  const to = mkdtempSync(join(tmpdir(), 'cmcp-new-'));
  writeFileSync(join(from, 'manifest.json'), '{"manifest_version":3,"name":"t","version":"0.9.15"}');
  writeFileSync(join(from, 'background.js'), 'old');
  writeFileSync(join(to, 'manifest.json'), '{"manifest_version":3,"name":"t","version":"0.9.19"}');
  writeFileSync(join(to, 'background.js'), 'new');
  const r = syncExtension(from, to);
  assert.equal(r.ok, true);
  assert.deepEqual(r.copied, []);
  assert.equal(readFileSync(join(to, 'background.js'), 'utf8'), 'new');
  // ...and a newer one still replaces an older one.
  const r2 = syncExtension(to, from);
  assert.ok(r2.copied.includes('background.js'));
  assert.ok(compareVersions('0.10.0', '0.9.19') > 0);
});
