import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renamedDirectory, runtimeEnv } from '../src/compat';
import { autoUpdateDisabled, PACKAGE_NAME } from '../src/auto-update';
import { telemetryDisabled } from '../src/telemetry';
import { looksLikeMcpBrowserExtension } from '../src/bridge/evict';

test('new package updates from its own npm name and honors existing opt-outs', () => {
  assert.equal(PACKAGE_NAME, 'mcp-browser-extension');
  assert.equal(autoUpdateDisabled({ CHROME_MCP_AUTO_UPDATE: '0' }), true);
  assert.equal(autoUpdateDisabled({ CHROME_MCP_UPDATED_FROM: '0.9.25' }), true);
  assert.equal(telemetryDisabled({ CHROME_MCP_TELEMETRY: '0' }), true);
  assert.equal(runtimeEnv('TOKEN', { CHROME_MCP_TOKEN: 'old', MCP_BROWSER_EXTENSION_TOKEN: 'new' }), 'new');
  assert.equal(runtimeEnv('TOKEN', { CHROME_MCP_TOKEN: 'old' }), 'old');
});

test('renamed data and extension paths reuse files without moving the loaded installation', () => {
  const home = mkdtempSync(join(tmpdir(), 'mcp-rename-'));
  try {
    const legacy = join(home, 'old');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'pairing.json'), 'preserved');
    const current = renamedDirectory(home, 'current', 'old');
    assert.equal(current, join(home, 'current'));
    assert.equal(readFileSync(join(current, 'pairing.json'), 'utf8'), 'preserved');
    writeFileSync(join(current, 'updated'), 'new');
    assert.equal(readFileSync(join(legacy, 'updated'), 'utf8'), 'new');
    assert.equal(renamedDirectory(home, 'current', 'old'), current);
    assert.equal(renamedDirectory(home, 'fresh', 'missing'), join(home, 'fresh'));
    mkdirSync(join(home, 'existing'));
    writeFileSync(join(home, 'existing', 'pairing.json'), 'independent');
    renamedDirectory(home, 'existing', 'old');
    assert.equal(readFileSync(join(home, 'existing', 'pairing.json'), 'utf8'), 'independent');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('port ownership recognizes new and existing installations only', () => {
  assert.equal(looksLikeMcpBrowserExtension('node /opt/node_modules/mcp-browser-extension/dist/src/cli.js'), true);
  assert.equal(looksLikeMcpBrowserExtension('node /opt/node_modules/@mehmoodqureshi/chrome-mcp/dist/src/cli.js'), true);
  assert.equal(looksLikeMcpBrowserExtension('node /opt/another-app/server.js'), false);
});
