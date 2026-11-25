
import { describe, expect, it } from 'vitest';
import { RangeDetector } from '../src/core/range-detector';
import { histogramStats } from '../src/core/scopes/stats';

const info = (fullRange: boolean | null, source: 'webcodecs' | 'capture' | 'unknown' = 'webcodecs') => ({
  fullRange,
  matrix: 'bt709' as const,
  primaries: 'rec709' as const,
  transfer: 'bt709' as const,
  format: 'NV12',
  source,
});

const stats = (p001: number, p999: number, belowBlack = 0, aboveWhite = 0) => ({
  p001,
  p999,
  belowBlack,
  aboveWhite,
});

describe('histogramStats', () => {
  it('finds the 0.1% and 99.9% percentiles of a spike', () => {
    const hist = new Uint32Array(256);
    hist[50] = 1000;
    const s = histogramStats(hist, 1000);
    expect(s.p001).toBeCloseTo(50 / 255, 3);
    expect(s.p999).toBeCloseTo(50 / 255, 3);
    expect(s.belowBlack).toBe(0);
    expect(s.aboveWhite).toBe(0);
  });

  it('counts pixels below legal black and above legal white', () => {
    const hist = new Uint32Array(256);
    hist[8] = 50; // below 16/255
    hist[250] = 50; // above 235/255
    const s = histogramStats(hist, 200);
    expect(s.belowBlack).toBeCloseTo(0.25, 6);
    expect(s.aboveWhite).toBeCloseTo(0.25, 6);
  });
});

describe('RangeDetector', () => {
  it('trusts webcodecs metadata immediately', () => {
    const d = new RangeDetector();
    const r = d.push(info(false), stats(0, 1));
    expect(r.effective).toBe('limited');
    expect(r.source).toBe('webcodecs');
  });

  it('warns when full is declared but signal sits in legal window', () => {
    const d = new RangeDetector(3);
    let r = d.push(info(true), stats(0.06, 0.92));
    expect(r.warning).toBeNull();
    d.push(info(true), stats(0.06, 0.92));
    r = d.push(info(true), stats(0.06, 0.92));
    expect(r.warning).toBe('limited-treated-as-full');
  });

  it('warns when limited is declared but signal exceeds legal window', () => {
    const d = new RangeDetector(3);
    for (let i = 0; i < 3; i++) {
      d.push(info(false), stats(0.005, 0.995, 0.04, 0.03));
    }
    const r = d.push(info(false), stats(0.005, 0.995, 0.04, 0.03));
    expect(r.warning).toBe('full-treated-as-limited');
  });

  it('does not warn on a normally exposed full-range video', () => {
    const d = new RangeDetector(3);
    let r = d.push(info(true), stats(0.002, 0.99, 0.001, 0.001));
    for (let i = 0; i < 3; i++) r = d.push(info(true), stats(0.002, 0.99, 0.001, 0.001));
    expect(r.warning).toBeNull();
  });

  it('falls back to heuristics when metadata is missing', () => {
    const d = new RangeDetector();
    const r = d.push(info(null, 'capture'), stats(0.06, 0.92));
    expect(r.effective).toBe('limited');
    expect(r.source).toBe('heuristic');
  });

  it('honours hysteresis: single black frame does not trigger a warning', () => {
    const d = new RangeDetector(3);
    let r = d.push(info(true), stats(0.002, 0.99));
    r = d.push(info(true), stats(0.5, 0.52));
    r = d.push(info(true), stats(0.002, 0.99));
    expect(r.warning).toBeNull();
  });
});
