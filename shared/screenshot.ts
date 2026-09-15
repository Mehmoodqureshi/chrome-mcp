/**
 * shared/screenshot.ts — pure screenshot-planning logic, shared so it can be
 * unit-tested without Chrome and reused by the extension SW.
 *
 * Turns measured page dimensions (and an optional element rect) into the
 * `Page.captureScreenshot` clip + the logical dimensions/truncation flags the
 * `ScreenshotResult` reports. No chrome.* calls — just arithmetic.
 */

/** Measured page geometry, in CSS pixels. */
export interface PageDims {
  /** Viewport width/height. */
  w: number;
  h: number;
  /** Full content box (document) width/height. */
  fullW: number;
  fullH: number;
  /** window.devicePixelRatio (default 1). Output pixels = CSS px * dpr * clip.scale. */
  dpr?: number;
  /** Current scroll offset of the top document (default 0,0); a viewport clip starts here. */
  scrollX?: number;
  scrollY?: number;
}

export type ScreenshotFormat = 'png' | 'jpeg';

/** Default encoding: JPEG at this quality is ~5-10x smaller than PNG on a
 *  typical page and still perfectly legible to a vision model. */
export const DEFAULT_SCREENSHOT_FORMAT: ScreenshotFormat = 'jpeg';
export const DEFAULT_JPEG_QUALITY = 70;
/** Output size multiplier relative to CSS pixels. 1 = CSS px (so a Retina
 *  viewport is NOT captured at 2x); 2 = device px on a 2x display. */
export const DEFAULT_SCREENSHOT_SCALE = 1;

/** An element's box in DOCUMENT coordinates (viewport rect + scroll offset), CSS px. */
export interface ElementRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A CDP `Page.captureScreenshot` clip (CSS px; `scale` multiplies output). */
export interface CaptureClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface ScreenshotPlan {
  /** Omitted for a plain viewport capture (capture whatever is visible). */
  clip?: CaptureClip;
  /** Must be true whenever a clip reaches outside the current viewport. */
  captureBeyondViewport: boolean;
  /** Logical (CSS px) dimensions to report back in ScreenshotResult. */
  width: number;
  height: number;
  /** The capture was clamped below the real content/element height. */
  truncated: boolean;
  /** The true height when `truncated` (or for any fullPage/element capture). */
  fullHeight?: number;
}

/**
 * Practical single-capture height ceiling. Skia/CDP cannot encode arbitrarily
 * tall images; beyond this we clamp the clip and flag `truncated`.
 */
export const MAX_CAPTURE_PX = 16384;

/**
 * Plan a capture. Element clip wins over fullPage; fullPage wins over the plain
 * viewport capture. Heights are clamped to MAX_CAPTURE_PX with `truncated` set.
 */
export function planScreenshot(
  dims: PageDims,
  opts: { fullPage?: boolean; element?: ElementRect | null; scale?: number } = {},
): ScreenshotPlan {
  // CDP's clip.scale multiplies on top of the device scale factor, so dividing
  // by the DPR yields exactly `opts.scale` output pixels per CSS pixel.
  const dpr = dims.dpr && dims.dpr > 0 ? dims.dpr : 1;
  const scale = (opts.scale && opts.scale > 0 ? opts.scale : DEFAULT_SCREENSHOT_SCALE) / dpr;
  if (opts.element) {
    const realH = Math.max(1, Math.round(opts.element.h));
    const clipH = Math.min(opts.element.h, MAX_CAPTURE_PX);
    return {
      clip: { x: opts.element.x, y: opts.element.y, width: opts.element.w, height: clipH, scale },
      captureBeyondViewport: true,
      width: Math.max(1, Math.round(opts.element.w)),
      height: Math.min(realH, MAX_CAPTURE_PX),
      truncated: realH > MAX_CAPTURE_PX,
      fullHeight: realH,
    };
  }
  if (opts.fullPage) {
    const clipH = Math.min(dims.fullH, MAX_CAPTURE_PX);
    return {
      clip: { x: 0, y: 0, width: dims.fullW, height: clipH, scale },
      captureBeyondViewport: true,
      width: dims.fullW,
      height: clipH,
      truncated: dims.fullH > clipH,
      fullHeight: dims.fullH,
    };
  }
  // Plain viewport: capture what's visible. A clip is only needed to apply a
  // scale; at scale 1 on a 1x display the bare capture is identical and cheaper.
  return {
    ...(scale !== 1
      ? { clip: { x: dims.scrollX ?? 0, y: dims.scrollY ?? 0, width: dims.w, height: dims.h, scale } }
      : {}),
    captureBeyondViewport: false,
    width: dims.w,
    height: dims.h,
    truncated: false,
  };
}
