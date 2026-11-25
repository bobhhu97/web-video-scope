
import { describe, expect, it } from 'vitest';
import { CIE1931_LOCUS, SPECTRAL_WAVELENGTHS, gamutTriangle, locusPath } from '../src/core/color/locus';

describe('CIE 1931 spectral locus', () => {
  it('has 33 samples from 380 to 700 nm at 10 nm', () => {
    expect(CIE1931_LOCUS.length).toBe(33);
    expect(SPECTRAL_WAVELENGTHS.length).toBe(33);
    expect(SPECTRAL_WAVELENGTHS[0]).toBe(380);
    expect(SPECTRAL_WAVELENGTHS[32]).toBe(700);
  });

  it('starts at the deep-violet end and ends at the 700 nm red end', () => {
    expect(CIE1931_LOCUS[0]).toEqual([0.1741, 0.005]);
    expect(CIE1931_LOCUS[CIE1931_LOCUS.length - 1]).toEqual([0.7347, 0.2653]);
  });

  it('peaks just above y = 0.83 near 520 nm', () => {
    const idx = SPECTRAL_WAVELENGTHS.indexOf(520);
    expect(CIE1931_LOCUS[idx]![1]).toBeCloseTo(0.8338, 4);
    const maxY = Math.max(...CIE1931_LOCUS.map((p) => p[1]));
    expect(maxY).toBeCloseTo(0.8338, 4);
  });

  it('has the 500 nm cyan tip at x = 0.0082', () => {
    const idx = SPECTRAL_WAVELENGTHS.indexOf(500);
    expect(CIE1931_LOCUS[idx]).toEqual([0.0082, 0.5384]);
  });

  it('keeps every sample inside the visible horseshoe box', () => {
    for (const [x, y] of CIE1931_LOCUS) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(0.75);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.84);
    }
  });

  it('x falls to a 500 nm minimum then rises (a real curve, not a box)', () => {
    const xs = CIE1931_LOCUS.map((p) => p[0]);
    const minIdx = xs.indexOf(Math.min(...xs));
    expect(SPECTRAL_WAVELENGTHS[minIdx]).toBe(500);
    expect(xs[minIdx]).toBeLessThan(0.01);
    expect(xs[xs.length - 1]!).toBeGreaterThan(0.7);
  });
});

describe('locusPath', () => {
  it('starts with M and closes with Z', () => {
    const p = locusPath();
    expect(p.startsWith('M')).toBe(true);
    expect(p.endsWith('Z')).toBe(true);
  });

  it('honours the provided mapping function', () => {
    const p = locusPath(([x, y]) => [x * 100, y * 100]);
    expect(p.startsWith('M17.4100,0.5000')).toBe(true);
  });
});

describe('gamutTriangle', () => {
  it('returns the primaries in R, G, B order', () => {
    expect(gamutTriangle('rec709')).toEqual([
      [0.64, 0.33],
      [0.3, 0.6],
      [0.15, 0.06],
    ]);
    expect(gamutTriangle('rec2020')[0]).toEqual([0.708, 0.292]);
  });

  it('every primaries triangle is inside the locus bounding box', () => {
    for (const id of ['rec709', 'p3', 'rec2020'] as const) {
      for (const [x, y] of gamutTriangle(id)) {
        expect(x).toBeGreaterThanOrEqual(0.13);
        expect(x).toBeLessThanOrEqual(0.71);
        expect(y).toBeGreaterThanOrEqual(0.04);
        expect(y).toBeLessThanOrEqual(0.8);
      }
    }
  });
});
