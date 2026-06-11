/** Phase 5 — download-name hardening. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeDownloadName, isWithinSizeCap, MAX_DOWNLOAD_BYTES } from '../shared/download';

test('keeps a benign name', () => {
  assert.equal(sanitizeDownloadName('report-2026.pdf'), 'report-2026.pdf');
});

test('strips path separators and traversal', () => {
  const n = sanitizeDownloadName('../../etc/passwd');
  assert.ok(!n.includes('/'));
  assert.ok(!n.includes('\\'));
  assert.ok(!n.includes('..'));
  assert.ok(!n.startsWith('.'));
});

test('neutralizes dangerous executable extensions', () => {
  assert.equal(sanitizeDownloadName('evil.exe'), 'evil.download');
  assert.equal(sanitizeDownloadName('payload.sh'), 'payload.download');
  assert.equal(sanitizeDownloadName('macro.js'), 'macro.download');
});

test('empty / undefined → default', () => {
  assert.equal(sanitizeDownloadName(undefined), 'download');
  assert.equal(sanitizeDownloadName('   '), 'download');
  assert.equal(sanitizeDownloadName('...'), 'download');
});

test('caps length while preserving a safe extension', () => {
  const long = 'a'.repeat(400) + '.pdf';
  const out = sanitizeDownloadName(long);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith('.pdf'));
});

test('size cap', () => {
  assert.ok(isWithinSizeCap(1024));
  assert.ok(isWithinSizeCap(MAX_DOWNLOAD_BYTES));
  assert.ok(!isWithinSizeCap(MAX_DOWNLOAD_BYTES + 1));
});
