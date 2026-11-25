/**
 * Canvas-2D rendering for the point-cloud scopes.
 *
 * Vectorscope and CIE are scatter plots, not spatial distributions: they bin a
 * frame into a 2D histogram and draw the result. Doing that on the GPU needs an
 * atomic pass plus a resolve pass and two buffers per panel, which buys nothing
 * for a few hundred drawn points and cost several rounds of debugging when the
 * density buffer disagreed with what the resolve pass expected.
 *
 * Rendering them on the CPU with ImageData is simpler, testable, and fast enough:
 * a 640x360 analysis frame is 230k pixels, and the whole plot is drawn in a few
 * milliseconds. It also makes smooth graticules trivial, which the GPU path could
 * not do (the spectral locus was drawn as straight chords).
 *
 * This module owns nothing but pixels: the caller supplies the analysis frame
 * and the plot rectangle.
 */
import { linearRgbToXyz, xyzToUV, xyzToXY, type PrimariesId } from '../core/color/primaries';
import { srgbToLinear } from '../core/color/transfer';
import type { LumaCoefficients } from '../core/color/matrices';

/**
 * Premultiplied RGBA pixels for one scope canvas.
 *
 * A plain Uint8ClampedArray rather than ImageData: constructing ImageData needs a
 * DOM, which makes the maths untestable outside a browser. The caller wraps it
 * with `new ImageData(plot.data, plot.width, plot.height)`.
 */
export interface ScatterPlot {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** Bounds of the CIE plot, in chromaticity units. */
export const CIE_BOUNDS: Record<'xy' | 'uv', [number, number, number, number]> = {
  xy: [0, 0, 0.8, 0.9],
  uv: [0, 0, 0.62, 0.6],
};

function makeBuffer(w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(w * h * 4);
}

/**
 * Draw a vectorscope into an RGBA buffer.
 *
 * `rgba` is the analysis frame at `srcW`x`srcH`. Coordinates follow the same
 * convention as the graticule: x = 0.5 + Cb*zoom, y = 0.5 - Cr*zoom.
 */
export function renderVectorscope(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  coeff: LumaCoefficients,
  zoom: number,
  tint: [number, number, number] = [0.55, 1, 0.75],
): ScatterPlot {
  const data = makeBuffer(outW, outH);
  const density = new Uint32Array(outW * outH);
  let peak = 0;

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      const r = rgba[i]! / 255;
      const g = rgba[i + 1]! / 255;
      const b = rgba[i + 2]! / 255;
      const luma = coeff.kr * r + coeff.kg * g + coeff.kb * b;
      const cb = (b - luma) / (2 * (1 - coeff.kb));
      const cr = (r - luma) / (2 * (1 - coeff.kr));
      const px = Math.floor((0.5 + cb * zoom) * outW);
      const py = Math.floor((0.5 - cr * zoom) * outH);
      if (px < 0 || px >= outW || py < 0 || py >= outH) continue;
      const idx = py * outW + px;
      const next = (density[idx] ?? 0) + 1;
      density[idx] = next;
      if (next > peak) peak = next;
    }
  }

  paintDensity(data, density, outW, outH, peak, tint, undefined, dotRadius(outW, outH));
  return { data, width: outW, height: outH };
}

