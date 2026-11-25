import { describe, expect, it } from 'vitest';
import { smoothClosedSpline, smoothOpenSpline } from '../src/core/color/spline';

describe('smoothClosedSpline', () => {
  it('passes through every control point', () => {
    const pts: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const out = smoothClosedSpline(pts, 4);
    // The first sample of each segment is the control point itself.
    for (let i = 0; i < pts.length; i++) {
      const got = out[i * 4]!;
      expect(got[0]).toBeCloseTo(pts[i]![0], 6);
      expect(got[1]).toBeCloseTo(pts[i]![1], 6);
    }
  });

  it('generates the expected number of samples', () => {
    const pts: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(smoothClosedSpline(pts, 6).length).toBe(pts.length * 6);
  });

  it('produces a smoother curve than the chords it replaces', () => {
    // A square sampled with straight chords turns 90 degrees at each corner;
    // the spline should bend over several samples instead.
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const out = smoothClosedSpline(pts, 8);
    let maxTurn = 0;
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const prev = i >= 2 ? out[i - 2]! : out[out.length - 1]!;
      const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const a2 = Math.atan2(a[1] - prev[1], a[0] - prev[0]);
      let d = Math.abs(a1 - a2);
      if (d > Math.PI) d = 2 * Math.PI - d;
      maxTurn = Math.max(maxTurn, d);
    }
    // A hard corner is 90 degrees (1.57 rad); a smoothed one is well under that.
    expect(maxTurn).toBeLessThan(Math.PI / 3);
  });

  it('handles fewer than three points by returning them unchanged', () => {
    expect(smoothClosedSpline([[0, 0], [1, 1]], 4)).toEqual([[0, 0], [1, 1]]);
  });
});

describe('smoothOpenSpline', () => {
  it('starts and ends exactly on the endpoints', () => {
    const pts: [number, number][] = [
      [0, 0],
      [1, 2],
      [3, 1],
      [4, 4],
    ];
    const out = smoothOpenSpline(pts, 5);
    expect(out[0]![0]).toBeCloseTo(0, 6);
    expect(out[0]![1]).toBeCloseTo(0, 6);
    const last = out[out.length - 1]!;
    expect(last[0]).toBeCloseTo(4, 6);
    expect(last[1]).toBeCloseTo(4, 6);
  });

  it('is denser than the input', () => {
    const pts: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    expect(smoothOpenSpline(pts, 10).length).toBeGreaterThan(pts.length);
  });
});
