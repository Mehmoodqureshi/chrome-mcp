/**
 * pickBorderColor / borderCss — the pure half of the tab border the extension
 * draws around tabs chrome-mcp is working in. Verified without Chrome.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORDER_BLUE,
  BORDER_BLUE_ON_DARK,
  borderCss,
  parseColor,
  pickBorderColor,
} from '../shared/tab-border';

test('no theme-color on a light page: blue', () => {
  assert.equal(pickBorderColor({ themeColor: '', background: '#ffffff', prefersDark: false }), BORDER_BLUE);
});

test('no theme-color on a dark page: the lighter blue', () => {
  assert.equal(pickBorderColor({ themeColor: '', background: '#0d1117', prefersDark: false }), BORDER_BLUE_ON_DARK);
});

test('transparent background falls back to prefers-color-scheme', () => {
  assert.equal(
    pickBorderColor({ themeColor: '', background: 'rgba(0, 0, 0, 0)', prefersDark: true }),
    BORDER_BLUE_ON_DARK,
  );
  assert.equal(pickBorderColor({ themeColor: '', background: '', prefersDark: false }), BORDER_BLUE);
});

test("the site's theme-color wins when it stands out from the page", () => {
  assert.equal(pickBorderColor({ themeColor: '#dc2626', background: '#ffffff', prefersDark: false }), '#dc2626');
  assert.equal(pickBorderColor({ themeColor: '#f59e0b', background: '#111111', prefersDark: true }), '#f59e0b');
});

test('a theme-color that blends into the page is ignored', () => {
  // White theme-color on a white page would be an invisible border.
  assert.equal(pickBorderColor({ themeColor: '#ffffff', background: '#ffffff', prefersDark: false }), BORDER_BLUE);
  assert.equal(pickBorderColor({ themeColor: '#161b22', background: '#0d1117', prefersDark: true }), BORDER_BLUE_ON_DARK);
});

test('translucent or unparseable theme-colors fall back to blue', () => {
  assert.equal(pickBorderColor({ themeColor: 'rgba(220, 38, 38, 0.5)', background: '#fff', prefersDark: false }), BORDER_BLUE);
  assert.equal(pickBorderColor({ themeColor: 'not-a-colour', background: '#fff', prefersDark: false }), BORDER_BLUE);
});

test('parseColor reads hex and rgb(a)', () => {
  assert.deepEqual(parseColor('#abc'), { r: 170, g: 187, b: 204, a: 1 });
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0)'), { r: 1, g: 2, b: 3, a: 0 });
  assert.equal(parseColor('red'), null);
});

test('borderCss draws a click-through fixed border and never interpolates a non-hex value', () => {
  const css = borderCss('#dc2626');
  assert.match(css, /^html::after\{/);
  assert.match(css, /border:3px solid #dc2626 !important/);
  assert.match(css, /pointer-events:none !important/);
  assert.match(css, /position:fixed !important/);
  assert.ok(!borderCss('red;}body{display:none').includes('display:none'));
  assert.match(borderCss('red;}body{display:none'), new RegExp(BORDER_BLUE));
});
