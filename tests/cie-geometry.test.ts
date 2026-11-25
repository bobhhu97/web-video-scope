import { describe, expect, it } from 'vitest';
import { CIE_BOUNDS } from '../src/core/scopes/reference';
import { screenToXy, uvToXy, xyToScreen, xyToUv } from '../src/ui/graticule';

describe('xyToScreen', () => {
  it('places D65 by the shared bounds', () => {
    const [px, py] = xyToScreen(0.3127, 0.329, 800, 900, 'xy');
    expect(px).toBeCloseTo((0.3127 / CIE_BOUNDS.xy[2]) * 800, 3);
    expect(py).toBeCloseTo(900 - (0.329 / CIE_BOUNDS.xy[3]) * 900, 3);
  });
  it('places the origin at the bottom-left corner', () => {
    expect(xyToScreen(0, 0, 800, 900, 'xy')).toEqual([0, 900]);
  });
  it('round-trips both coordinate systems', () => {
    for (const coord of ['xy', 'uv'] as const) {
      const [px, py] = xyToScreen(0.2, 0.45, 600, 580, coord);
      const [x, y] = screenToXy(px, py, 600, 580, coord);
      expect(x).toBeCloseTo(0.2, 9);
      expect(y).toBeCloseTo(0.45, 9);
    }
  });
});

describe('CIE 1976 conversion', () => {
  it('D65 xy converts to u-prime/v-prime (0.1978, 0.4683)', () => {
    const [u, v] = xyToUv(0.3127, 0.329);
    expect(u).toBeCloseTo(0.1978, 3);
    expect(v).toBeCloseTo(0.4683, 3);
  });
  it('round-trips xy -> uv -> xy', () => {
    for (const [x, y] of [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]] as [number, number][]) {
      const [u, v] = xyToUv(x, y);
      const [bx, by] = uvToXy(u, v);
      expect(bx).toBeCloseTo(x, 9);
      expect(by).toBeCloseTo(y, 9);
    }
  });
  it('the Rec.709 green primary stays above the D65 locus line in uv space', () => {
    const [, greenV] = xyToUv(0.3, 0.6);
    const [, whiteV] = xyToUv(0.3127, 0.329);
    expect(greenV).toBeGreaterThan(whiteV);
  });
});