/** Draw a CIE chromaticity diagram into an RGBA buffer. */
export function renderCie(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  primaries: PrimariesId,
  coord: 'xy' | 'uv',
): ScatterPlot {
  const data = makeBuffer(outW, outH);
  const density = new Uint32Array(outW * outH);
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  let peak = 0;

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      const lin: [number, number, number] = [
        srgbToLinear(rgba[i]! / 255),
        srgbToLinear(rgba[i + 1]! / 255),
        srgbToLinear(rgba[i + 2]! / 255),
      ];
      const xyz = linearRgbToXyz(lin, primaries);
      const sum = xyz[0] + xyz[1] + xyz[2];
      if (sum < 1e-6) continue;
      const [cx, cy] = coord === 'xy' ? xyzToXY(xyz) : xyzToUV(xyz);
      const px = Math.floor(((cx - x0) / (x1 - x0)) * outW);
      const py = Math.floor(outH - ((cy - y0) / (y1 - y0)) * outH);
      if (px < 0 || px >= outW || py < 0 || py >= outH) continue;
      const idx = py * outW + px;
      const next = (density[idx] ?? 0) + 1;
      density[idx] = next;
      if (next > peak) peak = next;
    }
  }

  // Tint each lit pixel by its own chromaticity, which is what makes a CIE scatter
  // readable: the colour of a point is the colour it represents.
  paintDensity(data, density, outW, outH, peak, null, (px, py) => {
    const cx = x0 + ((px + 0.5) / outW) * (x1 - x0);
    const cy = y0 + ((outH - py - 0.5) / outH) * (y1 - y0);
    let rgb: [number, number, number];
    if (coord === 'xy') {
      rgb = [cx, cy, Math.max(0, 1 - cx - cy)];
    } else {
      // u'v' -> xy for display
      const d = 6 * cx - 16 * cy + 12;
      rgb = d > 1e-6 ? [(9 * cx) / d, (4 * cy) / d, 0] : [0, 0, 0];
    }
    const k = 1.9;
    return [
      Math.min(1, Math.max(0, rgb[0] * k)),
      Math.min(1, Math.max(0, rgb[1] * k)),
      Math.min(1, Math.max(0, rgb[2] * k)),
    ];
  }, dotRadius(outW, outH));

  return { data, width: outW, height: outH };
}

/**
 * Dot size in pixels, scaled to the drawn area.
 *
 * A fixed radius is either invisible in a 4-up grid or a fat blob in single
 * view; tying it to the plot's short edge keeps the dots legible either way.
 */
function dotRadius(w: number, h: number): number {
  return Math.max(1, Math.min(3, Math.round(Math.min(w, h) / 180)));
}

/**
 * Turn a density histogram into pixels.
 *
 * `tint` gives every lit pixel the same colour; `colorAt` gives each pixel its
 * own, which is what the CIE diagram needs. Brightness follows a saturating
 * curve so a single hit is visible but dense regions do not clip to a flat blob.
 *
 * `dotRadius` splats each lit bin over a small disc. A CIE plot at canvas
 * resolution has one bin per pixel, so content that is nearly monochrome (a grey
 * ramp, a neutral interior) collapses into a single lit pixel — mathematically
 * correct, visually absent. A one-pixel disc makes it a visible dot instead.
 */
function paintDensity(
  d: Uint8ClampedArray,
  density: Uint32Array,
  w: number,
  h: number,
  peak: number,
  tint: [number, number, number] | null,
  colorAt?: (px: number, py: number) => [number, number, number],
  dotRadius = 0,
): void {
  if (peak === 0) return;
  // Canvas ImageData is *non*-premultiplied: RGB is the full colour and alpha is
  // separate. Scaling RGB by the intensity as well squared it once more on
  // compositing, so a sparse bin with a 0.008 alpha landed at 6e-5 and the whole
  // plot looked empty while it was in fact full of correctly-placed points.
  //
  // Normalisation is a cube root with a floor, not a linear ratio to the peak.
  // One frame of real video puts tens of thousands of samples in the neutral bin
  // and a few in a small saturated object; linear normalisation made the object
  // 1/90000 as bright as the peak, which is invisible. Cube root keeps the
  // ordering readable while a single hit still lands near 35% alpha.
  const p3 = Math.cbrt(Math.max(peak, 1));
  const r = Math.max(0, Math.min(3, Math.round(dotRadius)));
  const disc: [number, number, number][] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.hypot(dx, dy);
      if (dist > r + 0.5) continue;
      disc.push([dx, dy, 1 - (r === 0 ? 0 : dist / (r + 1))]);
    }
  }

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const n = density[py * w + px] ?? 0;
      if (n === 0) continue;
      const intensity = Math.min(1, 0.35 + 0.65 * (Math.cbrt(n) / p3));
      const c = colorAt ? colorAt(px, py) : (tint ?? [1, 1, 1]);
      for (const [dx, dy, falloff] of disc) {
        const qx = px + dx;
        const qy = py + dy;
        if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
        const a = intensity * falloff;
        const i = (qy * w + qx) * 4;
        // Keep the strongest contribution: overlapping dots must not add up to
        // a white blob, and a bright dot must not be dimmed by a neighbour.
        if (a * 255 <= (d[i + 3] ?? 0)) continue;
        d[i] = Math.round(c[0] * 255);
        d[i + 1] = Math.round(c[1] * 255);
        d[i + 2] = Math.round(c[2] * 255);
        d[i + 3] = Math.round(255 * a);
      }
    }
  }
}
