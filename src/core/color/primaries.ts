
export type PrimariesId = 'rec709' | 'p3' | 'rec2020';

export interface Primaries {
  readonly id: PrimariesId;
  readonly xy: { r: [number, number]; g: [number, number]; b: [number, number] };
  readonly white: [number, number];
  readonly rgbToXyz: readonly (readonly [number, number, number])[];
}

export const PRIMARIES: Record<PrimariesId, Primaries> = {
  rec709: {
    id: 'rec709',
    xy: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06] },
    white: [0.3127, 0.329],
    rgbToXyz: [
      [0.412391, 0.357584, 0.180481],
      [0.212639, 0.715169, 0.072192],
      [0.019331, 0.119195, 0.950532],
    ],
  },
  p3: {
    id: 'p3',
    xy: { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
    white: [0.3127, 0.329],
    rgbToXyz: [
      [0.486571, 0.265668, 0.198217],
      [0.228975, 0.691739, 0.079287],
      [0.0, 0.045113, 1.043944],
    ],
  },
  rec2020: {
    id: 'rec2020',
    xy: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046] },
    white: [0.3127, 0.329],
    rgbToXyz: [
      [0.636958, 0.144617, 0.168881],
      [0.2627, 0.677998, 0.059302],
      [0.0, 0.028073, 1.060985],
    ],
  },
};

export function linearRgbToXyz(
  rgb: [number, number, number],
  id: PrimariesId,
): [number, number, number] {
  const m = PRIMARIES[id].rgbToXyz;
  const [r, g, b] = rgb;
  return [
    m[0]![0] * r + m[0]![1] * g + m[0]![2] * b,
    m[1]![0] * r + m[1]![1] * g + m[1]![2] * b,
    m[2]![0] * r + m[2]![1] * g + m[2]![2] * b,
  ];
}

export function xyzToXY(xyz: [number, number, number]): [number, number] {
  const [x, y, z] = xyz;
  const s = x + y + z;
  return s < 1e-9 ? [0, 0] : [x / s, y / s];
}

export function xyzToUV(xyz: [number, number, number]): [number, number] {
  const [x, y, z] = xyz;
  const d = x + 15 * y + 3 * z;
  return d < 1e-9 ? [0, 0] : [(4 * x) / d, (9 * y) / d];
}
