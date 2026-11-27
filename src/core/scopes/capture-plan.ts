/**
 * Pure geometry/filename helpers for "save this scope as an image".
 *
 * Kept free of DOM/GPU/chrome so it can be unit-tested in node: the exporter
 * in `src/content/scope-controller.ts` feeds in the panel's CSS size and the
 * current GPU limits, and gets back the exact pixel size it is allowed to
 * allocate plus the ink palette it must draw the graticule with.
 */

import type { ScopeMode } from '../../gpu/scope-renderer';

/**
 * Grid shape an export lays the cells out in, as `columns × rows`.
 *
 * Deliberately not the HUD's `Layout` union: `src/core` must not depend on
 * `src/ui`. Every sheet mirrors the arrangement the user sees on screen, so a
 * three-panel layout exports as a 1×3 vertical stack.
 */
export type CaptureGrid = 'single' | 'pair' | 'triple' | 'grid';

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
export const PANEL_BG = '#0c1016';
/**
 * Gutter colour between cells, matching the live `.grid` background. A sheet
 * export paints this first and then fills each tile with `PANEL_BG`, so the
 * seams read the same as the on-screen layout.
 */
export const GRID_BG = '#06090c';
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

/**
 * Brightness compensation for exports rendered above the panel's own pixel
 * density.
 *
 * The scope's phosphor model treats every density cell as one phosphor dot: a
 * sample writes into one or two adjacent rows regardless of how tall the plot
 * is. Rendering the same signal into a taller raster therefore spreads the
 * trace over more cells and each cell receives less energy, so a 4× export
 * reads visibly dimmer than the panel it came from — where the panel at scale
 * 2× on a 2×-dpr display is pixel-identical to a 2× export.
 *
 * Exports only need to look like the panel, so we lift the phosphor gain by the
 * ratio between the export multiplier and the panel's device-pixel ratio.
 * `sourceDpr` is the live panel's `devicePixelRatio`; when it is unknown we
 * assume the export already matches and apply no compensation.
 */
