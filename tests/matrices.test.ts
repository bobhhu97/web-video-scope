
import { describe, expect, it } from 'vitest';
import { LUMA, chroma, chromaTargets, luma } from '../src/core/color/matrices';

describe('luma', () => {
  it('white at 75% has luma 0.75 for every matrix', () => {
    for (const c of Object.values(LUMA)) {
      expect(luma(0.75, 0.75, 0.75, c)).toBeCloseTo(0.75, 6);
    }
  });

  it('BT.709 75% red has luma 0.1595 and chroma (-0.0859, 0.375)', () => {
    expect(luma(0.75, 0, 0, LUMA.bt709)).toBeCloseTo(0.15945, 4);
    const { cb, cr } = chroma(0.75, 0, 0, LUMA.bt709);
    expect(cb).toBeCloseTo(-0.0859, 4);
    expect(cr).toBeCloseTo(0.375, 4);
  });

  it('BT.2020 75% blue has luma 0.0445', () => {
    expect(luma(0, 0, 0.75, LUMA.bt2020)).toBeCloseTo(0.04448, 4);
  });

  it('BT.601 100% red has luma 0.299', () => {
    expect(luma(1, 0, 0, LUMA.bt601)).toBeCloseTo(0.299, 6);
  });
});

describe('chromaTargets', () => {
  it('returns 6 bars with red near 103 degrees in BT.709', () => {
    const t = chromaTargets(LUMA.bt709, 0.75);
    expect(t.map((x) => x.name)).toEqual(['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']);
    const red = t.find((x) => x.name === 'red')!;
    expect(red.angleDeg).toBeCloseTo(102.91, 2);
    expect(red.radius).toBeCloseTo(0.3847, 4);
  });

  it('100% targets are exactly 1/0.75 of 75% targets for saturated primaries', () => {
    const t75 = chromaTargets(LUMA.bt709, 0.75).find((x) => x.name === 'red')!;
    const t100 = chromaTargets(LUMA.bt709, 1).find((x) => x.name === 'red')!;
    expect(t100.cb / t75.cb).toBeCloseTo(1 / 0.75, 3);
  });
});
