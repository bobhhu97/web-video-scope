
import type { LumaCoefficients } from '../color/matrices';
import { linearRgbToXyz, xyzToUV, xyzToXY, type PrimariesId } from '../color/primaries';
import { srgbToLinear } from '../color/transfer';

export interface AxisMap {
  black: number;
  span: number;
}

export const FULL_AXIS: AxisMap = { black: 0, span: 1 };

export type WaveChannel = 0 | 1 | 2 | 3 | 4;

export interface WaveformResult {
  cols: number;
  bins: number;
  planes: number;
  density: Uint32Array;
}

function channelValue(
  r: number,
  g: number,
  b: number,
  c: LumaCoefficients,
  channel: 0 | 1 | 2 | 3,
): number {
  switch (channel) {
    case 1:
      return r;
    case 2:
      return g;
    case 3:
      return b;
    default:
      return c.kr * r + c.kg * g + c.kb * b;
  }
}

function axisBin(v: number, map: AxisMap, bins: number): number {
  const axis = map.black + v * map.span;
  const bin = Math.floor(axis * bins);
  return bin < 0 ? 0 : bin > bins - 1 ? bins - 1 : bin;
}

/** `noUncheckedIndexedAccess` makes `density[i] += 1` a type error; bump explicitly. */
function bump(density: Uint32Array, index: number): void {
  density[index] = (density[index] ?? 0) + 1;
}

export function computeWaveform(
  rgba: Uint8Array,
  w: number,
  h: number,
  cols: number,
  bins: number,
  c: LumaCoefficients,
  channel: WaveChannel,
  map: AxisMap = FULL_AXIS,
): WaveformResult {
  const planes = channel === 4 ? 3 : 1;
  const density = new Uint32Array(planes * cols * bins);
  const stride = cols * bins;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i]! / 255;
      const g = rgba[i + 1]! / 255;
      const b = rgba[i + 2]! / 255;
      const col = Math.min(cols - 1, Math.floor((x / w) * cols));
      if (channel === 4) {
        bump(density, 0 * stride + axisBin(r, map, bins) * cols + col);
        bump(density, 1 * stride + axisBin(g, map, bins) * cols + col);
        bump(density, 2 * stride + axisBin(b, map, bins) * cols + col);
      } else {
        // A single selected channel always lands in plane 0: the density buffer
        // only allocates the planes the resolve pass will actually read, so
        // writing plane 1 here would run past the end of the buffer.
        const v = channelValue(r, g, b, c, channel);
        bump(density, axisBin(v, map, bins) * cols + col);
      }
    }
  }
  return { cols, bins, planes, density };
}

export function computeVectorscope(
  rgba: Uint8Array,
  w: number,
  h: number,
  size: number,
  c: LumaCoefficients,
  zoom = 1,
): Uint32Array {
  const density = new Uint32Array(size * size);
  const half = size / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i]! / 255;
      const g = rgba[i + 1]! / 255;
      const b = rgba[i + 2]! / 255;
      const yy = c.kr * r + c.kg * g + c.kb * b;
      const cb = (b - yy) / (2 * (1 - c.kb));
      const cr = (r - yy) / (2 * (1 - c.kr));
      const px = Math.floor(half + cb * zoom * size);
      const py = Math.floor(half - cr * zoom * size);
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      bump(density, py * size + px);
    }
  }
  return density;
}

export const CIE_BOUNDS: Record<'xy' | 'uv', [number, number, number, number]> = {
  xy: [0, 0, 0.8, 0.9],
  uv: [0, 0, 0.62, 0.6],
};

export function computeCie(
  rgba: Uint8Array,
  w: number,
  h: number,
  size: number,
  primaries: PrimariesId,
  coord: 'xy' | 'uv',
): Uint32Array {
  const density = new Uint32Array(size * size);
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lin: [number, number, number] = [
        srgbToLinear(rgba[i]! / 255),
        srgbToLinear(rgba[i + 1]! / 255),
        srgbToLinear(rgba[i + 2]! / 255),
      ];
      const xyz = linearRgbToXyz(lin, primaries);
      const sum = xyz[0] + xyz[1] + xyz[2];
      if (sum < 1e-6) continue;
      const [cx, cy] = coord === 'xy' ? xyzToXY(xyz) : xyzToUV(xyz);
      const px = Math.floor(((cx - x0) / (x1 - x0)) * size);
      const py = Math.floor(size - ((cy - y0) / (y1 - y0)) * size);
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      bump(density, py * size + px);
    }
  }
  return density;
}

