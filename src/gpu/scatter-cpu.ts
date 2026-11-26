/**
 * Canvas-2D rendering for the point-cloud scopes (Vectorscope & CIE).
 *
 * Vectorscope and CIE bin an analysis frame into a 2D histogram and turn bin
 * counts into phosphor intensity. Two bugs previously made the vectorscope read
 * as scattered chunky blocks flying outside the circle:
 *
 * 1. Coordinate mismatch: `renderVectorscope` stretched Cb across `outW` and Cr
 *    across `outH`, while `drawVectorscopeGraticule` drew a centred circle of
 *    diameter `Math.min(w, h)`. Both now share `vectorscopeFrame`.
 * 2. Floor + stamp bloat: every non-zero bin was given at least 35% alpha and
 *    stamped with a 5x5–7x7 disc, so single-pixel compression noise or faint
 *    watermarks inflated into opaque green blocks. Intensity now scales from 0
 *    against the frame's sample density (honouring `gain` and `gamma`), sparse
 *    transition bins stay 1 px crisp, and only concentrated peaks (colour bars,
 *    neutral patches) receive a tight pinpoint phosphor halo.
 */
import { LUMA, type LumaCoefficients } from '../core/color/matrices';
import { linearRgbToXyz, xyzToUV, xyzToXY, type PrimariesId } from '../core/color/primaries';
import { linearToSrgb, srgbToLinear, xyToLinearSrgb } from '../core/color/transfer';
import { cieFrame, frameToScreen, screenToFrame } from '../core/color/cie-frame';
import {
  insideVectorscopeDisc,
  screenToVectorscope,
  vectorscopeFrame,
  vectorscopeToScreen,
} from '../core/color/vectorscope-frame';

/**
 * Non-premultiplied RGBA pixels for one scope canvas, ready for `new ImageData`.
 */
export interface ScatterPlot {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export interface ScatterRenderOptions {
  gain?: number;
  gamma?: number;
  signalKind?: 'display' | 'raw';
  limited?: boolean;
  matrix?: LumaCoefficients;
}

function makeBuffer(w: number, h: number): Uint8ClampedArray<ArrayBuffer> {
  return new Uint8ClampedArray(w * h * 4);
}

/** Reconstruct display-normalised R'G'B' from packed raw-downscale YUV texels. */
function rawTexelToRgb(
  yNormCode: number,
  uPacked: number,
  vPacked: number,
  limited: boolean,
  coeff: LumaCoefficients,
): [number, number, number] {
  const cScale = limited ? 1 : 224 / 255;
  const cb = (uPacked - 0.5) * 2 * cScale;
  const cr = (vPacked - 0.5) * 2 * cScale;
  const y = limited ? (yNormCode - 16 / 255) / (219 / 255) : yNormCode;
  const r = y + 2 * (1 - coeff.kr) * cr;
  const b = y + 2 * (1 - coeff.kb) * cb;
  const g = (y - coeff.kr * r - coeff.kb * b) / Math.max(coeff.kg, 1e-4);
  return [
    Math.min(1, Math.max(0, r)),
    Math.min(1, Math.max(0, g)),
    Math.min(1, Math.max(0, b)),
  ];
}

/** Convert vectorscope (Cb, Cr) to a vivid, legible display tint on #0d1117. */
function chromaToDisplayTint(
  cb: number,
  cr: number,
  coeff: LumaCoefficients,
): [number, number, number] {
  const y = 0.62;
  const r = y + 2 * (1 - coeff.kr) * cr;
  const b = y + 2 * (1 - coeff.kb) * cb;
  const g = (y - coeff.kr * r - coeff.kb * b) / Math.max(coeff.kg, 1e-4);
  const floor = Math.min(0, r, g, b);
  const r0 = r - floor;
  const g0 = g - floor;
  const b0 = b - floor;
  const peak = Math.max(y, r0, g0, b0, 1e-6);
  const rn = r0 / peak;
  const gn = g0 / peak;
  const bn = b0 / peak;
  // Blend 72% true chroma hue with 28% phosphor white-mint so deep blue and red
  // remain bright on the dark scope face while neutrals read as crisp white.
  return [
    Math.min(1, rn * 0.72 + 0.88 * 0.28),
    Math.min(1, gn * 0.72 + 1.0 * 0.28),
    Math.min(1, bn * 0.72 + 0.92 * 0.28),
  ];
}

/**
 * Draw a vectorscope into an RGBA buffer using the exact same `vectorscopeFrame`
 * geometry as `drawVectorscopeGraticule`.
 */
export function renderVectorscope(
  rgba: Uint8Array,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  coeff: LumaCoefficients,
  zoom: number,
  tint?: [number, number, number],
  extra: ScatterRenderOptions = {},
): ScatterPlot {
  const data = makeBuffer(outW, outH);
  const density = new Uint32Array(outW * outH);
  const frame = vectorscopeFrame(outW, outH, zoom);
  const isRaw = extra.signalKind === 'raw';
  const limited = extra.limited ?? true;
  const cScale = limited ? 1 : 224 / 255;
  const tintMatrix = extra.matrix ?? coeff;
  let peak = 0;

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      let cb: number;
      let cr: number;
      if (isRaw) {
        cb = (rgba[i + 1]! / 255 - 0.5) * 2 * cScale;
        cr = (rgba[i + 2]! / 255 - 0.5) * 2 * cScale;
      } else {
        const r = rgba[i]! / 255;
        const g = rgba[i + 1]! / 255;
        const b = rgba[i + 2]! / 255;
        const luma = coeff.kr * r + coeff.kg * g + coeff.kb * b;
        cb = (b - luma) / (2 * (1 - coeff.kb));
        cr = (r - luma) / (2 * (1 - coeff.kr));
      }
      const [sx, sy] = vectorscopeToScreen(frame, cb, cr);
      if (!insideVectorscopeDisc(frame, sx, sy, 1.5)) continue;
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      if (px < 0 || px >= outW || py < 0 || py >= outH) continue;
      const idx = py * outW + px;
      const next = (density[idx] ?? 0) + 1;
      density[idx] = next;
      if (next > peak) peak = next;
    }
  }

  paintDensity(
    data,
    density,
    outW,
    outH,
    srcW * srcH,
    peak,
    tint ?? null,
    tint
      ? undefined
      : (px, py) => {
          const [cb, cr] = screenToVectorscope(frame, px + 0.5, py + 0.5);
          return chromaToDisplayTint(cb, cr, tintMatrix);
        },
    peakRadius(outW, outH),
    extra.gain ?? 1,
    extra.gamma ?? 0.9,
    (qx, qy) => insideVectorscopeDisc(frame, qx + 0.5, qy + 0.5, 2.5),
  );
  return { data, width: outW, height: outH };
}

