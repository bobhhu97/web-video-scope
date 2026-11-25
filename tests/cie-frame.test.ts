import { describe, expect, it } from 'vitest';
import {
  CIE_BOUNDS,
  WHITE_POINT,
  cieFrame,
  frameToScreen,
  screenToFrame,
} from '../src/core/color/cie-frame';

/**
 * The CIE diagram is only meaningful at 1:1 axis scale: x and y are the same kind
 * of quantity. Stretching the data bounds to fill a wide panel squashed the
 * horseshoe by 86% (measured in the browser), which is what prompted these tests.
 */
describe('cieFrame aspect ratio', () => {
  const shapes: [number, number][] = [
    [1600, 400], // very wide, the worst case
    [400, 1600], // very tall
    [800, 800], // square
    [1200, 500], // roughly a 2-up cell
    [275, 142], // a grid cell at 2x DPR
  ];

  for (const [w, h] of shapes) {
    it(`keeps one pixel per unit on both axes at ${w}x${h}`, () => {
      const f = cieFrame(w, h, 'xy');
      const [x1, y1] = frameToScreen(f, 0.2, 0.2);
      const [x2, y2] = frameToScreen(f, 0.6, 0.2);
      const [x3, y3] = frameToScreen(f, 0.2, 0.6);
      const pxPerUnitX = Math.abs(x2 - x1) / 0.4;
      const pxPerUnitY = Math.abs(y3 - y2) / 0.4;
      expect(pxPerUnitX).toBeCloseTo(pxPerUnitY, 6);
    });
  }

  it('fits entirely inside the canvas', () => {
    for (const [w, h] of shapes) {
      const f = cieFrame(w, h, 'xy');
      expect(f.left).toBeGreaterThanOrEqual(-1e-6);
      expect(f.top).toBeGreaterThanOrEqual(-1e-6);
      expect(f.left + f.width).toBeLessThanOrEqual(w + 1e-6);
      expect(f.top + f.height).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('centres the plot, leaving equal margins', () => {
    const f = cieFrame(1600, 400, 'xy');
    const marginLeft = f.left;
    const marginRight = 1600 - (f.left + f.width);
    expect(marginLeft).toBeCloseTo(marginRight, 6);
  });

  it('shows the full published bounds when not zoomed', () => {
    const f = cieFrame(800, 800, 'xy');
    expect(f.x0).toBeCloseTo(CIE_BOUNDS.xy[0], 6);
    expect(f.x1).toBeCloseTo(CIE_BOUNDS.xy[2], 6);
    expect(f.y0).toBeCloseTo(CIE_BOUNDS.xy[1], 6);
    expect(f.y1).toBeCloseTo(CIE_BOUNDS.xy[3], 6);
  });
});

describe('cieFrame zoom', () => {
  it('narrows the visible span as zoom rises', () => {
    const a = cieFrame(800, 800, 'xy', 1);
    const b = cieFrame(800, 800, 'xy', 4);
    expect(b.x1 - b.x0).toBeCloseTo((a.x1 - a.x0) / 4, 6);
    expect(b.y1 - b.y0).toBeCloseTo((a.y1 - a.y0) / 4, 6);
  });

  it('keeps the white point near the centre of the view once zoomed', () => {
    // At zoom 1 the full published bounds are shown, so the white point sits
    // where it belongs within them (39% across, not centred). Once zoomed in
    // there is room to centre on it, which is the useful behaviour.
    for (const z of [2, 4, 8]) {
      const f = cieFrame(800, 800, 'xy', z);
      const [px, py] = frameToScreen(f, WHITE_POINT.xy[0], WHITE_POINT.xy[1]);
      const cx = f.left + f.width / 2;
      const cy = f.top + f.height / 2;
      // Near the edges of the bounds the view cannot centre further, but the
      // white point is well inside, so it should be centred at every zoom.
      expect(Math.abs(px - cx)).toBeLessThan(2);
      expect(Math.abs(py - cy)).toBeLessThan(2);
    }
  });

  it('never zooms out past the published bounds', () => {
    const f = cieFrame(800, 800, 'xy', 0.5);
    expect(f.x0).toBeCloseTo(CIE_BOUNDS.xy[0], 6);
    expect(f.x1).toBeCloseTo(CIE_BOUNDS.xy[2], 6);
  });

  it('stays inside the bounds when zoomed', () => {
    for (const z of [2, 6, 16]) {
      const f = cieFrame(800, 800, 'xy', z);
      expect(f.x0).toBeGreaterThanOrEqual(CIE_BOUNDS.xy[0] - 1e-9);
      expect(f.x1).toBeLessThanOrEqual(CIE_BOUNDS.xy[2] + 1e-9);
      expect(f.y0).toBeGreaterThanOrEqual(CIE_BOUNDS.xy[1] - 1e-9);
      expect(f.y1).toBeLessThanOrEqual(CIE_BOUNDS.xy[3] + 1e-9);
    }
  });
});

describe('frame round trip', () => {
  it('screenToFrame inverts frameToScreen', () => {
    for (const coord of ['xy', 'uv'] as const) {
      const f = cieFrame(640, 360, coord, 3);
      for (const [x, y] of [
        [0.2, 0.3],
        [0.4, 0.5],
      ] as const) {
        const [px, py] = frameToScreen(f, x, y);
        const [bx, by] = screenToFrame(f, px, py);
        expect(bx).toBeCloseTo(x, 9);
        expect(by).toBeCloseTo(y, 9);
      }
    }
  });

  it('puts y = 0 at the bottom of the plot box', () => {
    const f = cieFrame(500, 500, 'xy');
    const [, py] = frameToScreen(f, 0.1, 0);
    expect(py).toBeCloseTo(f.top + f.height, 6);
  });
});
