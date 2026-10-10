/**
 * extension/scripts/build-ext.mjs — bundle the SW, options and popup with esbuild and
 * assemble the load-unpacked root at <repo>/extension-dist.
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, '..');
const repoRoot = join(extRoot, '..');
const outDir = join(repoRoot, 'extension-dist');

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

// The unpacked build carries the Chrome Web Store copy's public key, so every
// copy (store or unpacked, on any machine) has the same id. That one id is what
// the one-click pairing helper allows. The store zip leaves it out (the store
// rejects a manifest with "key"); see pack-ext.mjs. A public key, not a secret.
const STORE_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnU/ZEDvOqegaznGSdMp4U69LsSZj18ZMdJdekRkCl4MGoQO09K3bXMFS4jxlWS6ZXlh4GLuM+BusovfLTaFDivzMoArAnsYzaB6aoi7mwihMdxRHZ/BgZ63SMwH2z2HQ9X32Lx+AS0de92aMx4NxyKcLZSP46jV+051Ch2xhMFBAOlby2R5mu7rRo2Bq68/aVYU2q4TQ2UN+uSi9aRlej/7DasVyqQ6OpC8iqcw1pS7nCCngNDAfzmAZcpgWjRE0kl+5cOZskK3bnScH+PscCstyGQ5d1D2x8H43dNYFVel4HyM46G4vegi38AUQs5ldriprqSleYpEI3yq1br/g4wIDAQAB';
const manifest = JSON.parse(readFileSync(join(extRoot, 'manifest.json'), 'utf8'));
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify({ ...manifest, key: STORE_PUBLIC_KEY }, null, 2)}\n`);
copyFileSync(join(extRoot, 'src/options/options.html'), join(outDir, 'options.html'));
copyFileSync(join(extRoot, 'src/popup/popup.html'), join(outDir, 'popup.html'));
// Icons sit flat in the root: the home-folder mirror copies top-level files only.
for (const f of readdirSync(join(extRoot, 'icons'))) {
  if (f.endsWith('.png')) copyFileSync(join(extRoot, 'icons', f), join(outDir, f));
}

console.log(`[build-ext] wrote ${outDir}`);
