
export interface LumaStats {
  p001: number;
  p999: number;
  belowBlack: number;
  aboveWhite: number;
}

const BLACK_NORM = 16 / 255;
const WHITE_NORM = 235 / 255;

export function histogramStats(hist: Uint32Array, total: number): LumaStats {
  const bins = hist.length;
  const find = (targetFraction: number): number => {
    const target = total * targetFraction;
    let acc = 0;
    for (let i = 0; i < bins; i++) {
      acc += hist[i]!;
      if (acc >= target) return i / (bins - 1);
    }
    return 1;
  };
  let below = 0;
  let above = 0;
  for (let i = 0; i < bins; i++) {
    const n = hist[i]!;
    if (i / (bins - 1) < BLACK_NORM) below += n;
    if (i / (bins - 1) > WHITE_NORM) above += n;
  }
  return {
    p001: find(0.001),
    p999: find(0.999),
    belowBlack: total === 0 ? 0 : below / total,
    aboveWhite: total === 0 ? 0 : above / total,
  };
}
