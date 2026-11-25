
import { describe, expect, it } from 'vitest';
import {
  hlgToLinear,
  linearToSrgb,
  nitsToPq,
  pqToNits,
  srgbToLinear,
  xyToLinearSrgb,
} from '../src/core/color/transfer';

describe('sRGB transfer', () => {
  it('round-trips', () => {
    for (const v of [0, 0.02, 0.0404, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });
  it('mid-gray 0.5 encodes to ~0.7354 linear', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404, 4);
  });
});

describe('PQ (SMPTE ST 2084)', () => {
  it('round-trips across the HDR range', () => {
    for (const n of [0.01, 1, 100, 203, 1000, 4000, 10000]) {
      expect(pqToNits(nitsToPq(n))).toBeCloseTo(n, 3);
    }
  });
  it('maps signal 1.0 to 10000 nits and 0 to 0', () => {
    expect(pqToNits(0)).toBeCloseTo(0, 6);
    expect(pqToNits(1)).toBeCloseTo(10000, 1);
  });
  it('maps 100 nits to ~0.5081 signal (BT.2408 SDR reference)', () => {
    expect(nitsToPq(100)).toBeCloseTo(0.5081, 3);
  });
});

describe('HLG', () => {
  it('is monotonic and hits 1/12 at signal 0.5', () => {
    expect(hlgToLinear(0.5)).toBeCloseTo(1 / 12, 6);
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = hlgToLinear(i / 10);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('xyToLinearSrgb', () => {
  it('D65 white gives equal rgb', () => {
    const [r, g, b] = xyToLinearSrgb([0.3127, 0.329]);
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(1, 2);
    expect(b).toBeCloseTo(1, 2);
  });
});
