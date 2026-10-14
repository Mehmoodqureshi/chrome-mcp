import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionIdFromKey, inspectExtensionProfiles, repairExtensionProfiles } from '../src/extension-repair';
import { STORE_EXTENSION_ID } from '../shared/protocol';

const oldId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const storeKey = readFileSync(join(process.cwd(), 'extension/store-public-key.txt'), 'utf8').trim();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mcp-repair-test-'));
  const root = join(base, 'browser');
  const profile = join(root, 'Default');
  const extension = join(base, 'extension');
  mkdirSync(profile, { recursive: true });
  mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ name: 'MCP Browser Extension', version: '1.0', key: storeKey }));
  const current = { path: extension, location: 4, from_webstore: false, marker: 'preserve current configuration' };
  const data = {
    extensions: { settings: {
      [STORE_EXTENSION_ID]: current,
      [oldId]: { path: extension, location: 4, disable_reasons: [4] },
      unrelated: { path: 'other/1.0', location: 1, from_webstore: true },
    } },
    protection: { macs: { marker: 'Chrome owns integrity metadata' } },
    unrelated: { setting: 'keep' },
  };
  const file = join(profile, 'Secure Preferences');
  writeFileSync(file, JSON.stringify(data));
  const storage = join(profile, 'Local Extension Settings', STORE_EXTENSION_ID);
  mkdirSync(storage, { recursive: true });
  writeFileSync(join(storage, 'fixture'), 'pairing and other saved settings');
  return { base, root, profile, extension, data, file, storage, backupDir: join(base, 'backups') };
}

test('doctor identifies the exact duplicate-ID conflict without changing preferences', () => {
  const f = fixture();
  const before = readFileSync(f.file);
  assert.equal(extensionIdFromKey(storeKey), STORE_EXTENSION_ID);
  const scan = inspectExtensionProfiles([f.root]);
  assert.deepEqual(scan.errors, []);
  assert.deepEqual(scan.profiles[0].staleIds, [oldId]);
  assert.equal(scan.profiles[0].registrations.find(r => r.id === STORE_EXTENSION_ID)?.source, 'unpacked');
  assert.deepEqual(readFileSync(f.file), before);
});

test('repair previews by default; applying backs up and removes only the proven stale record', () => {
  const f = fixture();
  const before = readFileSync(f.file);
  const opts = { roots: [f.root], backupDir: f.backupDir, checkBrowsersClosed: () => {} };
  assert.equal(repairExtensionProfiles(opts).applied, false);
  assert.deepEqual(readFileSync(f.file), before);
  assert.equal(existsSync(f.backupDir), false);
  const result = repairExtensionProfiles({ ...opts, apply: true });
  assert.equal(result.applied, true);
  assert.deepEqual(result.removed, [{ profileDir: f.profile, id: oldId }]);
  const expected = JSON.parse(before.toString());
  delete expected.extensions.settings[oldId];
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), expected);
  assert.deepEqual(readFileSync(join(result.backup!, '0.json')), before);
  if (process.platform !== 'win32') assert.equal(statSync(join(result.backup!, '0.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.storage, 'fixture'), 'utf8'), 'pairing and other saved settings');
  assert.equal(repairExtensionProfiles({ ...opts, apply: true }).applied, false, 'second repair is a no-op');
});

test('repair refuses a running browser and detects preferences changed before writing', () => {
  const f = fixture();
  const before = readFileSync(f.file);
  assert.throws(() => repairExtensionProfiles({ roots: [f.root], backupDir: f.backupDir, apply: true,
    checkBrowsersClosed: () => { throw new Error('browser is running'); } }), /running/);
  assert.deepEqual(readFileSync(f.file), before);
  let checks = 0;
  assert.throws(() => repairExtensionProfiles({ roots: [f.root], backupDir: f.backupDir, apply: true,
    checkBrowsersClosed: () => { if (++checks === 2) writeFileSync(f.file, JSON.stringify({ changed: true })); } }), /preferences changed/);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { changed: true }, 'concurrent changes must not be overwritten');
});

test('a Store install is reported as Store and is never repaired as an unpacked conflict', () => {
  const f = fixture();
  const relative = `${STORE_EXTENSION_ID}/1.0_0`;
  mkdirSync(join(f.profile, 'Extensions', relative), { recursive: true });
  writeFileSync(join(f.profile, 'Extensions', relative, 'manifest.json'), JSON.stringify({ name: 'MCP Browser Extension', version: '1.0' }));
  const data = { extensions: { settings: { [STORE_EXTENSION_ID]: { path: relative, location: 1, from_webstore: true } } } };
  writeFileSync(f.file, JSON.stringify(data));
  const scan = inspectExtensionProfiles([f.root]);
  assert.equal(scan.profiles[0].registrations[0].source, 'web-store');
  assert.deepEqual(scan.profiles[0].staleIds, []);
  const result = repairExtensionProfiles({ roots: [f.root], backupDir: f.backupDir, apply: true });
  assert.equal(result.applied, false);
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), data);
});

test('repair stops if the current registration disappears after diagnosis', () => {
  const f = fixture();
  let checked = false;
  assert.throws(() => repairExtensionProfiles({ roots: [f.root], backupDir: f.backupDir, apply: true,
    checkBrowsersClosed: () => {
      if (checked) return;
      checked = true;
      const changed = JSON.parse(readFileSync(f.file, 'utf8'));
      delete changed.extensions.settings[STORE_EXTENSION_ID];
      writeFileSync(f.file, JSON.stringify(changed));
    },
  }), /changed during inspection/);
  assert.ok(JSON.parse(readFileSync(f.file, 'utf8')).extensions.settings[oldId]);
});

test('missing files, malformed preferences and a lone old record are reported without speculative repair', () => {
  const f = fixture();
  delete (f.data.extensions.settings as Record<string, unknown>)[STORE_EXTENSION_ID];
  writeFileSync(f.file, JSON.stringify(f.data));
  let scan = inspectExtensionProfiles([f.root]);
  assert.deepEqual(scan.profiles[0].staleIds, []);
  assert.ok(scan.profiles[0].issues.some(i => i.includes('saved ID differs')));
  writeFileSync(f.file, JSON.stringify({ extensions: { settings: { [STORE_EXTENSION_ID]: { path: '/missing-extension', location: 1, from_webstore: true } } } }));
  scan = inspectExtensionProfiles([f.root]);
  assert.ok(scan.profiles[0].issues.some(i => i.includes('missing or unreadable')));
  assert.deepEqual(scan.profiles[0].staleIds, []);
  writeFileSync(f.file, '{incomplete');
  scan = inspectExtensionProfiles([f.root]);
  assert.equal(scan.errors.length, 1);
  assert.deepEqual(scan.profiles, []);
});
