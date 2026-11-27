import { describe, it, expect } from 'vitest';
import {
  CAPTURE_SCALE_OPTIONS,
  DEFAULT_CAPTURE,
  PANEL_BG,
  PAPER_BG,
  captureFileName,
  describeSize,
  effectiveBackground,
  formatInfo,
  graticuleThemeFor,
  planCapture,
  type CapturePlanRequest,
} from '../src/core/scopes/capture-plan';
import { WAVE_PAD } from '../src/ui/graticule';

const LIMITS = { maxEdge: 8192, maxDensityBytes: 128 * 1024 * 1024 };

function req(over: Partial<CapturePlanRequest> = {}): CapturePlanRequest {
  return {
    cssWidth: 480,
    cssHeight: 270,
    scale: 2,
    mode: 'waveform-luma',
    planes: 1,
    wavePad: WAVE_PAD,
    ...LIMITS,
    ...over,
  };
}

describe('planCapture', () => {
  it('multiplies the CSS size by the requested scale', () => {
    const plan = planCapture(req({ scale: 2 }));
    expect(plan.cssWidth).toBe(480);
    expect(plan.cssHeight).toBe(270);
    expect(plan.scale).toBe(2);
    expect(plan.width).toBe(960);
    expect(plan.height).toBe(540);
    expect(plan.clamped).toBe(false);
  });

  it('keeps the aspect ratio at every multiplier', () => {
    const ratio = 480 / 270;
    for (const scale of [1, 2, 3, 4] as const) {
      const plan = planCapture(req({ scale }));
      expect(Math.abs(plan.width / plan.height - ratio)).toBeLessThan(0.01);
    }
  });

  it('resolves match to the source width without exceeding the edge cap', () => {
    const plan = planCapture(req({ scale: 'match', sourceWidth: 1920 }));
    expect(plan.scale).toBe(4);
    expect(plan.width).toBe(1920);
    expect(plan.height).toBe(1080);
  });

  it('clamps match when the source is wider than the texture edge', () => {
    const plan = planCapture(req({ scale: 'match', sourceWidth: 15360 }));
    expect(plan.width).toBeLessThanOrEqual(LIMITS.maxEdge);
    expect(plan.height).toBeLessThanOrEqual(LIMITS.maxEdge);
    expect(plan.clamped).toBe(true);
  });

  it('shrinks below the request when the density buffer would not fit 4K four-plane', () => {
    const plan = planCapture(req({ cssWidth: 1920, cssHeight: 1080, scale: 2, planes: 5 }));
    expect(plan.clamped).toBe(true);
    expect(plan.scale).toBeLessThan(2);
    // Density budget must hold at the size we actually allocate.
    const padL = Math.round(WAVE_PAD.left * plan.scale);
    const padR = Math.round(WAVE_PAD.right * plan.scale);
    const padT = Math.round(WAVE_PAD.top * plan.scale);
    const padB = Math.round(WAVE_PAD.bottom * plan.scale);
    const w = plan.width - padL - padR;
    const h = plan.height - padT - padB;
    expect(5 * w * h * 4).toBeLessThanOrEqual(LIMITS.maxDensityBytes);
  });

  it('never returns a zero-sized image', () => {
    const plan = planCapture(
      req({ cssWidth: 0, cssHeight: 0, scale: 4, maxEdge: 1, maxDensityBytes: 256 }),
    );
    expect(plan.width).toBeGreaterThanOrEqual(1);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });

  it('does not pad vectorscope or cie, which draw edge to edge', () => {
    const wide = planCapture(req({ mode: 'vectorscope', cssWidth: 400, cssHeight: 300, planes: 1 }));
    const histogram = planCapture(req({ mode: 'histogram', cssWidth: 400, cssHeight: 300, planes: 1 }));
    // CIE/vectorscope can afford a larger scale for the same density budget.
    expect(wide.scale).toBeGreaterThanOrEqual(histogram.scale);
  });

  it('offers the documented multiplier set', () => {
    expect(CAPTURE_SCALE_OPTIONS).toEqual([1, 2, 3, 4, 'match']);
  });
});

describe('capture format helpers', () => {
  it('defaults to a lossless transparent PNG', () => {
    expect(DEFAULT_CAPTURE).toEqual({ format: 'png', scale: 2, background: 'transparent' });
  });

  it('maps formats to mime types, extensions and quality', () => {
    expect(formatInfo('png')).toEqual({ mime: 'image/png', ext: 'png' });
    expect(formatInfo('jpeg')).toEqual({ mime: 'image/jpeg', ext: 'jpg', quality: 0.92 });
    expect(formatInfo('webp')).toEqual({ mime: 'image/webp', ext: 'webp', quality: 0.95 });
  });

  it('downgrades transparent jpeg to white paper', () => {
    expect(effectiveBackground('jpeg', 'transparent')).toBe('white');
    expect(effectiveBackground('png', 'transparent')).toBe('transparent');
    expect(effectiveBackground('webp', 'transparent')).toBe('transparent');
    expect(effectiveBackground('jpeg', 'panel')).toBe('panel');
  });

  it('uses dark ink only on the panel background', () => {
    expect(graticuleThemeFor('panel')).toBe('dark');
    expect(graticuleThemeFor('transparent')).toBe('light');
    expect(graticuleThemeFor('white')).toBe('light');
  });

  it('names files with mode, sortable timestamp and extension', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(captureFileName('waveform-luma', at, 'png')).toBe('scope-waveform-luma-20260102-030405.png');
    expect(captureFileName('cie', at, 'jpeg')).toBe('scope-cie-20260102-030405.jpg');
    expect(captureFileName('vectorscope', at, 'webp')).toBe('scope-vectorscope-20260102-030405.webp');
  });

  it('formats sizes for the UI and exports the palette constants', () => {
    expect(describeSize(3840, 2160)).toBe('3840 × 2160');
    expect(PANEL_BG).toBe('#0a0e12');
    expect(PAPER_BG).toBe('#ffffff');
  });
});
