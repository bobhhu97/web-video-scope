import { describe, expect, it } from 'vitest';
import { ANALYSIS_SIZES, analysisSize } from '../src/gpu/downscale';

describe('analysisSize', () => {
  it('scales 1080p landscape to 640x360 by default', () => {
    expect(analysisSize(1920, 1080, 'default')).toEqual({ width: 640, height: 360 });
  });

  it('scales 4K to the same analysis size (source resolution independent)', () => {
    expect(analysisSize(3840, 2160, 'default')).toEqual({ width: 640, height: 360 });
  });

  it('swaps axes for portrait video', () => {
    const s = analysisSize(1080, 1920, 'default');
    expect(s.width).toBe(360);
    expect(s.height).toBe(640);
  });

  it('keeps the aspect ratio within one percent', () => {
    for (const [w, h] of [[1920, 1080], [1440, 1080], [3840, 1600], [1080, 1080]] as const) {
      const s = analysisSize(w, h, 'default');
      expect(Math.abs(s.width / s.height - w / h)).toBeLessThan(0.01);
    }
  });

  it('never upscales a source smaller than the analysis size', () => {
    expect(analysisSize(320, 180, 'default')).toEqual({ width: 320, height: 180 });
    expect(analysisSize(640, 360, 'default')).toEqual({ width: 640, height: 360 });
  });

  it('presets are defined by long edge', () => {
    expect(ANALYSIS_SIZES.low).toBe(320);
    expect(ANALYSIS_SIZES.default).toBe(640);
    expect(ANALYSIS_SIZES.high).toBe(854);
    expect(analysisSize(1920, 1080, 'low')).toEqual({ width: 320, height: 180 });
    expect(analysisSize(1920, 1080, 'default')).toEqual({ width: 640, height: 360 });
  });

  it('stays under the pixel budget on every preset', () => {
    for (const preset of ['low', 'default', 'high'] as const) {
      const s2 = analysisSize(3840, 2160, preset);
      expect(s2.width * s2.height).toBeLessThanOrEqual(400_000);
    }
  });

  it('honours a pixel budget cap', () => {
    const capped = analysisSize(1920, 1080, 'high', 100_000);
    expect(capped.width * capped.height).toBeLessThanOrEqual(100_000);
  });

  it('never returns a zero dimension', () => {
    for (const [w, h] of [[1, 1], [1, 1000], [1000, 1], [3, 2]] as const) {
      const s = analysisSize(w, h, 'default');
      expect(s.width).toBeGreaterThanOrEqual(1);
      expect(s.height).toBeGreaterThanOrEqual(1);
    }
  });

  it('is stable: applying it twice changes nothing', () => {
    const once = analysisSize(1920, 1080, 'default');
    const twice = analysisSize(once.width, once.height, 'default');
    expect(twice).toEqual(once);
  });
});
