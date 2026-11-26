
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

/** ITU-R BT.2408 HDR reference diffuse white in cd/m² (nits). */
export const SDR_DIFFUSE_WHITE_NITS = 203;

/** ITU-R BT.2100 HLG inverse OETF: non-linear signal E' in [0,1] -> scene linear E in [0,1]. */
export function hlgToLinear(e: number): number {
  const v = Math.max(0, e);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - HLG_C) / HLG_A) + HLG_B) / 12;
}

/** ITU-R BT.2100 HLG OETF: scene linear E in [0,1] -> non-linear signal E' in [0,1]. */
export function linearToHlg(l: number): number {
  const v = Math.max(0, l);
  return v <= 1 / 12 ? Math.sqrt(3 * v) : HLG_A * Math.log(12 * v - HLG_B) + HLG_C;
}

/**
 * ITU-R BT.2100-2 Table 5 HLG reference EOTF (nominal 1000 cd/m² peak, system gamma 1.2).
 * Maps HLG code axis E' in [0, 1] to display luminance in nits [0, peakNits].
 * At E' = 0.75 (HLG reference white), yields ~203 nits.
 */
export function hlgToNits(e: number, peakNits = 1000): number {
  const scene = hlgToLinear(Math.min(1, Math.max(0, e)));
  const sysGamma = 1.2 + 0.42 * Math.log10(Math.max(peakNits, 1) / 1000);
  return peakNits * Math.pow(scene, sysGamma);
}

/** Exact inverse of `hlgToNits`: display luminance in nits -> HLG code axis E' in [0, 1]. */
export function nitsToHlg(nits: number, peakNits = 1000): number {
  const clamped = Math.min(peakNits, Math.max(0, nits));
  const sysGamma = 1.2 + 0.42 * Math.log10(Math.max(peakNits, 1) / 1000);
  const scene = Math.pow(clamped / Math.max(peakNits, 1e-6), 1 / sysGamma);
  return Math.min(1, Math.max(0, linearToHlg(scene)));
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

/**
 * Display-path WebGPU BT.709 -> sRGB transfer recovery mode:
 * - `0`: pass-through (`srgb`, `pq`, `hlg`, `unknown` / `smpte170m`)
 * - `1`: macOS / iOS Chromium (`gfx::ColorSpace::TransferID::BT709_APPLE`, gamma `1.9609375`)
 * - `2`: Windows / Linux Chromium (`gfx::ColorSpace::TransferID::BT709`, ITU-R BT.709 OETF)
 *
 * Why needed: WebGPU `importExternalTexture` and `copyExternalImageToTexture` convert
 * `transfer: "bt709"` videos into `"srgb"`, boosting 40.2 IRE midtones to ~44.6 IRE
 * (so a 40.2 IRE pixel missed the 38–42% ARRI green false-color band and sat +4.4 IRE
 * above the Eyedropper readout). Inverting that display re-encoding restores the exact
 * broadcast BT.709 signal level across False Color, Waveform, Parade, and Eyedropper.
 */
export type DisplayTransferFix = 0 | 1 | 2;

export function resolveDisplayTransferFix(
  sourceTransfer: 'bt709' | 'srgb' | 'pq' | 'hlg' | 'unknown',
  platformHint?: string,
): DisplayTransferFix {
  if (sourceTransfer !== 'bt709') return 0;
  const plat =
    platformHint ??
    (typeof navigator !== 'undefined'
      ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
      : '');
  return /Mac|iPhone|iPad|iPod/i.test(plat) ? 1 : 2;
}

/** Recover original BT.709 signal code [0..1] from WebGPU's sRGB-reencoded value. */
export function recoverBt709SignalFromSrgb(v: number, mode: DisplayTransferFix): number {
  if (mode === 0) return v;
  const lin = Math.max(0, srgbToLinear(Math.max(0, v)));
  if (mode === 1) {
    return Math.pow(lin, 1 / 1.9609375);
  }
  return lin < 0.01805397 ? 4.5 * lin : 1.0992968 * Math.pow(lin, 0.45) - 0.0992968;
}
