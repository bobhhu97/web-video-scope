
export type Depth = 8 | 10;

export interface RangeSpec {
  readonly limited: boolean;
  readonly depth: Depth;
}

export const FULL_SCALE: Record<Depth, number> = { 8: 255, 10: 1023 };

const LEGAL: Record<Depth, [number, number]> = { 8: [16, 235], 10: [64, 940] };

export function legalBounds(spec: RangeSpec): {
  black: number;
  white: number;
  min: number;
  max: number;
} {
  const max = FULL_SCALE[spec.depth];
  const [b, w] = LEGAL[spec.depth];
  return spec.limited ? { black: b, white: w, min: 0, max } : { black: 0, white: max, min: 0, max };
}

export function normalizedToCode(n: number, spec: RangeSpec): number {
  const { black, white } = legalBounds(spec);
  return black + (white - black) * n;
}

export function codeToNormalized(code: number, spec: RangeSpec): number {
  const { black, white } = legalBounds(spec);
  return (code - black) / (white - black);
}

export function codeToAxis(code: number, depth: Depth): number {
  return code / FULL_SCALE[depth];
}

export function axisToCode(a: number, depth: Depth): number {
  return a * FULL_SCALE[depth];
}

export function legalAxisBounds(spec: RangeSpec): { black: number; white: number } {
  const { black, white } = legalBounds(spec);
  return { black: codeToAxis(black, spec.depth), white: codeToAxis(white, spec.depth) };
}

/**
 * Display-normalized signal (0..1 in the browser's legal span) mapped onto the
 * code-space axis. This is the exact contract the WGSL `blend()` helper must
 * reproduce; the unit tests below are what keeps the two in sync.
 */
export function displayNormalizedToAxis(v: number, spec: RangeSpec): number {
  return codeToAxis(normalizedToCode(v, spec), spec.depth);
}

/** Axis-space black/span pair uploaded to the accumulate shader. */
export function axisMapping(spec: RangeSpec): { black: number; span: number } {
  const { black, white } = legalAxisBounds(spec);
  return { black, span: white - black };
}
