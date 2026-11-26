/**
 * Shared placement of the vectorscope disc inside a rectangular canvas.
 *
 * Like `cie-frame.ts`, both the 2D graticule (in CSS pixels) and the GPU/CPU
 * scatter renderers (in device pixels) derive every coordinate from this frame.
 *
 * All dimensions scale strictly linearly with `(w, h)` (no fixed-pixel clamps)
 * so `vectorscopeFrame(w * dpr, h * dpr, zoom, panCb, panCr)` is an exact `dpr`
 * multiple of `vectorscopeFrame(w, h, zoom, panCb, panCr)`.
 */

/**
 * Chroma radius represented by the outer circle at `zoom = 1`.
 *
 * Component video defines Cb, Cr in [-0.5, +0.5], so 100% saturated corners
 * exceed 0.5 Euclidean radius: BT.709 100% Green/Magenta sit at hypot = 0.5957,
 * Red/Cyan at 0.5130. Setting the outer ring to 0.62 keeps all six 100% target
 * boxes inside the circle instead of clipping four of them off.
 */
export const VECTORSCOPE_FULL_SCALE = 0.62;

/** Disc radius as a fraction of the short canvas edge (leaves a 5% margin). */
const DISC_RADIUS_FRAC = 0.45;

export interface VectorscopeFrame {
  /** Chroma (0, 0) origin in canvas pixels (moves when panned). */
  cx: number;
  cy: number;
  /** Fixed viewport disc centre in canvas pixels (stationary bezel). */
  discCx: number;
  discCy: number;
  /** Viewport disc radius in canvas pixels (stays fixed on screen when zooming). */
  radius: number;
  /** Pixels per unit of Cb / Cr, incorporating `zoom`. */
  scale: number;
  /** Clamped zoom factor (>= 1). */
  zoom: number;
  /** Clamped chroma centre offset in Cb/Cr units. */
  panCb: number;
  panCr: number;
}

export function clampVectorscopePan(zoom: number, panCb: number, panCr: number): [number, number] {
  const z = Math.max(1, Math.min(16, zoom));
  const maxPan = VECTORSCOPE_FULL_SCALE * (1 - 1 / z);
  if (maxPan <= 1e-6) return [0, 0];
  return [
    Math.min(maxPan, Math.max(-maxPan, Number.isFinite(panCb) ? panCb : 0)),
    Math.min(maxPan, Math.max(-maxPan, Number.isFinite(panCr) ? panCr : 0)),
  ];
}

export function vectorscopeFrame(
  w: number,
  h: number,
  zoom = 1,
  panCb = 0,
  panCr = 0,
): VectorscopeFrame {
  const safeW = Math.max(1, w);
  const safeH = Math.max(1, h);
  const z = Math.max(1, Math.min(16, zoom));
  const radius = Math.min(safeW, safeH) * DISC_RADIUS_FRAC;
  const scale = (radius / VECTORSCOPE_FULL_SCALE) * z;
  const [cCb, cCr] = clampVectorscopePan(z, panCb, panCr);
  const discCx = safeW / 2;
  const discCy = safeH / 2;
  return {
    cx: discCx - cCb * scale,
    cy: discCy + cCr * scale,
    discCx,
    discCy,
    radius,
    scale,
    zoom: z,
    panCb: cCb,
    panCr: cCr,
  };
}

/** Map component chroma (Cb, Cr) to canvas pixel coordinates. */
export function vectorscopeToScreen(
  f: VectorscopeFrame,
  cb: number,
  cr: number,
): [number, number] {
  return [f.cx + cb * f.scale, f.cy - cr * f.scale];
}

/** Exact inverse of `vectorscopeToScreen`. */
export function screenToVectorscope(
  f: VectorscopeFrame,
  px: number,
  py: number,
): [number, number] {
  return [(px - f.cx) / f.scale, (f.cy - py) / f.scale];
}

/** True when `(px, py)` lies within the circular scope bezel (plus optional tolerance). */
export function insideVectorscopeDisc(
  f: VectorscopeFrame,
  px: number,
  py: number,
  tolerance = 0,
): boolean {
  return Math.hypot(px - f.discCx, py - f.discCy) <= f.radius + tolerance;
}

/** Zoom around `(cursorX, cursorY)` so the chroma point under the cursor stays stationary. */
export function zoomVectorscopeAt(
  w: number,
  h: number,
  zoom: number,
  panCb: number,
  panCr: number,
  nextZoom: number,
  cursorX: number,
  cursorY: number,
): { zoom: number; panCb: number; panCr: number } {
  const z1 = Math.max(1, Math.min(16, nextZoom));
  if (z1 <= 1.0001) return { zoom: 1, panCb: 0, panCr: 0 };
  const before = vectorscopeFrame(w, h, zoom, panCb, panCr);
  const [cbUnder, crUnder] = screenToVectorscope(before, cursorX, cursorY);
  const afterUnpanned = vectorscopeFrame(w, h, z1, 0, 0);
  const rawPanCb = cbUnder - (cursorX - afterUnpanned.discCx) / afterUnpanned.scale;
  const rawPanCr = crUnder - (afterUnpanned.discCy - cursorY) / afterUnpanned.scale;
  const [cCb, cCr] = clampVectorscopePan(z1, rawPanCb, rawPanCr);
  return { zoom: z1, panCb: cCb, panCr: cCr };
}
