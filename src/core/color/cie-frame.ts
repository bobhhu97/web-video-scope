/**
 * Placement of a chromaticity diagram inside a rectangular canvas.
 *
 * A CIE xy diagram is only readable at 1:1 axis scale: x and y are the same kind
 * of quantity, so one unit of x must occupy the same number of pixels as one unit
 * of y. So the plot is letterboxed: pick the scale that fits both axes, then
 * centre the resulting box.
 *
 * Supports both default white-point-centred zoom and arbitrary cursor-anchored
 * pan/zoom via `(panX, panY)` representing the bottom-left chromaticity origin.
 */

/** Chromaticity bounds of the plot: [x0, y0, x1, y1]. */
export const CIE_BOUNDS: Record<'xy' | 'uv', readonly [number, number, number, number]> = {
  xy: [0, 0, 0.8, 0.9],
  uv: [0, 0, 0.62, 0.6],
};

/** D65 white point in each coordinate system; the default zoom anchor. */
export const WHITE_POINT: Record<'xy' | 'uv', readonly [number, number]> = {
  xy: [0.3127, 0.329],
  uv: [0.1978, 0.4683],
};

export interface CieFrame {
  /** Plot rect inside the canvas, in the canvas's own pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Equal for both axes by construction. */
  scale: number;
  /** Data bounds actually shown (differs from CIE_BOUNDS when zoomed). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Fit a chromaticity box into a canvas with equal axis scaling.
 *
 * When `panX`/`panY` are omitted or null, `zoom` magnifies around the D65 white
 * point. When provided, `(panX, panY)` sets the bottom-left `(x0, y0)` origin,
 * clamped inside `CIE_BOUNDS[coord]`.
 */
export function cieFrame(
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom = 1,
  panX?: number | null,
  panY?: number | null,
): CieFrame {
  const [bx0, by0, bx1, by1] = CIE_BOUNDS[coord];

  const z = Math.max(1, Math.min(16, zoom));
  const fullW = bx1 - bx0;
  const fullH = by1 - by0;
  const spanW = fullW / z;
  const spanH = fullH / z;

  const [wx, wy] = WHITE_POINT[coord];
  const reqX0 = panX != null && Number.isFinite(panX) ? panX : wx - spanW / 2;
  const reqY0 = panY != null && Number.isFinite(panY) ? panY : wy - spanH / 2;

  let x0 = Math.min(Math.max(reqX0, bx0), bx1 - spanW);
  let y0 = Math.min(Math.max(reqY0, by0), by1 - spanH);
  if (!Number.isFinite(x0)) x0 = bx0;
  if (!Number.isFinite(y0)) y0 = by0;
  const x1 = x0 + spanW;
  const y1 = y0 + spanH;

  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const safeW = Math.max(1, w);
  const safeH = Math.max(1, h);
  const scale = Math.min(safeW / spanX, safeH / spanY);

  const width = spanX * scale;
  const height = spanY * scale;

  return {
    left: (safeW - width) / 2,
    top: (safeH - height) / 2,
    width,
    height,
    scale,
    x0,
    y0,
    x1,
    y1,
  };
}

/** Chromaticity to canvas pixel, honouring the frame's equal axis scale. */
export function frameToScreen(f: CieFrame, x: number, y: number): [number, number] {
  return [f.left + (x - f.x0) * f.scale, f.top + f.height - (y - f.y0) * f.scale];
}

/** Canvas pixel back to chromaticity. Exact inverse of `frameToScreen`. */
export function screenToFrame(f: CieFrame, px: number, py: number): [number, number] {
  return [f.x0 + (px - f.left) / f.scale, f.y0 + (f.top + f.height - py) / f.scale];
}

/** Zoom around `(cursorX, cursorY)` so the chromaticity under the cursor stays stationary. */
export function zoomCieAt(
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom: number,
  panX: number | null | undefined,
  panY: number | null | undefined,
  nextZoom: number,
  cursorX: number,
  cursorY: number,
): { zoom: number; panX: number | null; panY: number | null } {
  const z1 = Math.max(1, Math.min(16, nextZoom));
  if (z1 <= 1.0001) return { zoom: 1, panX: null, panY: null };
  const before = cieFrame(w, h, coord, zoom, panX, panY);
  const [cx, cy] = screenToFrame(before, cursorX, cursorY);
  const afterShape = cieFrame(w, h, coord, z1, 0, 0);
  const rawX0 = cx - (cursorX - afterShape.left) / afterShape.scale;
  const rawY0 = cy - (afterShape.top + afterShape.height - cursorY) / afterShape.scale;
  const clamped = cieFrame(w, h, coord, z1, rawX0, rawY0);
  return { zoom: z1, panX: clamped.x0, panY: clamped.y0 };
}

/**
 * Padded CIE viewport frame used by UI graticule and GPU renderer.
 *
 * Uses the ENTIRE padded plot rectangle `[padL, padT, plotW, plotH]` at strict
 * 1:1 isotropic axis scale (`pxPerUnitX === pxPerUnitY === baseScale * zoom`),
 * so zooming and panning expand smoothly across the full panel width/height while
 * keeping axes, square grid cells, spectral locus, gamut triangles, and GPU scatter
 * 100% locked together without bleeding over axis labels or the top header bar.
 */
export function cieViewportFrame(
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom = 1,
  panX?: number | null,
  panY?: number | null,
  dpr = 1,
): CieFrame {
  const [bx0, by0, bx1, by1] = CIE_BOUNDS[coord];
  const s = Math.max(0.5, dpr);
  const safeW = Math.max(16 * s, w);
  const safeH = Math.max(16 * s, h);

  const padL = Math.min(30 * s, safeW * 0.15);
  const padR = Math.min(14 * s, safeW * 0.07);
  const padT = Math.min(24 * s, safeH * 0.14);
  const padB = Math.min(20 * s, safeH * 0.12);
  const plotW = Math.max(8 * s, safeW - padL - padR);
  const plotH = Math.max(8 * s, safeH - padT - padB);

  const z = Math.max(1, Math.min(16, zoom));
  const fullW = bx1 - bx0;
  const fullH = by1 - by0;

  const baseScale = Math.min(plotW / fullW, plotH / fullH);
  const scale = baseScale * z;
  const spanX = plotW / scale;
  const spanY = plotH / scale;

  // 1x centered span bounds so cursor-anchored zoom-in from 1x never hits a clamp wall
  const spanX1 = plotW / baseScale;
  const spanY1 = plotH / baseScale;
  const center1X0 = (bx0 + bx1) * 0.5 - spanX1 * 0.5;
  const center1Y0 = (by0 + by1) * 0.5 - spanY1 * 0.5;
  const minX0 = Math.min(bx0 - 0.05, center1X0);
  const maxX1 = Math.max(bx1 + 0.05, center1X0 + spanX1);
  const minY0 = Math.min(by0 - 0.05, center1Y0);
  const maxY1 = Math.max(by1 + 0.05, center1Y0 + spanY1);

  let reqX0: number;
  let reqY0: number;
  if (panX != null && Number.isFinite(panX) && panY != null && Number.isFinite(panY)) {
    reqX0 = panX;
    reqY0 = panY;
  } else if (z <= 1.0001) {
    reqX0 = center1X0;
    reqY0 = center1Y0;
  } else {
    const [wx, wy] = WHITE_POINT[coord];
    reqX0 = wx - spanX * 0.5;
    reqY0 = wy - spanY * 0.5;
  }

  let x0 = Math.min(Math.max(reqX0, minX0), maxX1 - spanX);
  let y0 = Math.min(Math.max(reqY0, minY0), maxY1 - spanY);
  if (!Number.isFinite(x0)) x0 = center1X0;
  if (!Number.isFinite(y0)) y0 = center1Y0;

  return {
    left: padL,
    top: padT,
    width: plotW,
    height: plotH,
    scale,
    x0,
    y0,
    x1: x0 + spanX,
    y1: y0 + spanY,
  };
}

/** Cursor-anchored zoom using the padded CIE viewport geometry. */
export function zoomCieViewportAt(
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom: number,
  panX: number | null | undefined,
  panY: number | null | undefined,
  nextZoom: number,
  cursorX: number,
  cursorY: number,
  dpr = 1,
): { zoom: number; panX: number | null; panY: number | null } {
  const z1 = Math.max(1, Math.min(16, nextZoom));
  if (z1 <= 1.0001) return { zoom: 1, panX: null, panY: null };
  const before = cieViewportFrame(w, h, coord, zoom, panX, panY, dpr);
  const ax = Math.min(before.left + before.width, Math.max(before.left, cursorX));
  const ay = Math.min(before.top + before.height, Math.max(before.top, cursorY));
  const [cx, cy] = screenToFrame(before, ax, ay);
  const afterShape = cieViewportFrame(w, h, coord, z1, 0, 0, dpr);
  const rawX0 = cx - (ax - afterShape.left) / afterShape.scale;
  const rawY0 = cy - (afterShape.top + afterShape.height - ay) / afterShape.scale;
  const clamped = cieViewportFrame(w, h, coord, z1, rawX0, rawY0, dpr);
  return { zoom: z1, panX: clamped.x0, panY: clamped.y0 };
}
