import { describe, expect, it } from 'vitest';
import { axisToCanvasY, canvasYToAxis } from '../src/ui/graticule';

const TOP = 8;
const HEIGHT = 400;

describe('waveform axis geometry', () => {
  it('axis 1 maps to the top of the plot', () => {
    expect(axisToCanvasY(1, TOP, HEIGHT)).toBeCloseTo(TOP, 6);
  });
  it('axis 0 maps to the bottom of the plot', () => {
    expect(axisToCanvasY(0, TOP, HEIGHT)).toBeCloseTo(TOP + HEIGHT, 6);
  });
  it('axis 0.5 maps to the vertical centre', () => {
    expect(axisToCanvasY(0.5, TOP, HEIGHT)).toBeCloseTo(TOP + HEIGHT / 2, 6);
  });
  it('limited legal black (16/255) is visibly above the bottom', () => {
    const y = axisToCanvasY(16 / 255, TOP, HEIGHT);
    expect(TOP + HEIGHT - y).toBeCloseTo((16 / 255) * HEIGHT, 6);
    expect(y).toBeLessThan(TOP + HEIGHT - 20);
  });
  it('limited legal white (235/255) is visibly below the top', () => {
    const y = axisToCanvasY(235 / 255, TOP, HEIGHT);
    expect(y).toBeGreaterThan(TOP + 20);
  });
  it('round-trips through canvasYToAxis', () => {
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      expect(canvasYToAxis(axisToCanvasY(a, TOP, HEIGHT), TOP, HEIGHT)).toBeCloseTo(a, 9);
    }
  });
  it('zoom magnifies around axis 0', () => {
    const z2 = axisToCanvasY(0.5, TOP, HEIGHT, 2);
    expect(TOP + HEIGHT - z2).toBeCloseTo(HEIGHT, 6);
  });
  it('zoom 1 is the identity', () => {
    expect(axisToCanvasY(0.37, TOP, HEIGHT, 1)).toBeCloseTo(axisToCanvasY(0.37, TOP, HEIGHT), 9);
  });
  it('clamps zoomed-out-of-plot values to the plot edge instead of escaping', () => {
    const y = axisToCanvasY(0.9, TOP, HEIGHT, 2);
    expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
    expect(y).toBeLessThanOrEqual(TOP + HEIGHT + 1e-6);
  });
});
