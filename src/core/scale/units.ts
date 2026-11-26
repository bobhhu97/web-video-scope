import { SDR_DIFFUSE_WHITE_NITS, hlgToNits, nitsToHlg, nitsToPq, pqToNits, srgbToLinear } from '../color/transfer';
import { codeToAxis, legalAxisBounds, legalBounds, type RangeSpec } from './quantize';

export type Unit = 'auto' | 'ire' | 'code8' | 'code10' | 'mv' | 'nits' | 'hlg';
export type ConcreteUnit = Exclude<Unit, 'auto'>;
export type HdrMode = 'auto' | 'sdr' | 'pq' | 'hlg';
export type EffectiveTransfer = 'sdr' | 'pq' | 'hlg';

const NITS_STEPS = [0.01, 0.1, 1, 10, 50, 100, 203, 400, 1000, 2000, 4000, 10000];
const HLG_NITS_STEPS = [0, 5, 20, 50, 100, 203, 400, 600, 1000];

export function resolveEffectiveTransfer(hdrMode: HdrMode, detectedTransfer: string): EffectiveTransfer {
  if (hdrMode !== 'auto') return hdrMode;
  if (detectedTransfer === 'pq') return 'pq';
  if (detectedTransfer === 'hlg') return 'hlg';
  return 'sdr';
}

export function resolveEffectiveUnit(unit: Unit, transfer: EffectiveTransfer = 'sdr'): ConcreteUnit {
  if (unit !== 'auto') return unit;
  if (transfer === 'pq') return 'nits';
  if (transfer === 'hlg') return 'hlg';
  return 'ire';
}

export function axisToUnit(a: number, unit: Unit, spec: RangeSpec): number {
  const u = unit === 'auto' ? 'ire' : unit;
  switch (u) {
    case 'ire': {
      const { black, white } = legalAxisBounds(spec);
      return ((a - black) / (white - black)) * 100;
    }
    case 'code8':
      return a * 255;
    case 'code10':
      return a * 1023;
    case 'mv':
      return (axisToUnit(a, 'ire', spec) / 100) * 700;
    case 'nits':
      return pqToNits(a);
    case 'hlg':
      return hlgToNits(a, 1000);
  }
}

export function unitToAxis(value: number, unit: Unit, spec: RangeSpec): number {
  const u = unit === 'auto' ? 'ire' : unit;
  switch (u) {
    case 'ire': {
      const { black, white } = legalAxisBounds(spec);
      return black + (value / 100) * (white - black);
    }
    case 'code8':
      return value / 255;
    case 'code10':
      return value / 1023;
    case 'mv':
      return unitToAxis((value / 700) * 100, 'ire', spec);
    case 'nits':
      return nitsToPq(Math.max(value, 0));
    case 'hlg':
      return nitsToHlg(Math.max(value, 0), 1000);
  }
}

/**
 * Convert a luminance threshold in cd/m² (nits) onto the active [0, 1] code axis
 * so dual-Nit reference lines and zone boundaries match the active EOTF.
 */
export function nitsToAxisForTransfer(
  nits: number,
  transfer: EffectiveTransfer,
  spec: RangeSpec,
): number {
  if (transfer === 'pq') return nitsToPq(Math.max(0, nits));
  if (transfer === 'hlg') return nitsToHlg(Math.max(0, nits), 1000);
  // In SDR mode, treat SDR diffuse white (203 nits, or 100 nits) smoothly onto 0..100 IRE:
  // 0..203 nits maps linearly in light onto 0..100 IRE so testing Nit zones on SDR is intuitive.
  const normLinear = Math.min(1, Math.max(0, nits / SDR_DIFFUSE_WHITE_NITS));
  const srgb = normLinear <= 0.0031308 ? normLinear * 12.92 : 1.055 * Math.pow(normLinear, 1 / 2.4) - 0.055;
  const { black, white } = legalAxisBounds(spec);
  return Math.min(1, Math.max(0, black + srgb * (white - black)));
}

