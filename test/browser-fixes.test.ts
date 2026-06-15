/**
 * Browser-gated verification (skipped when Chromium isn't installed) for the two
 * fixes whose behavior only exists against a live page:
 *   FIX 4  — an element-triggered download whose save fails surfaces
 *            DOWNLOAD_FAILED instead of a phantom 0-byte success.
 *   FIX 11/12 — snapshot() descends into open shadow roots AND excludes elements
 *            sitting under a display:none ancestor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { CdpExecutor } from '../src/executor/cdp-executor';
import { ExecutorError } from '../src/executor/types';
import { sanitizeDownloadName } from '../shared/download';

let hasChromium = false;
try {
  hasChromium = existsSync(chromium.executablePath());
} catch {
  hasChromium = false;
}

test('FIX 4: an element download whose save fails surfaces DOWNLOAD_FAILED', { skip: !hasChromium }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'cmcp-dlprofile-'));
  const dlDir = mkdtempSync(join(tmpdir(), 'cmcp-dl-'));
  const ex = new CdpExecutor({ mode: 'launch', userDataDir: profile, headless: true, downloadDir: dlDir });
  try {
    await ex.ensureReady();
    // A page whose link triggers a real download ("ABCDEF").
    const href = 'data:application/octet-stream;base64,QUJDREVG';
    await ex.navigate({ url: `data:text/html,<a id="d" download="x.bin" href="${href}">dl</a>` });
    // Force the save to fail deterministically: pre-create a DIRECTORY at the dest
    // path so writing the file over it throws — exercising FIX 4's try/catch.
    const dest = join(dlDir, sanitizeDownloadName('x.bin'));
    mkdirSync(dest);
    await assert.rejects(
      ex.download({ target: { selector: '#d' }, suggestedName: 'x.bin' }),
      (e: unknown) => e instanceof ExecutorError && e.code === 'DOWNLOAD_FAILED',
    );
  } finally {
    await ex.dispose();
  }
});

test('FIX 11/12: snapshot finds shadow-DOM controls and drops hidden-ancestor ones', { skip: !hasChromium }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'cmcp-snapprofile-'));
  const ex = new CdpExecutor({ mode: 'launch', userDataDir: profile, headless: true });
  try {
    await ex.ensureReady();
    const html = `
      <div id="host"></div>
      <div style="display:none"><button>HiddenButton</button></div>
      <button>VisibleButton</button>
      <script>
        const r = document.getElementById('host').attachShadow({ mode: 'open' });
        r.innerHTML = '<button>ShadowButton</button>';
      </script>`;
    await ex.navigate({ url: 'data:text/html,' + encodeURIComponent(html) });
    const snap = await ex.snapshot({ interactiveOnly: true });
    const names = snap.nodes.map((n) => n.name);
    assert.ok(names.includes('ShadowButton'), 'shadow-DOM button must be collected (FIX 11)');
    assert.ok(names.includes('VisibleButton'), 'visible light-DOM button must be collected');
    assert.ok(!names.includes('HiddenButton'), 'button under display:none ancestor must be excluded (FIX 12)');
  } finally {
    await ex.dispose();
  }
});
