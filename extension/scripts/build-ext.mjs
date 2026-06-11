/**
 * extension/scripts/build-ext.mjs — bundle the SW + options with esbuild and
 * assemble the load-unpacked root at <repo>/extension-dist.
 */
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
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
  },
  outdir: outDir,
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  platform: 'browser',
  legalComments: 'none',
});

copyFileSync(join(extRoot, 'manifest.json'), join(outDir, 'manifest.json'));
copyFileSync(join(extRoot, 'src/options/options.html'), join(outDir, 'options.html'));

console.log(`[build-ext] wrote ${outDir}`);
