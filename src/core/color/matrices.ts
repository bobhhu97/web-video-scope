
export type MatrixId = 'bt709' | 'bt601' | 'bt2020';

export interface LumaCoefficients {
  readonly kr: number;
  readonly kg: number;
  readonly kb: number;
}

export const LUMA: Record<MatrixId, LumaCoefficients> = {
  bt709: { kr: 0.2126, kg: 0.7152, kb: 0.0722 },
  bt601: { kr: 0.299, kg: 0.587, kb: 0.114 },
  bt2020: { kr: 0.2627, kg: 0.678, kb: 0.0593 },
};

export type BarName = 'red' | 'yellow' | 'green' | 'cyan' | 'blue' | 'magenta';

const BAR_RGB: Record<BarName, [number, number, number]> = {
  red: [1, 0, 0],
  yellow: [1, 1, 0],
  green: [0, 1, 0],
  cyan: [0, 1, 1],
  blue: [0, 0, 1],
  magenta: [1, 0, 1],
};

export const SKIN_TONE_ANGLE_DEG = 123;

export function luma(r: number, g: number, b: number, c: LumaCoefficients): number {
  return c.kr * r + c.kg * g + c.kb * b;
}

export function chroma(
  r: number,
  g: number,
  b: number,
  c: LumaCoefficients,
): { cb: number; cr: number } {
  const y = luma(r, g, b, c);
  return {
    cb: (b - y) / (2 * (1 - c.kb)),
    cr: (r - y) / (2 * (1 - c.kr)),
  };
}

export interface ChromaTarget {
  name: BarName;
  y: number;
  cb: number;
  cr: number;
  angleDeg: number;
  radius: number;
}

export function chromaTargets(c: LumaCoefficients, level: number): ChromaTarget[] {
  return (Object.keys(BAR_RGB) as BarName[]).map((name) => {
    const [r, g, b] = BAR_RGB[name].map((v) => v * level) as [number, number, number];
    const y = luma(r, g, b, c);
    const { cb, cr } = chroma(r, g, b, c);
    return {
      name,
      y,
      cb,
      cr,
      angleDeg: (Math.atan2(cr, cb) * 180) / Math.PI,
      radius: Math.hypot(cb, cr),
    };
  });
}
