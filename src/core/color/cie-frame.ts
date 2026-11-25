/**
 * Placement of a chromaticity diagram inside a rectangular canvas.
 *
 * A CIE xy diagram is only readable at 1:1 axis scale: x and y are the same kind
 * of quantity, so one unit of x must occupy the same number of pixels as one unit
 * of y. Stretching the data bounds to fill whatever aspect ratio a panel happens
 * to have squashes the horseshoe — measured at 1.86x anisotropy in a wide panel,
 * i.e. 86% wider than it should be, which is not a subtle distortion.
 *
 * So the plot is letterboxed: pick the scale that fits both axes, then centre the
 * resulting box. Panels of any size or shape get a correctly proportioned
 * diagram, with unused margin instead of distortion.
 *
 * This module is the single source of truth for both the graticule (which draws
 * the locus) and the scatter renderer (which plots the data). They used to keep
 * separate copies of CIE_BOUNDS, so any change to one silently misaligned the
 * other.
 */

/** Chromaticity bounds of the plot: [x0, y0, x1, y1]. */
export const CIE_BOUNDS: Record<'xy' | 'uv', readonly [number, number, number, number]> = {
  xy: [0, 0, 0.8, 0.9],
  uv: [0, 0, 0.62, 0.6],
};

/** D65 white point in each coordinate system; the zoom anchor. */
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
 * `zoom` magnifies around the white point, clamped so the view never leaves the
 * published bounds — showing empty space beyond 0.8 would suggest chromaticities
 * exist there.
 */
export function cieFrame(
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom = 1,
): CieFrame {
  const [bx0, by0, bx1, by1] = CIE_BOUNDS[coord];

  const z = Math.max(1, Math.min(16, zoom));
  const fullW = bx1 - bx0;
  const fullH = by1 - by0;
  const spanW = fullW / z;
  const spanH = fullH / z;

  // Centre the zoomed view on the white point, then keep it inside the bounds.
  const [wx, wy] = WHITE_POINT[coord];
  let x0 = Math.min(Math.max(wx - spanW / 2, bx0), bx1 - spanW);
  let y0 = Math.min(Math.max(wy - spanH / 2, by0), by1 - spanH);
  if (!Number.isFinite(x0)) x0 = bx0;
  if (!Number.isFinite(y0)) y0 = by0;
  const x1 = x0 + spanW;
  const y1 = y0 + spanH;

  const spanX = x1 - x0;
  const spanY = y1 - y0;
  const safeW = Math.max(1, w);
  const safeH = Math.max(1, h);
  // The one number that must be shared by both axes.
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
