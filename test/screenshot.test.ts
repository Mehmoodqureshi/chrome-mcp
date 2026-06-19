/**
 * planScreenshot — the pure clip/dimension math behind the extension's
 * chrome.debugger screenshot path (Phase 2). Verified without Chrome:
 * viewport (no clip), full-page (real capture + truncation at the ceiling),
 * and element clip.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planScreenshot, MAX_CAPTURE_PX, type PageDims } from '../shared/screenshot';

const DIMS: PageDims = { w: 1280, h: 720, fullW: 1280, fullH: 4000 };

test('viewport capture: no clip, reports viewport size, not truncated', () => {
  const p = planScreenshot(DIMS, {});
  assert.equal(p.clip, undefined);
  assert.equal(p.captureBeyondViewport, false);
  assert.equal(p.width, 1280);
  assert.equal(p.height, 720);
  assert.equal(p.truncated, false);
});

test('full-page capture: clips the whole content box, reports full height', () => {
  const p = planScreenshot(DIMS, { fullPage: true });
  assert.deepEqual(p.clip, { x: 0, y: 0, width: 1280, height: 4000, scale: 1 });
  assert.equal(p.captureBeyondViewport, true);
  assert.equal(p.height, 4000);
  assert.equal(p.truncated, false); // 4000 < ceiling
  assert.equal(p.fullHeight, 4000);
});

test('full-page taller than the ceiling is clamped and flagged truncated', () => {
  const tall: PageDims = { ...DIMS, fullH: MAX_CAPTURE_PX + 5000 };
  const p = planScreenshot(tall, { fullPage: true });
  assert.equal(p.clip?.height, MAX_CAPTURE_PX);
  assert.equal(p.height, MAX_CAPTURE_PX);
  assert.equal(p.truncated, true);
  assert.equal(p.fullHeight, MAX_CAPTURE_PX + 5000);
});

test('element capture: clips to the element box in document coords', () => {
  const p = planScreenshot(DIMS, { element: { x: 100, y: 1500, w: 300, h: 200 } });
  assert.deepEqual(p.clip, { x: 100, y: 1500, width: 300, height: 200, scale: 1 });
  assert.equal(p.captureBeyondViewport, true); // element may be below the fold
  assert.equal(p.width, 300);
  assert.equal(p.height, 200);
  assert.equal(p.truncated, false);
});

test('element wins over fullPage when both are set', () => {
  const p = planScreenshot(DIMS, { fullPage: true, element: { x: 0, y: 0, w: 50, h: 60 } });
  assert.equal(p.width, 50);
  assert.equal(p.height, 60);
});