/** Lift negative linear sRGB channels with the minimum neutral mix to stay in gamut. */
function gamutSafeLinear(lin: [number, number, number]): [number, number, number] {
  const min = Math.min(lin[0], lin[1], lin[2]);
  if (min >= 0) return lin;
  const max = Math.max(lin[0], lin[1], lin[2]);
  if (max <= min) return [0, 0, 0];
  const t = -min / (max - min);
  return [lin[0] * (1 - t) + max * t, lin[1] * (1 - t) + max * t, lin[2] * (1 - t) + max * t];
}

/** Convert a CIE 1931 (x, y) chromaticity to a bright, gamut-safe display sRGB triple. */
function xyToDisplayTint(x: number, y: number): [number, number, number] {
  if (y <= 1e-5) return [0.75, 0.85, 1];
  const lin = gamutSafeLinear(xyToLinearSrgb([x, y]));
  const peak = Math.max(lin[0], lin[1], lin[2], 1e-6);
  // Lift deep blue slightly toward white so (0.15, 0.06) remains legible on #0d1117.
  const lift = 0.12;
  return [
    linearToSrgb(Math.min(1, (lin[0] / peak) * (1 - lift) + lift)),
    linearToSrgb(Math.min(1, (lin[1] / peak) * (1 - lift) + lift)),
    linearToSrgb(Math.min(1, (lin[2] / peak) * (1 - lift) + lift)),
  ];
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
  zoom = 1,
  extra: ScatterRenderOptions = {},
): ScatterPlot {
  const data = makeBuffer(outW, outH);
  const density = new Uint32Array(outW * outH);
  const frame = cieFrame(outW, outH, coord, zoom);
  const isRaw = extra.signalKind === 'raw';
  const limited = extra.limited ?? true;
  const coeff = extra.matrix ?? LUMA.bt709;
  let peak = 0;

  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const i = (y * srcW + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (isRaw) {
        [r, g, b] = rawTexelToRgb(
          rgba[i]! / 255,
          rgba[i + 1]! / 255,
          rgba[i + 2]! / 255,
          limited,
          coeff,
        );
      } else {
        r = rgba[i]! / 255;
        g = rgba[i + 1]! / 255;
        b = rgba[i + 2]! / 255;
      }
      const lin: [number, number, number] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
      const xyz = linearRgbToXyz(lin, primaries);
      const sum = xyz[0] + xyz[1] + xyz[2];
      // Reject black and 1–2 LSB dark quantisation noise whose chromaticity is
      // dominated by 8-bit rounding rather than real colour.
      if (sum < 0.002) continue;
      const [cx, cy] = coord === 'xy' ? xyzToXY(xyz) : xyzToUV(xyz);
      const [sx, sy] = frameToScreen(frame, cx, cy);
      const px = Math.floor(sx);
      const py = Math.floor(sy);
      if (px < 0 || px >= outW || py < 0 || py >= outH) continue;
      const idx = py * outW + px;
      const next = (density[idx] ?? 0) + 1;
      density[idx] = next;
      if (next > peak) peak = next;
    }
  }

  paintDensity(
    data,
    density,
    outW,
    outH,
    srcW * srcH,
    peak,
    null,
    (px, py) => {
      const [cx, cy] = screenToFrame(frame, px + 0.5, py + 0.5);
      if (coord === 'xy') return xyToDisplayTint(cx, cy);
      const d = 6 * cx - 16 * cy + 12;
      if (d <= 1e-6) return [0.75, 0.85, 1];
      return xyToDisplayTint((9 * cx) / d, (4 * cy) / d);
    },
    peakRadius(outW, outH),
    extra.gain ?? 1,
    extra.gamma ?? 0.9,
  );

  return { data, width: outW, height: outH };
}