export function exportDensityGain(scale: number, sourceDpr: number | undefined): number {
  if (!sourceDpr || !Number.isFinite(sourceDpr) || sourceDpr <= 0) return 1;
  const ratio = scale / sourceDpr;
  if (!Number.isFinite(ratio) || ratio <= 1.02) return 1;
  return Math.min(2.2, Math.pow(ratio, 0.6));
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

/** Columns and rows a capture grid lays out, in reading order. */
export function captureGridShape(grid: CaptureGrid): { cols: number; rows: number; cells: number } {
  switch (grid) {
    case 'pair':
      return { cols: 2, rows: 1, cells: 2 };
    case 'triple':
      // Matches the on-screen 1×3 stack so the sheet reads like the panel.
      return { cols: 1, rows: 3, cells: 3 };
    case 'grid':
      return { cols: 2, rows: 2, cells: 4 };
    default:
      return { cols: 1, rows: 1, cells: 1 };
  }
}

/** Layout of one cell inside a multi-cell export, in output pixels. */
export interface CaptureCell {
  slot: number;
  /** Top-left corner in output pixels. */
  x: number;
  y: number;
  /** Cell size in output pixels (already multiplied). */
  width: number;
  height: number;
  /** Cell size in CSS pixels — handed to `ScopeRenderer` as width/height. */
  cssWidth: number;
  cssHeight: number;
}

export interface CaptureLayoutPlan extends CapturePlan {
  cols: number;
  rows: number;
  cells: CaptureCell[];
}

export interface CaptureLayoutRequest {
  limits: CaptureLimits;
  /** Slot numbers to export, in reading order (row-major). */
  slots: number[];
  grid: CaptureGrid;
  /** Per-cell panel size in CSS pixels, indexed the same as `slots`. */
  cells: { cssWidth: number; cssHeight: number; mode: ScopeMode; planes: number }[];
  scale: CaptureScale;
  sourceWidth?: number;
  wavePad: { top: number; right: number; bottom: number; left: number };
  /** Gutter between cells, in CSS pixels of a single cell. */
  gap: number;
}

/**
 * Plan a whole-layout export: every cell rendered at the same multiplier, laid
 * out on a shared grid, with one gutter colour behind them.
 *
 * The multiplier is a single number for the whole sheet, so the cells keep
 * their relative sizes and the gutters stay uniform. It is clamped by the
 * tightest cell — one 4K-capable cell must not make a 4-up sheet exceed the
 * device limits elsewhere.
 */
export function planCaptureLayout(req: CaptureLayoutRequest): CaptureLayoutPlan {
  const shape = captureGridShape(req.grid);
  const n = Math.min(shape.cells, req.slots.length, req.cells.length);

  if (n === 0) {
    return {
      ...planCapture({
        ...req.limits,
        cssWidth: 1,
        cssHeight: 1,
        scale: req.scale,
        mode: 'waveform-luma',
        planes: 1,
        wavePad: req.wavePad,
      }),
      cols: shape.cols,
      rows: shape.rows,
      cells: [],
    };
  }

  const taken = req.cells.slice(0, n);

  // Each cell would fit on its own; the sheet is limited by whichever cell
  // forces the tile size to shrink first, so clamp against the worst one.
  let scale = Infinity;
  for (const cell of taken) {
    const one = planCapture({
      ...req.limits,
      cssWidth: cell.cssWidth,
      cssHeight: cell.cssHeight,
      scale: req.scale,
      sourceWidth: req.sourceWidth,
      mode: cell.mode,
      planes: cell.planes,
      wavePad: req.wavePad,
    });
    scale = Math.min(scale, one.scale);
  }
  if (!Number.isFinite(scale)) scale = 1;
  scale = Math.max(0.05, scale);

  const first = taken[0]!;
  const requested =
    req.scale === 'match'
      ? Math.max(0.1, (req.sourceWidth ?? first.cssWidth) / first.cssWidth)
      : (req.scale as number);

  // Uniform tile in CSS pixels: the largest cell drives the tile so no cell is
  // letterboxed; smaller cells centre inside it.
  const tileCssW = Math.max(...taken.map((c) => c.cssWidth));
  const tileCssH = Math.max(...taken.map((c) => c.cssHeight));
  const gapPx = Math.max(0, Math.round(req.gap * scale));

  const totalW = shape.cols * Math.round(tileCssW * scale) + gapPx * (shape.cols + 1);
  const totalH = shape.rows * Math.round(tileCssH * scale) + gapPx * (shape.rows + 1);

  // Re-check the assembled sheet against the edge limit: rounding and the
  // gutters can push a 4-cell sheet past `maxEdge` even when each cell fits.
  const edgeFit = Math.min(1, req.limits.maxEdge / Math.max(1, totalW), req.limits.maxEdge / Math.max(1, totalH));
  if (edgeFit < 1) {
    scale = Math.max(0.05, scale * edgeFit * 0.98);
  }

  const cellW = Math.max(1, Math.round(tileCssW * scale));
  const cellH = Math.max(1, Math.round(tileCssH * scale));
  const finalGap = Math.max(0, Math.round(req.gap * scale));
  const width = Math.max(1, Math.min(req.limits.maxEdge, shape.cols * cellW + finalGap * (shape.cols + 1)));
  const height = Math.max(1, Math.min(req.limits.maxEdge, shape.rows * cellH + finalGap * (shape.rows + 1)));

  const cells: CaptureCell[] = taken.map((cell, i) => {
    const col = i % shape.cols;
    const row = Math.floor(i / shape.cols);
    const cw = Math.max(1, Math.round(cell.cssWidth * scale));
    const ch = Math.max(1, Math.round(cell.cssHeight * scale));
    // Centre a smaller cell inside its tile.
    const x = finalGap + col * (cellW + finalGap) + Math.floor((cellW - cw) / 2);
    const y = finalGap + row * (cellH + finalGap) + Math.floor((cellH - ch) / 2);
    return {
      slot: req.slots[i]!,
      x,
      y,
      width: cw,
      height: ch,
      cssWidth: cell.cssWidth,
      cssHeight: cell.cssHeight,
    };
  });

  return {
    cssWidth: tileCssW,
    cssHeight: tileCssH,
    scale,
    width,
    height,
    clamped: scale < requested - 1e-6,
    requestedScale: requested,
    cols: shape.cols,
    rows: shape.rows,
    cells,
  };
}

/** File name for a whole-sheet export, e.g. `scopes-grid-20260102-030405.png`. */
export function captureSheetFileName(grid: CaptureGrid, at: Date, format: CaptureFormat): string {
  const stamp =
    `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}` +
    `-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`;
  return `scopes-${grid}-${stamp}.${formatInfo(format).ext}`;
}
