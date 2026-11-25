
import { describe, expect, it } from 'vitest';
import { PRIMARIES, linearRgbToXyz, xyzToUV, xyzToXY } from '../src/core/color/primaries';

describe('primaries', () => {
  it('pure red maps to the red primary chromaticity', () => {
    for (const id of ['rec709', 'p3', 'rec2020'] as const) {
      const [x, y] = xyzToXY(linearRgbToXyz([1, 0, 0], id));
      expect(x).toBeCloseTo(PRIMARIES[id].xy.r[0], 3);
      expect(y).toBeCloseTo(PRIMARIES[id].xy.r[1], 3);
    }
  });

  it('white maps to D65', () => {
    for (const id of ['rec709', 'p3', 'rec2020'] as const) {
      const [x, y] = xyzToXY(linearRgbToXyz([1, 1, 1], id));
      expect(x).toBeCloseTo(0.3127, 3);
      expect(y).toBeCloseTo(0.329, 3);
    }
  });

  it('CIE 1976 u-prime v-prime of D65 is (0.1978, 0.4683)', () => {
    const [u, v] = xyzToUV(linearRgbToXyz([1, 1, 1], 'rec709'));
    expect(u).toBeCloseTo(0.1978, 3);
    expect(v).toBeCloseTo(0.4683, 3);
  });
});