export function axisToNitsForTransfer(
  axis: number,
  transfer: EffectiveTransfer,
  spec: RangeSpec,
): number {
  if (transfer === 'pq') return pqToNits(axis);
  if (transfer === 'hlg') return hlgToNits(axis, 1000);
  const { black, white } = legalAxisBounds(spec);
  const norm = Math.max(0, (axis - black) / Math.max(1e-5, white - black));
  return srgbToLinear(norm) * SDR_DIFFUSE_WHITE_NITS;
}

export function tickValues(unit: Unit, spec: RangeSpec, zoom = 1): number[] {
  const u = unit === 'auto' ? 'ire' : unit;
  const out: number[] = [];
  const push = (a: number): void => {
    if (a >= -1e-6 && a <= 1 + 1e-6) out.push(Math.min(1, Math.max(0, a)));
  };
  switch (u) {
    case 'ire': {
      const step = zoom >= 6 ? 2 : zoom >= 2.5 ? 5 : 10;
      for (let v = 0; v <= 100; v += step) push(unitToAxis(v, 'ire', spec));
      break;
    }
    case 'code8': {
      const base =
        zoom >= 3
          ? Array.from({ length: 17 }, (_, i) => i * 16).concat([235, 255])
          : [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255];
      for (const v of base) push(v / 255);
      break;
    }
    case 'code10': {
      const base =
        zoom >= 3
          ? Array.from({ length: 17 }, (_, i) => i * 64).concat([940, 1023])
          : [0, 64, 128, 256, 384, 512, 640, 768, 896, 940, 1023];
      for (const v of base) push(v / 1023);
      break;
    }
    case 'mv': {
      const step = zoom >= 3 ? 35 : 70;
      for (let v = 0; v <= 700; v += step) push(unitToAxis(v, 'mv', spec));
      break;
    }
    case 'nits': {
      const steps =
        zoom >= 2.5
          ? [...NITS_STEPS, 0.05, 0.5, 5, 25, 200, 600, 1500, 2000, 6000]
          : NITS_STEPS;
      for (const v of steps) push(nitsToPq(v));
      break;
    }
    case 'hlg': {
      const steps = zoom >= 2.5 ? [...HLG_NITS_STEPS, 5, 25, 150, 300, 750] : HLG_NITS_STEPS;
      for (const v of steps) push(nitsToHlg(v, 1000));
      break;
    }
  }
  return Array.from(new Set(out.map((a) => Number(a.toFixed(6))))).sort((a, b) => a - b);
}

export function formatTickLabel(axis: number, unit: Unit, spec: RangeSpec): string {
  const u = unit === 'auto' ? 'ire' : unit;
  const val = axisToUnit(axis, u, spec);
  if (u === 'nits' || u === 'hlg') {
    if (val < 0.05) return '0';
    if (val < 1) return val.toFixed(val < 0.1 ? 2 : 1);
    if (Math.abs(val - 203) < 2) return '203';
    if (val >= 1000) return `${+(val / 1000).toFixed(val % 1000 === 0 ? 0 : 1)}k`;
    return String(Math.round(val));
  }
  return String(Math.round(val));
}

export function legalBands(spec: RangeSpec): {
  footroom: [number, number];
  headroom: [number, number];
} {
  if (!spec.limited) return { footroom: [0, 0], headroom: [0, 0] };
  const { black, white, min, max } = legalBounds(spec);
  return {
    footroom: [codeToAxis(min, spec.depth), codeToAxis(black, spec.depth)],
    headroom: [codeToAxis(white, spec.depth), codeToAxis(max, spec.depth)],
  };
}

export function unitSuffix(unit: Unit): string {
  const u = unit === 'auto' ? 'ire' : unit;
  switch (u) {
    case 'ire':
      return 'IRE';
    case 'code8':
      return '8b';
    case 'code10':
      return '10b';
    case 'mv':
      return 'mV';
    case 'nits':
      return 'nits';
    case 'hlg':
      return 'HLG nits';
  }
}
