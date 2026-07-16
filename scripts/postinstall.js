/**
 * postinstall — install the Chromium that the CDP fallback needs.
 *
 * Skip-guarded and never fatal: a failure here must not break `npm install`
 * (the extension path needs no browser, and CI rarely wants the download).
 * Skips when:
 *   - CHROME_MCP_SKIP_BROWSER_DOWNLOAD / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set,
 *   - CI is set,
 *   - playwright is not installed yet (it is added in phase 3).
 */
'use strict';

function shouldSkip() {
  return (
    process.env.CHROME_MCP_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.CI === 'true' ||
    process.env.CI === '1'
  );
}

function hasPlaywright() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (shouldSkip()) {
    process.stdout.write('[postinstall] skipping Chromium download (guard set).\n');
    return;
  }
  if (!hasPlaywright()) {
    process.stdout.write('[postinstall] playwright not installed; CDP fallback unavailable until phase 3.\n');
    return;
  }
  try {
    const { execFileSync } = require('node:child_process');
    const { dirname, join } = require('node:path');
    // Drive Playwright's CLI through node rather than the `npx`/`playwright` bin
    // shim: on Windows those are .cmd files, which execFileSync cannot spawn
    // without a shell. `cli.js` is playwright's own bin target; resolving it via
    // package.json avoids the exports map, which exposes no './cli' subpath.
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  } catch (err) {
    process.stdout.write(
      `[postinstall] Chromium install skipped (non-fatal): ${err && err.message ? err.message : err}\n`,
    );
  }
}

main();
