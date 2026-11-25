import { PRIMARIES, type PrimariesId } from './primaries';
import { CIE1931_LOCUS, SPECTRAL_WAVELENGTHS } from './locus-data';

export { CIE1931_LOCUS, SPECTRAL_WAVELENGTHS };

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
  const [sx, sy] = map([...CIE1931_LOCUS[0]!] as [number, number]);
  const parts = [`M${sx.toFixed(4)},${sy.toFixed(4)}`];
  for (const p of CIE1931_LOCUS.slice(1)) {
    const [x, y] = map([p[0], p[1]]);
    parts.push(`L${x.toFixed(4)},${y.toFixed(4)}`);
  }
  return `${parts.join('')}Z`;
}
