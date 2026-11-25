
import { describe, expect, it } from 'vitest';
import {
  FULL_SCALE,
  axisMapping,
  axisToCode,
  codeToAxis,
  codeToNormalized,
  displayNormalizedToAxis,
  legalAxisBounds,
  legalBounds,
  normalizedToCode,
} from '../src/core/scale/quantize';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };
const L10 = { limited: true, depth: 10 as const };

describe('legalBounds', () => {
  it('reports black/white in code values', () => {
    expect(legalBounds(L8)).toEqual({ black: 16, white: 235, min: 0, max: 255 });
    expect(legalBounds(L10)).toEqual({ black: 64, white: 940, min: 0, max: 1023 });
    expect(legalBounds(F8)).toEqual({ black: 0, white: 255, min: 0, max: 255 });
  });
});

describe('normalized <-> code', () => {
  it('limited 8-bit maps 0 -> 16 and 1 -> 235', () => {
    expect(normalizedToCode(0, L8)).toBeCloseTo(16, 6);
    expect(normalizedToCode(1, L8)).toBeCloseTo(235, 6);
    expect(normalizedToCode(0.5, L8)).toBeCloseTo(125.5, 6);
  });
  it('limited 10-bit maps 0 -> 64 and 1 -> 940', () => {
    expect(normalizedToCode(0, L10)).toBeCloseTo(64, 6);
    expect(normalizedToCode(1, L10)).toBeCloseTo(940, 6);
  });
  it('full range spans the whole field', () => {
    expect(normalizedToCode(1, F8)).toBeCloseTo(255, 6);
    expect(normalizedToCode(0.5, F8)).toBeCloseTo(127.5, 6);
  });
  it('round-trips', () => {
    for (const spec of [L8, F8, L10]) {
      expect(codeToNormalized(normalizedToCode(0.42, spec), spec)).toBeCloseTo(0.42, 6);
    }
  });
});

describe('code <-> axis', () => {
  it('axis is code divided by full scale', () => {
    expect(FULL_SCALE[8]).toBe(255);
    expect(FULL_SCALE[10]).toBe(1023);
    expect(codeToAxis(16, 8)).toBeCloseTo(16 / 255, 9);
    expect(codeToAxis(64, 10)).toBeCloseTo(64 / 1023, 9);
    expect(axisToCode(1, 8)).toBeCloseTo(255, 9);
  });
  it('legal black sits above the floor for limited, at the floor for full', () => {
    expect(legalAxisBounds(L8).black).toBeCloseTo(16 / 255, 9);
    expect(legalAxisBounds(L8).white).toBeCloseTo(235 / 255, 9);
    expect(legalAxisBounds(F8).black).toBe(0);
    expect(legalAxisBounds(F8).white).toBe(1);
  });
  it('limited and full never collapse to the same axis position', () => {
    expect(legalAxisBounds(L8).black).toBeGreaterThan(0.06);
    expect(legalAxisBounds(L8).white).toBeLessThan(0.93);
  });
});

describe('displayNormalizedToAxis', () => {
  it('full range is the identity', () => {
    for (const v of [0, 0.25, 0.5, 1]) {
      expect(displayNormalizedToAxis(v, F8)).toBeCloseTo(v, 9);
    }
  });
  it('limited range compresses into 16/255 .. 235/255', () => {
    expect(displayNormalizedToAxis(0, L8)).toBeCloseTo(16 / 255, 9);
    expect(displayNormalizedToAxis(1, L8)).toBeCloseTo(235 / 255, 9);
    expect(displayNormalizedToAxis(0.5, L8)).toBeCloseTo(125.5 / 255, 9);
  });
  it('a display-white (1.0) limited signal does NOT reach the top of the axis', () => {
    expect(displayNormalizedToAxis(1, L8)).toBeLessThan(0.95);
    expect(displayNormalizedToAxis(0, L8)).toBeGreaterThan(0.05);
  });
  it('10-bit limited maps into 64/1023 .. 940/1023', () => {
    expect(displayNormalizedToAxis(0, L10)).toBeCloseTo(64 / 1023, 9);
    expect(displayNormalizedToAxis(1, L10)).toBeCloseTo(940 / 1023, 9);
  });
  it('axisMapping returns the shader uniform pair', () => {
    const m = axisMapping(L8);
    expect(m.black).toBeCloseTo(16 / 255, 9);
    expect(m.span).toBeCloseTo(219 / 255, 9);
    expect(m.black + m.span).toBeCloseTo(235 / 255, 9);
    expect(axisMapping(F8)).toEqual({ black: 0, span: 1 });
  });
});