/**
 * Pinpoint phosphor halo radius for concentrated peaks (e.g. pure colour bars).
 * Sparse transition and noise bins stay at radius 0 (exact 1 px) so they never
 * clump into blocks.
 */
function peakRadius(w: number, h: number): number {
  return Math.max(3, Math.min(5, Math.round(Math.min(w, h) / 115)));
}

function paintDensity(
  d: Uint8ClampedArray,
  density: Uint32Array,
  w: number,
  h: number,
  totalSamples: number,
  peak: number,
  tint: [number, number, number] | null,
  colorAt: ((px: number, py: number) => [number, number, number]) | undefined,
  maxRadius: number,
  gain: number,
  gamma: number,
  allowPixel?: (qx: number, qy: number) => boolean,
): void {
  if (peak === 0) return;

  const safeTotal = Math.max(1, totalSamples);
  // Reference sample count for unit scatter density. For a 640x360 video frame
  // (~230k px) this is ~56 hits: a single noisy pixel (n=1) lands below 2%
  // alpha instead of 37%, while a colour bar (n~25k) saturates cleanly at 1.0.
  // For tiny synthetic unit-test frames (1..16 px), the 0.25 floor keeps single
  // test samples crisp and bright.
  const refCount = Math.max(0.25, safeTotal / 4096);
  const invGamma = 1 / Math.max(0.05, gamma);
  const effectiveGain = Math.max(0.05, gain);
  // Only bins holding a meaningful concentrated patch (>= 0.4% of frame) earn a
  // pinpoint phosphor halo; everything sparser draws as a sharp 1 px trace.
  const peakThreshold = Math.max(1, Math.ceil(safeTotal * 0.004));

  const r = Math.max(0, Math.min(5, Math.round(maxRadius)));
  const halo: [number, number, number][] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.hypot(dx, dy);
      if (dist > r + 0.35) continue;
      const falloff = dist <= 1.35 ? 1 : Math.exp(-(dist - 1.2) * (dist - 1.2) * 0.42);
      halo.push([dx, dy, falloff]);
    }
  }

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const n = density[py * w + px] ?? 0;
      if (n === 0) continue;
      const exposure = (n / refCount) * 0.6 * effectiveGain;
      const intensity = Math.min(1, Math.pow(1 - Math.exp(-exposure), invGamma));
      const a0 = Math.round(255 * intensity);
      if (a0 === 0) continue;

      const c = colorAt ? colorAt(px, py) : (tint ?? [1, 1, 1]);
      const cr = Math.round(c[0] * 255);
      const cg = Math.round(c[1] * 255);
      const cb = Math.round(c[2] * 255);

      if (n >= peakThreshold && intensity >= 0.7 && halo.length > 1) {
        for (const [dx, dy, falloff] of halo) {
          const qx = px + dx;
          const qy = py + dy;
          if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
          if (allowPixel && !allowPixel(qx, qy)) continue;
          const a = Math.round(255 * intensity * falloff);
          const i = (qy * w + qx) * 4;
          if (a <= (d[i + 3] ?? 0)) continue;
          d[i] = cr;
          d[i + 1] = cg;
          d[i + 2] = cb;
          d[i + 3] = a;
        }
      } else {
        const i = (py * w + px) * 4;
        if (a0 <= (d[i + 3] ?? 0)) continue;
        d[i] = cr;
        d[i + 1] = cg;
        d[i + 2] = cb;
        d[i + 3] = a0;
      }
    }
  }
}
