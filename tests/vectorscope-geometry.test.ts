import { describe, expect, it } from 'vitest';
import { LUMA, chromaTargets } from '../src/core/color/matrices';
import { chromaToScreen, screenToChroma } from '../src/ui/graticule';

describe('chromaToScreen', () => {
  it('zero chroma maps to the centre', () => {
    expect(chromaToScreen(0, 0, 512, 1)).toEqual([256, 256]);
  });
  it('positive Cr maps above the centre', () => {
    const [, y] = chromaToScreen(0, 0.25, 512, 1);
    expect(y).toBeLessThan(256);
  });
  it('positive Cb maps right of the centre', () => {
    const [x] = chromaToScreen(0.25, 0, 512, 1);
    expect(x).toBeGreaterThan(256);
  });
  it('respects a non-zero origin', () => {
    expect(chromaToScreen(0, 0, 512, 1, 100, 80)).toEqual([100, 80]);
  });
  it('round-trips through screenToChroma', () => {
    for (const [cb, cr] of [[-0.1, 0.2], [0.3, -0.4], [0, 0]] as [number, number][]) {
      const [x, y] = chromaToScreen(cb, cr, 400, 2);
      const [backCb, backCr] = screenToChroma(x, y, 400, 2);
      expect(backCb).toBeCloseTo(cb, 9);
      expect(backCr).toBeCloseTo(cr, 9);
    }
  });
});

describe('bar targets fall where the graticule will draw them', () => {
  const size = 512;
  it('BT.709 75% red target is up-left of centre', () => {
    const red = chromaTargets(LUMA.bt709, 0.75).find((t) => t.name === 'red')!;
    const [x, y] = chromaToScreen(red.cb, red.cr, size, 1);
    expect(x).toBeLessThan(size / 2);
    expect(y).toBeLessThan(size / 2);
  });
  it('every 75% target stays inside the visible circle at zoom 1', () => {
    for (const t of chromaTargets(LUMA.bt709, 0.75)) {
      expect(t.radius).toBeLessThan(0.5);
    }
  });
  it('100% targets sit outside 75% targets but still fit the circle', () => {
    const t75 = chromaTargets(LUMA.bt709, 0.75);
    const t100 = chromaTargets(LUMA.bt709, 1);
    for (let i = 0; i < t75.length; i++) {
      expect(t100[i]!.radius).toBeGreaterThan(t75[i]!.radius);
      expect(t100[i]!.radius).toBeLessThanOrEqual(0.6);
    }
  });
  it('target angle is invariant between 75% and 100%', () => {
    const t75 = chromaTargets(LUMA.bt709, 0.75);
    const t100 = chromaTargets(LUMA.bt709, 1);
    for (let i = 0; i < t75.length; i++) {
      expect(t100[i]!.angleDeg).toBeCloseTo(t75[i]!.angleDeg, 6);
    }
  });
  it('switching matrix moves the targets (601 vs 709 are not interchangeable)', () => {
    const a = chromaTargets(LUMA.bt709, 0.75).find((t) => t.name === 'red')!;
    const b = chromaTargets(LUMA.bt601, 0.75).find((t) => t.name === 'red')!;
    expect(a.angleDeg).not.toBeCloseTo(b.angleDeg, 1);
  });
});
