/**
 * Pure geometry/filename helpers for "save this scope as an image".
 *
 * Kept free of DOM/GPU/chrome so it can be unit-tested in node: the exporter
 * in `src/content/scope-controller.ts` feeds in the panel's CSS size and the
 * current GPU limits, and gets back the exact pixel size it is allowed to
 * allocate plus the ink palette it must draw the graticule with.
 */

import type { ScopeMode } from '../../gpu/scope-renderer';

/** File container written by the exporter. */
export type CaptureFormat = 'png' | 'jpeg' | 'webp';

/** What sits behind the signal. */
export type CaptureBackground = 'panel' | 'transparent' | 'white';

/** Resolution multiplier applied to the panel's CSS size. */
export type CaptureScale = 1 | 2 | 3 | 4 | 'match';

export interface CaptureSettings {
  format: CaptureFormat;
  scale: CaptureScale;
  background: CaptureBackground;
}

export const DEFAULT_CAPTURE: CaptureSettings = {
  format: 'png',
  scale: 2,
  background: 'transparent',
};

/** Grey used by the live panel; exports keep the same look when not transparent. */
export const PANEL_BG = '#0a0e12';
export const PAPER_BG = '#ffffff';

/** Multipliers offered in the settings sheet, in display order. */
export const CAPTURE_SCALE_OPTIONS: readonly CaptureScale[] = [1, 2, 3, 4, 'match'];

export interface CaptureLimits {
  /** `maxTextureDimension2D` of the device — no canvas edge may exceed it. */
  maxEdge: number;
  /** `maxStorageBufferBindingSize` — the density buffer is the real budget. */
  maxDensityBytes: number;
}

export interface CapturePlanRequest extends CaptureLimits {
  /** Panel size in CSS pixels. */
  cssWidth: number;
  cssHeight: number;
  /** Requested multiplier, or `'match'` to match the source video's width. */
  scale: CaptureScale;
  /** Source video width, used only by `'match'`. */
  sourceWidth?: number;
  mode: ScopeMode;
  /** Density planes the renderer will allocate for these options. */
  planes: number;
  /** Graticule gutter in CSS pixels; ignored by full-bleed modes. */
  wavePad: { top: number; right: number; bottom: number; left: number };
}

export interface CapturePlan {
  /** Logical (CSS pixel) size handed to `ScopeRenderer` as width/height. */
  cssWidth: number;
  cssHeight: number;
  /** Multiplier actually used — may be below the request when limits bite. */
  scale: number;
  /** Backing-store size, i.e. CSS size × scale. */
  width: number;
  height: number;
  /** True when the request had to be reduced to fit the device limits. */
  clamped: boolean;
  /** Requested multiplier before clamping (`'match'` resolved to a number). */
  requestedScale: number;
}

/** Vectorscope and CIE draw edge-to-edge; everything else reserves the gutter. */
function isFullBleed(mode: ScopeMode): boolean {
  return mode === 'vectorscope' || mode === 'cie';
}

function plotSize(
  req: CapturePlanRequest,
  width: number,
  height: number,
  scale: number,
): { w: number; h: number } {
  if (isFullBleed(req.mode)) return { w: Math.max(8, width), h: Math.max(8, height) };
  const padL = Math.round(req.wavePad.left * scale);
  const padR = Math.round(req.wavePad.right * scale);
  const padT = Math.round(req.wavePad.top * scale);
  const padB = Math.round(req.wavePad.bottom * scale);
  return {
    w: Math.max(8, width - padL - padR),
    h: Math.max(8, height - padT - padB),
  };
}

/** Density bytes the renderer asks for, mirroring `requiredDensityBytes()`. */
function densityBytes(req: CapturePlanRequest, width: number, height: number, scale: number): number {
  const { w, h } = plotSize(req, width, height, scale);
  if (req.mode === 'histogram') return Math.max(256, req.planes * w * 4);
  return Math.max(256, req.planes * w * h * 4);
}

/** Largest multiplier that still fits both the texture edge and the density buffer. */
function largestFittingScale(req: CapturePlanRequest, requested: number): number {
  const cssW = Math.max(1, req.cssWidth);
  const cssH = Math.max(1, req.cssHeight);
  const edgeCap = Math.min(req.maxEdge / cssW, req.maxEdge / cssH);
  let s = Math.min(requested, edgeCap);
  // Density grows with the square of the scale, so shrink geometrically and
  // then trim in 0.05 steps; three passes is plenty for the 0.05 grid.
  for (let pass = 0; pass < 3; pass += 1) {
    for (let guard = 0; guard < 200; guard += 1) {
      const width = Math.max(1, Math.round(cssW * s));
      const height = Math.max(1, Math.round(cssH * s));
      if (densityBytes(req, width, height, s) <= req.maxDensityBytes) return s;
      s = Math.max(0.05, s * 0.9);
      if (s <= 0.05) return 0.05;
    }
  }
  return Math.max(0.05, Math.min(s, 1));
}

/**
 * Resolve the requested multiplier into a concrete output size that the device
 * can actually allocate. Returns at least 1×1 so callers never build a
 * zero-sized canvas.
 */
export function planCapture(req: CapturePlanRequest): CapturePlan {
  const cssW = Math.max(1, req.cssWidth);
  const cssH = Math.max(1, req.cssHeight);
  const requested =
    req.scale === 'match'
      ? Math.max(0.1, (req.sourceWidth ?? cssW) / cssW)
      : req.scale;
  const scale = largestFittingScale({ ...req, cssWidth: cssW, cssHeight: cssH }, requested);
  const width = Math.max(1, Math.min(req.maxEdge, Math.round(cssW * scale)));
  const height = Math.max(1, Math.min(req.maxEdge, Math.round(cssH * scale)));
  return {
    cssWidth: cssW,
    cssHeight: cssH,
    scale,
    width,
    height,
    clamped: scale < requested - 1e-6,
    requestedScale: requested,
  };
}

/**
 * Transparent pixels cannot be stored in JPEG, so the request is downgraded to
 * white paper rather than silently producing a black plate.
 */
export function effectiveBackground(
  format: CaptureFormat,
  background: CaptureBackground,
): CaptureBackground {
  return format === 'jpeg' && background === 'transparent' ? 'white' : background;
}

/**
 * Ink palette the graticule must use for this background. Dark ink on
 * transparent/white, panel grey on the dark plate.
 */
export function graticuleThemeFor(background: CaptureBackground): 'dark' | 'light' {
  return background === 'panel' ? 'dark' : 'light';
}

/** File extension, and MIME type, for a format. */
export function formatInfo(format: CaptureFormat): { mime: string; ext: string; quality?: number } {
  switch (format) {
    case 'jpeg':
      return { mime: 'image/jpeg', ext: 'jpg', quality: 0.92 };
    case 'webp':
      return { mime: 'image/webp', ext: 'webp', quality: 0.95 };
    default:
      return { mime: 'image/png', ext: 'png' };
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Deterministic file name: scope kind, mode, and a sortable local timestamp.
 * `2026-01-02 03:04:05` becomes `20260102-030405`, so a folder of exports
 * stays in capture order.
 */
export function captureFileName(mode: ScopeMode, at: Date, format: CaptureFormat): string {
  const stamp =
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
  return `scope-${mode}-${stamp}.${formatInfo(format).ext}`;
}

/** Human-readable size, e.g. `3840 × 2160`. */
export function describeSize(width: number, height: number): string {
  return `${width} × ${height}`;
}
