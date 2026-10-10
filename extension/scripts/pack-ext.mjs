/**
 * extension/scripts/pack-ext.mjs — the Chrome Web Store zip.
 *
 * Zips extension-dist without `pairing.json`, dotfiles, and the manifest's
 * `key`: the unpacked build carries the store's public key (so every copy
 * shares one id), but the store rejects an upload whose manifest has one.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(repoRoot, 'extension-dist');
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const out = join(repoRoot, `chrome-mcp-extension-${version}.zip`);

const stage = mkdtempSync(join(tmpdir(), 'mcp-ext-pack-'));
try {
  cpSync(dist, stage, { recursive: true, filter: (src) => !src.endsWith('pairing.json') });
  const manifestPath = join(stage, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.key;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-q', '-r', out, '.', '-x', '.*'], { cwd: stage });
  console.log(`[pack-ext] wrote ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
