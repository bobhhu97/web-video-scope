import { describe, expect, it } from 'vitest';
import { CIE1931_LOCUS, SPECTRAL_WAVELENGTHS, gamutTriangle, locusPath } from '../src/core/color/locus';
import { smoothOpenSpline } from '../src/core/color/spline';

describe('CIE 1931 spectral locus', () => {
  it('has 65 samples from 380 to 700 nm at 5 nm', () => {
    expect(CIE1931_LOCUS.length).toBe(65);
    expect(SPECTRAL_WAVELENGTHS.length).toBe(65);
    expect(SPECTRAL_WAVELENGTHS[0]).toBe(380);
    expect(SPECTRAL_WAVELENGTHS[SPECTRAL_WAVELENGTHS.length - 1]).toBe(700);
    // The samples must be evenly spaced, or a wavelength lookup by index lies.
    for (let i = 1; i < SPECTRAL_WAVELENGTHS.length; i++) {
      expect(SPECTRAL_WAVELENGTHS[i]! - SPECTRAL_WAVELENGTHS[i - 1]!).toBe(5);
    }
  });

  it('starts at the deep-violet end and ends at the 700 nm red end', () => {
    const [x0, y0] = CIE1931_LOCUS[0]!;
    expect(x0).toBeCloseTo(0.1741, 3);
    expect(y0).toBeCloseTo(0.005, 3);
    const [x1, y1] = CIE1931_LOCUS[CIE1931_LOCUS.length - 1]!;
    expect(x1).toBeCloseTo(0.7347, 3);
    expect(y1).toBeCloseTo(0.2653, 3);
  });

  it('peaks just above y = 0.83 near 520 nm', () => {
    const idx = SPECTRAL_WAVELENGTHS.indexOf(520);
    expect(CIE1931_LOCUS[idx]![1]).toBeCloseTo(0.8338, 3);
    const maxY = Math.max(...CIE1931_LOCUS.map((p) => p[1]));
    expect(maxY).toBeCloseTo(0.8338, 3);
  });

  it('has the cyan tip near 500 nm at x = 0.008', () => {
    const idx = SPECTRAL_WAVELENGTHS.indexOf(500);
    const [x, y] = CIE1931_LOCUS[idx]!;
    expect(x).toBeCloseTo(0.0082, 3);
    expect(y).toBeCloseTo(0.5384, 3);
  });

  it('keeps every sample inside the visible horseshoe box', () => {
    for (const [x, y] of CIE1931_LOCUS) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(0.75);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.84);
    }
  });

  it('x falls to a minimum near 505 nm then rises (a real curve, not a box)', () => {
    const xs = CIE1931_LOCUS.map((p) => p[0]);
    const minIdx = xs.indexOf(Math.min(...xs));
    // The true locus minimum sits at about 504 nm; at 5 nm resolution it lands on
    // 505. The old 10 nm table could only say "500", which is the same physics
    // rounded to the nearest decade.
    expect(SPECTRAL_WAVELENGTHS[minIdx]).toBe(505);
    expect(xs[minIdx]).toBeLessThan(0.005);
    expect(xs[xs.length - 1]!).toBeGreaterThan(0.7);
  });

  it('is smooth enough that the drawn spline has no visible corners', () => {
    // The table alone is not the whole story: the graticule resamples through a
    // spline, and what the eye judges is the turn angle between drawn segments.
    // This asserts the shipped table plus the shipped subdivision rule together.
    const w = 550 / 0.8;
    const h = 287 / 0.9;
    const screen = CIE1931_LOCUS.map(([x, y]) => [x * w, h - y * h] as const);
    let longest = 0;
    for (let i = 1; i < screen.length; i++) {
      const a = screen[i - 1]!;
      const b = screen[i]!;
      longest = Math.max(longest, Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const subdivisions = Math.max(6, Math.min(24, Math.ceil(longest / 3)));
    const pts = smoothOpenSpline(screen.map((p) => [p[0], p[1]] as [number, number]), subdivisions);

    let worstTurn = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const v1 = [pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]];
      const v2 = [pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]];
      const l1 = Math.hypot(v1[0]!, v1[1]!);
      const l2 = Math.hypot(v2[0]!, v2[1]!);
      if (l1 < 1e-6 || l2 < 1e-6) continue;
      const cos = Math.max(-1, Math.min(1, (v1[0]! * v2[0]! + v1[1]! * v2[1]!) / (l1 * l2)));
      worstTurn = Math.max(worstTurn, (Math.acos(cos) * 180) / Math.PI);
    }
    // 10 nm tables with 6 subdivisions turned 12.6 degrees. Under 5 degrees the
    // polyline stops reading as straight edges.
    expect(worstTurn).toBeLessThan(5);
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
    expect(p.startsWith('M17.4110,0.4960')).toBe(true);
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
