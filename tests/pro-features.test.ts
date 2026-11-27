import { describe, expect, it } from 'vitest';
import {
  SDR_DIFFUSE_WHITE_NITS,
  hlgToLinear,
  hlgToNits,
  linearToHlg,
  nitsToHlg,
  nitsToPq,
  pqToNits,
} from '../src/core/color/transfer';
import {
  axisToNitsForTransfer,
  nitsToAxisForTransfer,
  resolveEffectiveTransfer,
  resolveEffectiveUnit,
  tickValues,
} from '../src/core/scale/units';
import { analysisSize } from '../src/gpu/downscale';
import { floatToHalfBits, p010Layout, splitP010 } from '../src/gpu/raw-planes';
import { vectorscopeFrame, zoomVectorscopeAt } from '../src/core/color/vectorscope-frame';
import { cieFrame, frameToScreen, zoomCieAt } from '../src/core/color/cie-frame';
import {
  DEFAULT_STATE,
  assignCellSlot,
  defaultCellForMode,
  resolveCells,
  type HudState,
} from '../src/ui/settings';

describe('ITU-R BT.2100 HLG & PQ HDR transfer functions', () => {
  it('round-trips linear <-> HLG signal across dark and highlight regions', () => {
    for (const l of [0, 0.01, 1 / 12, 0.25, 0.5, 1.0]) {
      const e = linearToHlg(l);
      expect(hlgToLinear(e)).toBeCloseTo(l, 5);
    }
  });

  it('maps HLG nominal 1000-nit display nits <-> HLG code and places 203 nits near 75% HLG', () => {
    for (const nits of [0, 10, 100, SDR_DIFFUSE_WHITE_NITS, 500, 1000]) {
      const e = nitsToHlg(nits);
      expect(hlgToNits(e)).toBeCloseTo(nits, 2);
    }
    // Per ITU-R BT.2408, HDR reference white (203 nits) sits right around 75% HLG signal.
    expect(nitsToHlg(203)).toBeGreaterThan(0.74);
    expect(nitsToHlg(203)).toBeLessThan(0.76);
  });

  it('auto-switches vertical scale units for SDR, PQ, and HLG while honouring manual overrides', () => {
    expect(resolveEffectiveTransfer('auto', 'srgb')).toBe('sdr');
    expect(resolveEffectiveTransfer('auto', 'pq')).toBe('pq');
    expect(resolveEffectiveTransfer('auto', 'hlg')).toBe('hlg');
    expect(resolveEffectiveTransfer('pq', 'bt709')).toBe('pq');

    expect(resolveEffectiveUnit('auto', 'sdr')).toBe('ire');
    expect(resolveEffectiveUnit('auto', 'pq')).toBe('nits');
    expect(resolveEffectiveUnit('auto', 'hlg')).toBe('hlg');
    expect(resolveEffectiveUnit('code10', 'pq')).toBe('code10');
  });

  it('projects dual-Nit thresholds consistently onto SDR, PQ, and HLG scope axes', () => {
    const spec = { limited: false, depth: 10 as const };
    for (const tr of ['sdr', 'pq', 'hlg'] as const) {
      const target = tr === 'sdr' ? 100 : 1000;
      const axis = nitsToAxisForTransfer(target, tr, spec);
      expect(axis).toBeGreaterThan(0);
      expect(axis).toBeLessThanOrEqual(1);
      expect(axisToNitsForTransfer(axis, tr, spec)).toBeCloseTo(target, 1);
    }
    expect(nitsToAxisForTransfer(1000, 'pq', spec)).toBeCloseTo(nitsToPq(1000), 5);
    expect(pqToNits(nitsToAxisForTransfer(1000, 'pq', spec))).toBeCloseTo(1000, 1);
  });

  it('provides zoomed sub-ticks and HDR-specific reference ticks', () => {
    const spec = { limited: true, depth: 10 as const };
    const pqBase = tickValues('nits', spec, 1);
    const pqZoom = tickValues('nits', spec, 4);
    expect(pqBase.some((a) => Math.abs(a - nitsToPq(100)) < 1e-4)).toBe(true);
    expect(pqBase.some((a) => Math.abs(a - nitsToPq(1000)) < 1e-4)).toBe(true);
    expect(pqZoom.length).toBeGreaterThan(pqBase.length);
    expect(pqZoom.some((a) => Math.abs(a - nitsToPq(203)) < 1e-4)).toBe(true);
  });
});

