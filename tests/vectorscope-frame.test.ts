import { describe, expect, it } from 'vitest';
import { LUMA, chromaTargets } from '../src/core/color/matrices';
import {
  VECTORSCOPE_FULL_SCALE,
  insideVectorscopeDisc,
  screenToVectorscope,
  vectorscopeFrame,
  vectorscopeToScreen,
} from '../src/core/color/vectorscope-frame';

describe('vectorscopeFrame', () => {
  it('keeps 1:1 isotropic chroma scale in wide and tall cells', () => {
    for (const [w, h] of [
      [500, 220], // wide 4-up grid cell (previously stretched 2.27x horizontally!)
      [220, 500],
      [600, 600],
    ] as const) {
      const f = vectorscopeFrame(w, h, 1);
      const [x0, y0] = vectorscopeToScreen(f, 0, 0);
      const [x1] = vectorscopeToScreen(f, 0.3, 0);
      const [, y2] = vectorscopeToScreen(f, 0, 0.3);
      expect(x1 - x0).toBeCloseTo(y0 - y2, 6);
    }
  });

  it('scales homogeneously with DPR so CSS graticule and Retina data match', () => {
    const css = vectorscopeFrame(410, 195, 2);
    const dev = vectorscopeFrame(410 * 2, 195 * 2, 2);
    expect(dev.cx).toBeCloseTo(css.cx * 2, 6);
    expect(dev.cy).toBeCloseTo(css.cy * 2, 6);
    expect(dev.radius).toBeCloseTo(css.radius * 2, 6);
    expect(dev.scale).toBeCloseTo(css.scale * 2, 6);
  });

  it('fits all six 75% and all six 100% colour-bar targets inside the outer ring at 1x', () => {
    const f = vectorscopeFrame(440, 220, 1);
    for (const matrix of [LUMA.bt709, LUMA.bt601, LUMA.bt2020]) {
      for (const level of [0.75, 1] as const) {
        for (const t of chromaTargets(matrix, level)) {
          expect(t.radius).toBeLessThan(VECTORSCOPE_FULL_SCALE);
          const [px, py] = vectorscopeToScreen(f, t.cb, t.cr);
          expect(insideVectorscopeDisc(f, px, py)).toBe(true);
        }
      }
    }
  });

  it('keeps the outer ring radius fixed on screen when zooming in', () => {
    const z1 = vectorscopeFrame(400, 240, 1);
    const z4 = vectorscopeFrame(400, 240, 4);
    expect(z4.radius).toBeCloseTo(z1.radius, 6);
    expect(z4.scale).toBeCloseTo(z1.scale * 4, 6);
  });

  it('round-trips through screenToVectorscope', () => {
    const f = vectorscopeFrame(480, 260, 3);
    for (const [cb, cr] of [
      [0, 0],
      [-0.1146, 0.5],
      [0.3854, 0.4542],
    ] as const) {
      const [px, py] = vectorscopeToScreen(f, cb, cr);
      const [bCb, bCr] = screenToVectorscope(f, px, py);
      expect(bCb).toBeCloseTo(cb, 9);
      expect(bCr).toBeCloseTo(cr, 9);
    }
  });
});
