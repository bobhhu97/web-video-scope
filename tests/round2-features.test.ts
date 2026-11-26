import { describe, expect, it, vi } from 'vitest';
import { cieViewportFrame, frameToScreen } from '../src/core/color/cie-frame';
import { t } from '../src/ui/i18n';
import { describeSample, drawScopeProbeRings } from '../src/ui/probe';
import {
  DEFAULT_PROBE_CONFIG,
  DEFAULT_STATE,
  defaultCellForMode,
  supportsHdrZones,
} from '../src/ui/settings';
import { DEFAULT_SCOPE_OPTIONS } from '../src/gpu/scope-renderer';

describe('Round 2 Features & Fixes', () => {
  it('supportsHdrZones excludes vectorscope and cie', () => {
    expect(supportsHdrZones('waveform-luma')).toBe(true);
    expect(supportsHdrZones('waveform-rgb')).toBe(true);
    expect(supportsHdrZones('waveform-parade')).toBe(true);
    expect(supportsHdrZones('histogram')).toBe(true);
    expect(supportsHdrZones('vectorscope')).toBe(false);
    expect(supportsHdrZones('cie')).toBe(false);
  });

  it('cieViewportFrame reserves top/left/bottom padding so 1976 u’v’ locus never overlaps header', () => {
    const f = cieViewportFrame(400, 260, 'uv', 1, null, null, 1);
    expect(f.scale).toBeGreaterThan(0);
    // Highest u'v' point v' ≈ 0.587 must land strictly below header line (y >= 22px)
    const [, topY] = frameToScreen(f, 0.1, 0.59);
    expect(topY).toBeGreaterThanOrEqual(21);
    // Bottom v'=0 must leave room for x/u' tick labels (y <= h - 18)
    const [, botY] = frameToScreen(f, 0.2, 0.0);
    expect(botY).toBeLessThanOrEqual(260 - 18);
  });

  it('en and zh locales have identical key sets and non-empty translations', () => {
    const en = t('en');
    const zh = t('zh');
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[k].length).toBeGreaterThan(0);
      expect(zh[k].length).toBeGreaterThan(0);
    }
    expect(zh.eyedropper).toBe('吸管');
    expect(zh.falseColor).toBe('伪色');
  });

  it('describeSample computes 8-bit, 10-bit, SDR IRE/nits, HDR PQ nits, CIE xy & u’v’, and hex', () => {
    // 18% middle grey ~ sRGB 118
    const sdr = describeSample([118, 118, 118], 480, 270, 'bt709', { limited: false, depth: 8 }, {
      primaries: 'rec709',
      effectiveTransfer: 'sdr',
      sdrWhiteNits: 203,
      videoWidth: 960,
      videoHeight: 540,
    });
    expect(sdr.rgb).toEqual([118, 118, 118]);
    expect(sdr.rgb10[0]).toBeGreaterThan(460);
    expect(sdr.rgb10[0]).toBeLessThan(485);
    expect(sdr.hex).toBe('#767676');
    // Neutral grey must land at D65 white point in both CIE 1931 xy and CIE 1976 u'v'
    expect(sdr.xy[0]).toBeCloseTo(0.3127, 3);
    expect(sdr.xy[1]).toBeCloseTo(0.329, 3);
    expect(sdr.uv[0]).toBeCloseTo(0.1978, 3);
    expect(sdr.uv[1]).toBeCloseTo(0.4683, 3);
    expect(sdr.nits).toBeGreaterThan(30);
    expect(sdr.nits).toBeLessThan(45);
    expect(sdr.normX).toBeCloseTo(480.5 / 960, 3);

    // HDR PQ: 58% PQ code ≈ 203 nits reference white, 75% PQ ≈ 1000 nits
    const hdr = describeSample([191, 191, 191], 100, 100, 'bt2020', { limited: false, depth: 10 }, {
      primaries: 'rec2020',
      effectiveTransfer: 'pq',
      videoWidth: 1920,
      videoHeight: 1080,
    });
    expect(hdr.nits).toBeGreaterThan(900);
    expect(hdr.nits).toBeLessThan(1100);
  });

  it('drawScopeProbeRings draws rings across all 5 scope types and clears on null', () => {
    const sample = describeSample([220, 120, 60], 240, 135, 'bt709', { limited: true, depth: 8 }, {
      primaries: 'rec709',
      effectiveTransfer: 'sdr',
      videoWidth: 960,
      videoHeight: 540,
    });

    const modes = [
      'waveform-luma',
      'waveform-parade',
      'histogram',
      'vectorscope',
      'cie',
    ] as const;

    for (const mode of modes) {
      const arcSpy = vi.fn();
      const clearSpy = vi.fn();
      const fakeCtx = {
        clearRect: clearSpy,
        save: vi.fn(),
        restore: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        arc: arcSpy,
        stroke: vi.fn(),
        fill: vi.fn(),
        setLineDash: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        strokeStyle: '',
        fillStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
      } as unknown as CanvasRenderingContext2D;

      drawScopeProbeRings(
        fakeCtx,
        { ...DEFAULT_SCOPE_OPTIONS, mode, width: 320, height: 220 },
        sample,
      );
      expect(clearSpy).toHaveBeenCalledWith(0, 0, 320, 220);
      expect(arcSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

      arcSpy.mockClear();
      drawScopeProbeRings(
        fakeCtx,
        { ...DEFAULT_SCOPE_OPTIONS, mode, width: 320, height: 220 },
        null,
      );
      expect(arcSpy).not.toHaveBeenCalled();
    }
  });

  it('defaultCellForMode keeps vectorscope and cie on colorize even if global defaults change', () => {
    expect(DEFAULT_PROBE_CONFIG.showTooltip).toBe(true);
    expect(DEFAULT_PROBE_CONFIG.showScopeRings).toBe(true);
    const vec = defaultCellForMode('vectorscope', DEFAULT_STATE);
    const cie = defaultCellForMode('cie', DEFAULT_STATE);
    expect(vec.traceMode).toBe('colorize');
    expect(cie.traceMode).toBe('colorize');
  });
});
