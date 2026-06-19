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
}

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
  opts: { fullPage?: boolean; element?: ElementRect | null } = {},
): ScreenshotPlan {
  if (opts.element) {
    const realH = Math.max(1, Math.round(opts.element.h));
    const clipH = Math.min(opts.element.h, MAX_CAPTURE_PX);
    return {
      clip: { x: opts.element.x, y: opts.element.y, width: opts.element.w, height: clipH, scale: 1 },
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
      clip: { x: 0, y: 0, width: dims.fullW, height: clipH, scale: 1 },
      captureBeyondViewport: true,
      width: dims.fullW,
      height: clipH,
      truncated: dims.fullH > clipH,
      fullHeight: dims.fullH,
    };
  }
  // Plain viewport: no clip, capture what's visible.
  return {
    captureBeyondViewport: false,
    width: dims.w,
    height: dims.h,
    truncated: false,
  };
}
