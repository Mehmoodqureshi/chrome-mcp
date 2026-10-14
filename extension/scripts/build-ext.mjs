/**
 * extension/scripts/build-ext.mjs — bundle the SW, options and popup with esbuild and
 * assemble the load-unpacked root at <repo>/extension-dist.
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, '..');
const repoRoot = join(extRoot, '..');
const outDir = join(repoRoot, 'extension-dist');
const manifestPath = join(outDir, 'manifest.json');
// A developer may have loaded this directory before builds acquired a fixed
// key. Keep that install's identity, including a path-derived (keyless) ID.
const hadManifest = existsSync(manifestPath);
const previousManifest = hadManifest ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
if (hadManifest && (!previousManifest || Array.isArray(previousManifest) || typeof previousManifest.version !== 'string' ||
    (previousManifest.key !== undefined && (typeof previousManifest.key !== 'string' || !previousManifest.key.trim())))) {
  throw new Error('Existing extension-dist/manifest.json is invalid; refusing to overwrite its identity.');
}

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: {
    background: join(extRoot, 'src/sw/background.ts'),
    options: join(extRoot, 'src/options/options.ts'),
    popup: join(extRoot, 'src/popup/popup.ts'),
    // MAIN-world observer hook, registered as a document_start content script
    // (and injected on demand as a fallback) — must be its own file.
    'page-hook': join(extRoot, 'src/page/hook.ts'),
  },
  outdir: outDir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  platform: 'browser',
  legalComments: 'none',
});

// Fresh unpacked builds carry the Chrome Web Store copy's public key. That ID is what
// the one-click pairing helper allows. The store zip leaves it out (the store
// rejects a manifest with "key"); see pack-ext.mjs. A public key, not a secret.
const STORE_PUBLIC_KEY = readFileSync(join(extRoot, 'store-public-key.txt'), 'utf8').trim();
const manifest = JSON.parse(readFileSync(join(extRoot, 'manifest.json'), 'utf8'));
if (previousManifest) {
  if (previousManifest.key !== undefined) manifest.key = previousManifest.key;
  else delete manifest.key;
} else {
  manifest.key = STORE_PUBLIC_KEY;
}
copyFileSync(join(extRoot, 'src/options/options.html'), join(outDir, 'options.html'));
copyFileSync(join(extRoot, 'src/popup/popup.html'), join(outDir, 'popup.html'));
// Icons sit flat in the root: the home-folder mirror copies top-level files only.
for (const f of readdirSync(join(extRoot, 'icons'))) {
  if (f.endsWith('.png')) copyFileSync(join(extRoot, 'icons', f), join(outDir, f));
}
// The service worker watches the manifest's version to reload. Publish it only
// after every file is ready, with one rename rather than truncating it in place.
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
renameSync(temporaryManifest, manifestPath);

console.log(`[build-ext] wrote ${outDir}`);
