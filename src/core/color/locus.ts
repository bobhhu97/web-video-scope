
import { PRIMARIES, type PrimariesId } from './primaries';

/** Wavelength (nm) for each entry of CIE1931_LOCUS. */
export const SPECTRAL_WAVELENGTHS: readonly number[] = Array.from(
  { length: 33 },
  (_, i) => 380 + i * 10,
);

/** CIE 1931 2° observer chromaticity, 380..700 nm in 10 nm steps. */
export const CIE1931_LOCUS: ReadonlyArray<[number, number]> = [
  [0.1741, 0.005],  // 380
  [0.1738, 0.0049], // 390
  [0.1733, 0.0048], // 400
  [0.1726, 0.0048], // 410
  [0.1714, 0.0051], // 420
  [0.1689, 0.0069], // 430
  [0.1644, 0.0109], // 440
  [0.1566, 0.0177], // 450
  [0.144, 0.0297],  // 460
  [0.1241, 0.0578], // 470
  [0.0913, 0.1327], // 480
  [0.0454, 0.295],  // 490
  [0.0082, 0.5384], // 500
  [0.0139, 0.7502], // 510
  [0.0743, 0.8338], // 520
  [0.1547, 0.8059], // 530
  [0.2296, 0.7543], // 540
  [0.3016, 0.6923], // 550
  [0.3731, 0.6245], // 560
  [0.4441, 0.5547], // 570
  [0.5125, 0.4866], // 580
  [0.5752, 0.4242], // 590
  [0.627, 0.3725],  // 600
  [0.6658, 0.334],  // 610
  [0.6915, 0.3083], // 620
  [0.7079, 0.292],  // 630
  [0.719, 0.2809],  // 640
  [0.726, 0.274],   // 650
  [0.73, 0.27],     // 660
  [0.732, 0.268],   // 670
  [0.7334, 0.2666], // 680
  [0.7344, 0.2656], // 690
  [0.7347, 0.2653], // 700
];

export function locusPoints(): [number, number][] {
  return CIE1931_LOCUS.map(([x, y]) => [x, y]);
}

export function gamutTriangle(id: PrimariesId): [number, number][] {
  const { xy } = PRIMARIES[id];
  return [[...xy.r], [...xy.g], [...xy.b]];
}

export function locusPath(
  map: (xy: [number, number]) => [number, number] = ([x, y]) => [x, y],
): string {
  const [sx, sy] = map(CIE1931_LOCUS[0]!);
  const parts = [`M${sx.toFixed(4)},${sy.toFixed(4)}`];
  for (const p of CIE1931_LOCUS.slice(1)) {
    const [x, y] = map(p);
    parts.push(`L${x.toFixed(4)},${y.toFixed(4)}`);
  }
  return `${parts.join('')}Z`;
}
