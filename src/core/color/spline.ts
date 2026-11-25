/**
 * Catmull-Rom spline interpolation for smooth polylines.
 *
 * The CIE spectral locus is tabulated at 10 nm intervals — 33 points — which is
 * the physically meaningful resolution of the CIE 1931 2° observer. Drawn as
 * straight chords, the horseshoe has visible corners between samples, which reads
 * as a rendering fault rather than as data fidelity.
 *
 * Resampling the curve through its own points gives a smooth outline without
 * inventing chromaticities: Catmull-Rom passes exactly through every control
 * point, so the extreme red, green and blue corners stay where the table says.
 * A fitting spline (least squares, or a cubic that merely approaches the points)
 * would move them, and those corners are the thing a colourist reads.
 */

type Point = [number, number];

/**
 * Resample a closed polyline through a Catmull-Rom spline.
 *
 * @param points Control points, in order. Treated as a closed loop.
 * @param subdivisions Points generated between each pair of controls.
 */
export function smoothClosedSpline(points: readonly Point[], subdivisions = 8): Point[] {
  const n = points.length;
  if (n < 3) return points.map((p) => [p[0], p[1]]);

  const at = (i: number): Point => points[((i % n) + n) % n]!;
  const out: Point[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    for (let s = 0; s < subdivisions; s++) {
      const t = s / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      // Uniform Catmull-Rom basis.
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Resample an open polyline.
 *
 * Used for the locus arc itself: the line of purples is drawn separately as the
 * straight chord joining the two ends, which is physically correct — there is no
 * single wavelength along it.
 */
export function smoothOpenSpline(points: readonly Point[], subdivisions = 8): Point[] {
  const n = points.length;
  if (n < 3) return points.map((p) => [p[0], p[1]]);

  const at = (i: number): Point =>
    points[Math.min(n - 1, Math.max(0, i))]!;
  const out: Point[] = [];

  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);

    for (let s = 0; s < subdivisions; s++) {
      const t = s / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  out.push([points[n - 1]![0], points[n - 1]![1]]);
  return out;
}
