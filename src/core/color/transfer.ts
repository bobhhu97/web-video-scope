
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const M1 = 2610 / 16384; // 0.1593017578125
const M2 = (2523 / 4096) * 128; // 78.84375
const C1 = 3424 / 4096; // 0.8359375
const C2 = 2413 / 128; // 18.8515625
const C3 = 2392 / 128; // 18.6875

export function nitsToPq(nits: number): number {
  const y = Math.max(nits, 0) / 10000;
  const p = Math.pow(y, M1);
  return Math.pow((C1 + C2 * p) / (1 + C3 * p), M2);
}

export function pqToNits(e: number): number {
  const p = Math.pow(Math.max(e, 0), 1 / M2);
  const num = Math.max(p - C1, 0);
  const den = C2 - C3 * p;
  if (den <= 0) return 10000;
  return 10000 * Math.pow(num / den, 1 / M1);
}

const HLG_A = 0.17883277;
const HLG_B = 0.28466892; // 1 - 4a
const HLG_C = 0.55991073; // 0.5 - a*ln(4a)

export function hlgToLinear(e: number): number {
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG_C) / HLG_A) + HLG_B) / 12;
}

const XYZ_TO_LINEAR_SRGB: readonly (readonly [number, number, number])[] = [
  [3.2409699419, -1.5373831776, -0.4986107603],
  [-0.9692436363, 1.8759675015, 0.0415550574],
  [0.0556300797, -0.2039769589, 1.0569715142],
];

export function xyToLinearSrgb(xy: [number, number]): [number, number, number] {
  const [x, y] = xy;
  if (y < 1e-6) return [0, 0, 0];
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;
  const m = XYZ_TO_LINEAR_SRGB;
  return [
    m[0]![0] * X + m[0]![1] * Y + m[0]![2] * Z,
    m[1]![0] * X + m[1]![1] * Y + m[1]![2] * Z,
    m[2]![0] * X + m[2]![1] * Y + m[2]![2] * Z,
  ];
}
