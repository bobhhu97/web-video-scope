
import { nitsToPq, pqToNits } from '../color/transfer';
import { codeToAxis, legalAxisBounds, legalBounds, type RangeSpec } from './quantize';

export type Unit = 'ire' | 'code8' | 'code10' | 'mv' | 'nits';

const NITS_STEPS = [0.01, 0.1, 1, 10, 100, 203, 400, 1000, 4000, 10000];

export function axisToUnit(a: number, unit: Unit, spec: RangeSpec): number {
  switch (unit) {
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
  }
}

export function unitToAxis(value: number, unit: Unit, spec: RangeSpec): number {
  switch (unit) {
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
  }
}

export function tickValues(unit: Unit, spec: RangeSpec): number[] {
  const out: number[] = [];
  const push = (a: number): void => {
    if (a >= -1e-6 && a <= 1 + 1e-6) out.push(Math.min(1, Math.max(0, a)));
  };
  switch (unit) {
    case 'ire':
      for (let v = 0; v <= 100; v += 10) push(unitToAxis(v, 'ire', spec));
      break;
    case 'code8':
      for (const v of [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255]) push(v / 255);
      break;
    case 'code10':
      for (const v of [0, 64, 128, 256, 384, 512, 640, 768, 896, 940, 1023]) push(v / 1023);
      break;
    case 'mv':
      for (let v = 0; v <= 700; v += 70) push(unitToAxis(v, 'mv', spec));
      break;
    case 'nits':
      for (const v of NITS_STEPS) push(nitsToPq(v));
      break;
  }
  return Array.from(new Set(out.map((a) => Number(a.toFixed(6))))).sort((a, b) => a - b);
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
  switch (unit) {
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
  }
}
