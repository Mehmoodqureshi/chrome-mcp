/**
 * shared/tab-border.ts — the pure half of the "chrome-mcp is working here"
 * border: choosing its colour from the page's theme and writing the CSS.
 *
 * The extension paints the border with `chrome.scripting.insertCSS` on
 * `html::after`, a user stylesheet rather than a DOM node, so get_html,
 * get_text and snapshot never see it. Kept free of chrome.* so it is tested
 * in plain Node.
 */

/** Default border colour on a light page. */
export const BORDER_BLUE = '#2563eb';
/** Default border colour on a dark page (the light blue stays visible). */
export const BORDER_BLUE_ON_DARK = '#60a5fa';

/** What the page reports about its theme; colours already normalised by a
 *  canvas `fillStyle` round-trip to `#rrggbb` or `rgba(r, g, b, a)`. */
export interface PageTheme {
  /** The matching `<meta name="theme-color">`, or '' when the page has none. */
  themeColor: string;
  /** The effective page background (body, else html), or ''. */
  background: string;
  /** `prefers-color-scheme: dark`, used when the background is transparent. */
  prefersDark: boolean;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parse `#rgb`, `#rrggbb` or `rgb(a)(...)`; anything else is null. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(v);
  if (m) {
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
  }
  return null;
}

function luminance({ r, g, b }: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const toHex = ({ r, g, b }: Rgb): string =>
  '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');

/** A border has to stand out from the page to be worth drawing. */
const MIN_CONTRAST = 2;

/**
 * Pick the border colour for a page:
 *   1. the site's own theme-color, when it is opaque and stands out from the
 *      background (so the border matches the site),
 *   2. otherwise blue, the lighter blue on a dark page.
 */
export function pickBorderColor(theme: PageTheme): string {
  const bg = parseColor(theme.background);
  const opaqueBg = bg && bg.a > 0 ? bg : null;
  const dark = opaqueBg ? luminance(opaqueBg) < 0.2 : theme.prefersDark;
  const fallback = dark ? BORDER_BLUE_ON_DARK : BORDER_BLUE;

  const tc = parseColor(theme.themeColor);
  if (!tc || tc.a < 1) return fallback;
  const against = opaqueBg ?? (dark ? { r: 0, g: 0, b: 0, a: 1 } : { r: 255, g: 255, b: 255, a: 1 });
  return contrast(tc, against) >= MIN_CONTRAST ? toHex(tc) : fallback;
}

/** The user stylesheet that draws the border. Only `color` varies, and it is
 *  always a `#rrggbb` from pickBorderColor or a constant above. */
export function borderCss(color: string): string {
  const c = /^#[0-9a-f]{6}$/i.test(color) ? color : BORDER_BLUE;
  return (
    'html::after{content:"" !important;display:block !important;position:fixed !important;' +
    'inset:0 !important;box-sizing:border-box !important;' +
    `border:3px solid ${c} !important;box-shadow:inset 0 0 12px ${c}66 !important;` +
    'pointer-events:none !important;z-index:2147483647 !important;}'
  );
}
