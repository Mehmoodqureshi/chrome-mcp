import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionIdFromKey } from '../src/extension-repair';
import { STORE_EXTENSION_ID } from '../shared/protocol';

test('the actual extension build preserves legacy IDs and gives fresh builds the store ID', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-build-identity-'));
  try {
    cpSync(join(process.cwd(), 'extension'), join(dir, 'extension'), { recursive: true });
    cpSync(join(process.cwd(), 'shared'), join(dir, 'shared'), { recursive: true });
    cpSync(join(process.cwd(), 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'junction');
    mkdirSync(join(dir, 'extension-dist'));
    const manifestPath = join(dir, 'extension-dist/manifest.json');
    const build = () => execFileSync(process.execPath, [join(dir, 'extension/scripts/build-ext.mjs')], { cwd: dir, stdio: 'pipe' });
    writeFileSync(manifestPath, JSON.stringify({ manifest_version: 3, name: 'legacy', version: '0.0.1' }));
    const pairingPath = join(dir, 'extension-dist/pairing.json');
    writeFileSync(pairingPath, '{"profile":"keep-local-pairing"}');
    mkdirSync(join(dir, 'dist'));
    execSync('npm run clean', { cwd: dir, stdio: 'pipe' });
    assert.equal(existsSync(join(dir, 'dist')), false, 'clean removes server build output');
    build();
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).key, undefined, 'clean and rebuild must preserve keyless identity');
    assert.equal(readFileSync(pairingPath, 'utf8'), '{"profile":"keep-local-pairing"}');
    rmSync(join(dir, 'extension-dist'), { recursive: true });
    build();
    const fresh = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(extensionIdFromKey(fresh.key), STORE_EXTENSION_ID);
    build();
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).key, fresh.key);
    writeFileSync(manifestPath, 'null');
    assert.throws(build, /invalid/);
    assert.equal(readFileSync(manifestPath, 'utf8'), 'null', 'malformed existing identity must not be replaced');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
