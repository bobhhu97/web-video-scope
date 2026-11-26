import { describe, expect, it, vi } from 'vitest';
import {
  nitsToAxisForTransfer,
  resolveHdrZoneThresholds,
} from '../src/core/scale/units';
import { DEFAULT_SCOPE_OPTIONS } from '../src/gpu/scope-renderer';
import { legendItems } from '../src/ui/false-color-overlay';
import { drawHistogramGraticule, drawWaveformGraticule } from '../src/ui/graticule';

function mockCanvas2d(): {
  ctx: CanvasRenderingContext2D;
  fillStyles: string[];
  texts: string[];
} {
  const fillStyles: string[] = [];
  const texts: string[] = [];
  let curFill = '#000';
  const ctx = {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    setLineDash: vi.fn(),
    fillRect: vi.fn(() => {
      fillStyles.push(curFill);
    }),
    fillText: vi.fn((text: string) => {
      texts.push(String(text));
    }),
    measureText: vi.fn((text: string) => ({ width: String(text).length * 5.5 })),
    set fillStyle(v: string) {
      curFill = String(v);
    },
    get fillStyle() {
      return curFill;
    },
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fillStyles, texts };
}

describe('HDR 3-to-4 zone Nit coloring & graticule bands', () => {
  it('resolves 4 zones when SDR reference white (203 nits) sits between nitLow (100) and nitHigh (1000)', () => {
    const z = resolveHdrZoneThresholds(100, 1000, 203);
    expect(z).toEqual({
      nitLow: 100,
      nitRef: 203,
      nitHigh: 1000,
      zoneCount: 4,
    });
  });

  it('merges cleanly into 3 zones when nitLow equals SDR reference white (203/1k and 203/4k presets)', () => {
    expect(resolveHdrZoneThresholds(203, 1000, 203)).toEqual({
      nitLow: 203,
      nitRef: null,
      nitHigh: 1000,
      zoneCount: 3,
    });
    expect(resolveHdrZoneThresholds(203, 4000, 203)).toEqual({
      nitLow: 203,
      nitRef: null,
      nitHigh: 4000,
      zoneCount: 3,
    });
  });

  it('honors custom SDR reference white (300n -> 4 zones, 100n with nitLow=100 -> 3 zones)', () => {
    expect(resolveHdrZoneThresholds(100, 1000, 300)).toEqual({
      nitLow: 100,
      nitRef: 300,
      nitHigh: 1000,
      zoneCount: 4,
    });
    expect(resolveHdrZoneThresholds(100, 1000, 100)).toEqual({
      nitLow: 100,
      nitRef: null,
      nitHigh: 1000,
      zoneCount: 3,
    });
  });

  it('builds 4-zone (Blue/Green/Yellow/Red) and 3-zone (Green/Yellow/Red) False Color legends', () => {
    const baseCfg = {
      enabled: true,
      preset: 'hdr-nits' as const,
      opacity: 0.88,
      showLegend: true,
      lang: 'zh' as const,
      sdrWhiteNits: 203,
      nitLow: 100,
      nitHigh: 1000,
      matrix: 'bt2020' as const,
      range: { limited: false, depth: 10 as const },
      signalKind: 'display' as const,
      sourceTransfer: 'pq' as const,
      effectiveTransfer: 'pq' as const,
    };

    const fourZone = legendItems(baseCfg);
    expect(fourZone.badges).toEqual([
      ['#38bdf8', '■ <100n'],
      ['#34d399', '■ 100–203n'],
      ['#facc15', '■ 203–1000n'],
      ['#ef4444', '■ >1000n 峰值'],
    ]);

    const threeZone = legendItems({ ...baseCfg, nitLow: 203, nitHigh: 1000 });
    expect(threeZone.badges).toEqual([
      ['#34d399', '■ ≤203n'],
      ['#facc15', '■ 203–1000n'],
      ['#ef4444', '■ >1000n 峰值'],
    ]);
  });

  it('keeps >203 nits distinct from 203 nits on SDR limited range instead of collapsing 1000 nits onto 100 IRE', () => {
    const spec = { limited: true, depth: 8 as const };
    const a203 = nitsToAxisForTransfer(203, 'sdr', spec, 203);
    const a1000 = nitsToAxisForTransfer(1000, 'sdr', spec, 203);
    expect(a203).toBeCloseTo(235 / 255, 4);
    expect(a1000).toBe(1);
    expect(a1000).toBeGreaterThan(a203 + 0.05);
  });

  it('shades Yellow 203–1000n headroom band and Red >1000n peak band on Waveform & Histogram graticules', () => {
    const wave = mockCanvas2d();
    drawWaveformGraticule(wave.ctx, {
      ...DEFAULT_SCOPE_OPTIONS,
      traceMode: 'hdr-zones',
      effectiveTransfer: 'pq',
      units: 'nits',
      sdrWhiteNits: 203,
      nitLow: 100,
      nitHigh: 1000,
    });
    expect(wave.fillStyles).toContain('rgba(250, 204, 21, 0.06)'); // Yellow 203–1000n headroom band
    expect(wave.fillStyles).toContain('rgba(239, 68, 68, 0.085)'); // Red >1000n peak band
    expect(wave.texts).toContain('100n');
    expect(wave.texts).toContain('203n');
    expect(wave.texts).toContain('>1k');

    const hist = mockCanvas2d();
    drawHistogramGraticule(hist.ctx, {
      ...DEFAULT_SCOPE_OPTIONS,
      mode: 'histogram',
      traceMode: 'hdr-zones',
      effectiveTransfer: 'pq',
      units: 'nits',
      sdrWhiteNits: 203,
      nitLow: 203,
      nitHigh: 1000,
    });
    expect(hist.fillStyles).toContain('rgba(250, 204, 21, 0.06)');
    expect(hist.fillStyles).toContain('rgba(239, 68, 68, 0.085)');
    expect(hist.texts).toContain('203n');
    expect(hist.texts).toContain('>1k');
  });
});