describe('multi-tier analysis precision & 10-bit P010 raw planes', () => {
  it('computes monotonically increasing analysis budgets across all 6 precision presets', () => {
    const low = analysisSize(3840, 2160, 'low');
    const def = analysisSize(3840, 2160, 'default');
    const high = analysisSize(3840, 2160, 'high');
    const ultra = analysisSize(3840, 2160, 'ultra');
    const native = analysisSize(1920, 1080, 'native');
    const full = analysisSize(3840, 2160, 'full');

    expect(low.width).toBe(320);
    expect(def.width).toBe(640);
    expect(high.width).toBeGreaterThan(def.width);
    expect(ultra.width).toBe(1280);
    expect(native).toEqual({ width: 1920, height: 1080 });
    expect(full).toEqual({ width: 3840, height: 2160 });
    expect(full.width * full.height).toBeGreaterThan(native.width * native.height);
  });

  it('splits 10-bit P010 buffers into 16-bit luma and interleaved UV views', () => {
    const w = 4;
    const h = 2;
    const layout = p010Layout(w, h);
    const totalBytes = layout.uvOffset + layout.uvStride * layout.uvHeight;
    const bytes = new Uint8Array(totalBytes);
    const words = new Uint16Array(bytes.buffer);
    // P010 stores 10-bit code in the high bits (code << 6).
    words[0] = 940 << 6;
    words[w * h] = 512 << 6;
    words[w * h + 1] = 768 << 6;

    const split = splitP010(bytes, w, h);
    expect(split.y16.length).toBe(w * h);
    expect(split.uv16.length).toBe(w * layout.uvHeight);
    expect(split.y16[0]).toBe(940 << 6);
    expect(floatToHalfBits(1.0)).toBe(0x3c00);
    expect(floatToHalfBits(0.5)).toBe(0x3800);
  });
});

describe('cursor-anchored pan & zoom for Vectorscope and CIE', () => {
  it('keeps the Cb/Cr chroma point under the cursor stationary when zooming Vectorscope', () => {
    const w = 600;
    const h = 420;
    const cursorX = 370;
    const cursorY = 165;

    const before = vectorscopeFrame(w, h, 1, 0, 0);
    const cbBefore = (cursorX - before.cx) / before.scale;
    const crBefore = (before.cy - cursorY) / before.scale;

    const z = zoomVectorscopeAt(w, h, 1, 0, 0, 4, cursorX, cursorY);
    const after = vectorscopeFrame(w, h, z.zoom, z.panCb, z.panCr);
    const cbAfter = (cursorX - after.cx) / after.scale;
    const crAfter = (after.cy - cursorY) / after.scale;

    expect(after.discCx).toBe(before.discCx);
    expect(after.radius).toBe(before.radius);
    expect(cbAfter).toBeCloseTo(cbBefore, 4);
    expect(crAfter).toBeCloseTo(crBefore, 4);
  });

  it('keeps the chromaticity point under the cursor stationary when zooming CIE', () => {
    const w = 640;
    const h = 480;
    const cursorX = 360;
    const cursorY = 210;

    const z = zoomCieAt(w, h, 'xy', 1, null, null, 4, cursorX, cursorY);
    const after = cieFrame(w, h, 'xy', z.zoom, z.panX, z.panY);
    const before = cieFrame(w, h, 'xy', 1, null, null);
    const cxBefore = before.x0 + (cursorX - before.left) / before.scale;
    const cyBefore = before.y0 + (before.top + before.height - cursorY) / before.scale;
    const [sxAfter, syAfter] = frameToScreen(after, cxBefore, cyBefore);

    expect(sxAfter).toBeCloseTo(cursorX, 2);
    expect(syAfter).toBeCloseTo(cursorY, 2);
  });
});

describe('per-cell independent configuration & migration', () => {
  it('resolves independent per-cell Wave/Parade/Hist configs and supports duplicate scope types', () => {
    const state: HudState = {
      ...DEFAULT_STATE,
      layout: 'grid',
      nitLow: 150,
      nitHigh: 1200,
      precision: 'high',
      panels: {
        grid: ['waveform-luma', 'waveform-rgb', 'histogram', 'vectorscope'],
      },
    };

    const cells = resolveCells(state, 'grid');
    expect(cells).toHaveLength(4);
    expect(cells[0]!.waveChannels).toBe('Y');
    expect(cells[1]!.waveChannels).toBe('RGB');
    expect(cells[2]!.mode).toBe('histogram');

    // Assigning with allowDuplicate lets two cells run independent Waveform configs simultaneously
    const dup = assignCellSlot(cells, 3, 'waveform-luma', state, true);
    dup[0] = { ...defaultCellForMode('waveform-luma', state), traceMode: 'monochrome' };
    dup[3] = { ...defaultCellForMode('waveform-rgb', state), waveChannels: 'YRGB', traceMode: 'colorize' };
    expect(dup[0]!.traceMode).toBe('monochrome');
    expect(dup[3]!.waveChannels).toBe('YRGB');
    expect(dup[3]!.traceMode).toBe('colorize');

    expect(DEFAULT_STATE.nitLow).toBe(100);
    expect(DEFAULT_STATE.nitHigh).toBe(1000);
  });
});
