import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SIZES,
  FIXED_PRESETS,
  MAX_ANALYSIS_EDGE,
  analysisSize,
  largestFixedPreset,
  normalizePrecision,
  presetAvailable,
  presetNeedsEdge,
} from '../src/gpu/downscale';

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

  it('rejects non-finite source sizes instead of allocating a NaN texture', () => {
    // A detached <video> reports NaN dimensions; `NaN <= 0` is false, so this
    // has to be an explicit finiteness check.
    expect(analysisSize(Number.NaN, 1080, 'full')).toEqual({ width: 1, height: 1 });
    expect(analysisSize(1920, Number.NaN, 'default')).toEqual({ width: 1, height: 1 });
    expect(analysisSize(Number.POSITIVE_INFINITY, 1080, 'full')).toEqual({ width: 1, height: 1 });
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

  describe('full preset', () => {
    it('analyses 1080p at 1:1', () => {
      expect(analysisSize(1920, 1080, 'full')).toEqual({ width: 1920, height: 1080 });
    });

    it('analyses 4K at 1:1', () => {
      expect(analysisSize(3840, 2160, 'full')).toEqual({ width: 3840, height: 2160 });
    });

    it('analyses 8K at 1:1 (exactly the texture edge cap)', () => {
      expect(analysisSize(7680, 4320, 'full')).toEqual({ width: 7680, height: 4320 });
    });

    it('keeps portrait 1:1', () => {
      expect(analysisSize(1080, 1920, 'full')).toEqual({ width: 1080, height: 1920 });
    });

    it('does not upscale a source smaller than any preset', () => {
      expect(analysisSize(320, 180, 'full')).toEqual({ width: 320, height: 180 });
    });

    it('clamps sources beyond the 8192 edge instead of failing texture creation', () => {
      const s = analysisSize(15360, 8640, 'full');
      expect(Math.max(s.width, s.height)).toBe(MAX_ANALYSIS_EDGE);
      expect(Math.abs(s.width / s.height - 15360 / 8640)).toBeLessThan(0.01);
    });

    it('is strictly larger than fhd', () => {
      const full = analysisSize(3840, 2160, 'full');
      const fhd = analysisSize(3840, 2160, 'fhd');
      expect(full.width * full.height).toBeGreaterThan(fhd.width * fhd.height);
    });
  });
});

describe('preset availability', () => {
  it('lists every fixed preset and leaves full out', () => {
    expect([...FIXED_PRESETS]).toEqual(['low', 'default', 'high', 'ultra', 'fhd']);
  });

  it('reports the long edge each preset needs', () => {
    expect(presetNeedsEdge('low')).toBe(ANALYSIS_SIZES.low);
    expect(presetNeedsEdge('fhd')).toBe(1920);
    // `full` follows the source, so nothing can make it unavailable.
    expect(presetNeedsEdge('full')).toBe(0);
  });

  it('keeps every preset selectable while the source size is unknown', () => {
    for (const preset of [...FIXED_PRESETS, 'full'] as const) {
      expect(presetAvailable(preset, undefined, undefined)).toBe(true);
      expect(presetAvailable(preset, 0, 0)).toBe(true);
    }
  });

  it('disables a preset when the source long edge is shorter than it', () => {
    expect(presetAvailable('fhd', 1280, 720)).toBe(false);
    expect(presetAvailable('fhd', 1920, 1080)).toBe(true);
    expect(presetAvailable('fhd', 3840, 2160)).toBe(true);
    expect(presetAvailable('ultra', 1280, 720)).toBe(true);
    expect(presetAvailable('ultra', 1024, 576)).toBe(false);
  });

  it('always allows full regardless of source size', () => {
    expect(presetAvailable('full', 320, 180)).toBe(true);
    expect(presetAvailable('full', 1280, 720)).toBe(true);
  });

  it('uses the long edge so portrait sources are judged correctly', () => {
    // 1080x1920 portrait: long edge 1920 still feeds FHD.
    expect(presetAvailable('fhd', 1080, 1920)).toBe(true);
    expect(presetAvailable('ultra', 720, 1280)).toBe(true);
    expect(presetAvailable('ultra', 576, 1024)).toBe(false);
  });

  it('falls back to the largest preset the source can still feed', () => {
    expect(largestFixedPreset(3840, 2160)).toBe('fhd');
    expect(largestFixedPreset(1920, 1080)).toBe('fhd');
    expect(largestFixedPreset(1280, 720)).toBe('ultra');
    expect(largestFixedPreset(1024, 576)).toBe('high');
    expect(largestFixedPreset(640, 360)).toBe('default');
    expect(largestFixedPreset(320, 180)).toBe('low');
    expect(largestFixedPreset(0, 0)).toBe('fhd');
  });

  it('migrates the retired native preset name', () => {
    expect(normalizePrecision('native')).toBe('fhd');
    expect(normalizePrecision('fhd')).toBe('fhd');
    expect(normalizePrecision('auto')).toBe('auto');
    expect(normalizePrecision('full')).toBe('full');
  });

  it('falls back to auto for values we no longer understand', () => {
    expect(normalizePrecision(undefined)).toBe('auto');
    expect(normalizePrecision(null)).toBe('auto');
    expect(normalizePrecision('4k')).toBe('auto');
    expect(normalizePrecision(720)).toBe('auto');
  });
});
