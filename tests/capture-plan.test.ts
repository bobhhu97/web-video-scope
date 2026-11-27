import { describe, it, expect } from 'vitest';
import {
  CAPTURE_SCALE_OPTIONS,
  DEFAULT_CAPTURE,
  GRID_BG,
  PANEL_BG,
  PAPER_BG,
  captureFileName,
  captureGridShape,
  captureSheetFileName,
  describeSize,
  effectiveBackground,
  exportDensityGain,
  formatInfo,
  graticuleThemeFor,
  normalizeCapture,
  planCapture,
  planCaptureLayout,
  type CaptureLayoutRequest,
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

  it('treats a missing or broken source width as no match target', () => {
    // 0 reaches here before the video reports metadata; NaN from a detached
    // element. Both must mean "do not rescale", not "export a 48x27 stamp".
    for (const sourceWidth of [0, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planCapture(req({ scale: 'match', sourceWidth }));
      expect(plan.requestedScale).toBe(1);
      expect(plan.width).toBe(480);
    }
  });

  it('never returns a zero-sized image', () => {
    const plan = planCapture(
      req({ cssWidth: 0, cssHeight: 0, scale: 4, maxEdge: 1, maxDensityBytes: 256 }),
    );
    expect(plan.cssWidth).toBe(1);
    expect(plan.cssHeight).toBe(1);
    expect(plan.width).toBeGreaterThanOrEqual(1);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });

  it('ignores the gutter for vectorscope and cie, which draw edge to edge', () => {
    // Full-bleed modes must not shrink their plot for a padding they never
    // draw, so changing WAVE_PAD cannot move their plan at all.
    const tight = { maxDensityBytes: 1024 * 1024 };
    const noPad = { top: 0, right: 0, bottom: 0, left: 0 };
    const fatPad = { top: 40, right: 40, bottom: 40, left: 40 };
    for (const mode of ['vectorscope', 'cie'] as const) {
      const a = planCapture(req({ mode, cssWidth: 400, cssHeight: 300, planes: 1, ...tight, wavePad: noPad }));
      const b = planCapture(req({ mode, cssWidth: 400, cssHeight: 300, planes: 1, ...tight, wavePad: fatPad }));
      expect(b).toEqual(a);
    }
    // The padded modes do react, which is what proves the check above is real.
    const plain = planCapture(req({ cssWidth: 400, cssHeight: 300, planes: 1, ...tight, wavePad: noPad }));
    const padded = planCapture(req({ cssWidth: 400, cssHeight: 300, planes: 1, ...tight, wavePad: fatPad }));
    expect(padded.scale).not.toBe(plain.scale);
  });

  it('offers the documented multiplier set', () => {
    expect(CAPTURE_SCALE_OPTIONS).toEqual([1, 2, 3, 4, 'match']);
  });
});

describe('normalizeCapture', () => {
  it('keeps a valid persisted setting untouched', () => {
    expect(normalizeCapture({ format: 'webp', scale: 4, background: 'white' })).toEqual({
      format: 'webp',
      scale: 4,
      background: 'white',
    });
  });

  it('repairs every field a stale storage blob can corrupt', () => {
    expect(normalizeCapture({ format: 'gif', scale: 9, background: 'blue' })).toEqual(DEFAULT_CAPTURE);
    expect(normalizeCapture({ scale: 'native' })).toEqual(DEFAULT_CAPTURE);
  });

  it('survives a missing or non-object value', () => {
    expect(normalizeCapture(undefined)).toEqual(DEFAULT_CAPTURE);
    expect(normalizeCapture(null)).toEqual(DEFAULT_CAPTURE);
    expect(normalizeCapture('png')).toEqual(DEFAULT_CAPTURE);
    expect(normalizeCapture(7)).toEqual(DEFAULT_CAPTURE);
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
    expect(PANEL_BG).toBe('#0c1016');
    expect(GRID_BG).toBe('#06090c');
    expect(PAPER_BG).toBe('#ffffff');
  });
});

describe('exportDensityGain', () => {
  it('leaves exports at or below the panel density untouched', () => {
    expect(exportDensityGain(1, 1)).toBe(1);
    expect(exportDensityGain(2, 2)).toBe(1);
    expect(exportDensityGain(1, 2)).toBe(1);
    expect(exportDensityGain(4, 4)).toBe(1);
  });

  it('lifts the gain when the export outruns the panel dpr', () => {
    const twice = exportDensityGain(4, 2);
    const thrice = exportDensityGain(6, 2);
    expect(twice).toBeGreaterThan(1);
    expect(thrice).toBeGreaterThan(twice);
    expect(exportDensityGain(4, 1)).toBeGreaterThan(exportDensityGain(4, 2));
  });

  it('stays bounded so the trace never blows out', () => {
    expect(exportDensityGain(64, 1)).toBeLessThanOrEqual(2.2);
  });

  it('assumes no compensation when the panel dpr is unknown', () => {
    expect(exportDensityGain(4, undefined)).toBe(1);
    expect(exportDensityGain(4, 0)).toBe(1);
    expect(exportDensityGain(4, -2)).toBe(1);
    expect(exportDensityGain(4, Number.NaN)).toBe(1);
    expect(exportDensityGain(4, Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('is a no-op inside the tolerance band and for non-finite scales', () => {
    expect(exportDensityGain(2.02, 2)).toBe(1);
    expect(exportDensityGain(Number.NaN, 2)).toBe(1);
    expect(exportDensityGain(Number.POSITIVE_INFINITY, 2)).toBe(1);
  });
});

describe('captureGridShape', () => {
  it('keeps triple stacked, matching the on-screen arrangement', () => {
    // Triple is a 1x3 column on screen, and the export follows it so the sheet
    // reads like the panel the user was looking at.
    expect(captureGridShape('triple')).toEqual({ cols: 1, rows: 3, cells: 3 });
  });

  it('matches the on-screen arrangement for the other layouts', () => {
    expect(captureGridShape('single')).toEqual({ cols: 1, rows: 1, cells: 1 });
    expect(captureGridShape('pair')).toEqual({ cols: 2, rows: 1, cells: 2 });
    expect(captureGridShape('grid')).toEqual({ cols: 2, rows: 2, cells: 4 });
  });
});

function layoutReq(over: Partial<CaptureLayoutRequest> = {}): CaptureLayoutRequest {
  return {
    limits: LIMITS,
    slots: [0, 1],
    grid: 'pair',
    cells: [
      { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
      { cssWidth: 480, cssHeight: 270, mode: 'histogram', planes: 4 },
    ],
    scale: 2,
    wavePad: WAVE_PAD,
    gap: 3,
    ...over,
  };
}

describe('planCaptureLayout', () => {
  it('tiles a pair side by side with a gutter between cells', () => {
    const plan = planCaptureLayout(layoutReq());
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(1);
    expect(plan.cells).toHaveLength(2);
    const [a, b] = plan.cells;
    expect(a!.slot).toBe(0);
    expect(b!.slot).toBe(1);
    expect(b!.x).toBeGreaterThan(a!.x);
    expect(a!.y).toBe(b!.y);
    // The gutter is a scaled gap, so it must be at least one scaled gap wide.
    expect(b!.x - (a!.x + a!.width)).toBeGreaterThanOrEqual(3 * plan.scale);
  });

  it('tiles four cells into a 2x2 sheet', () => {
    const plan = planCaptureLayout(
      layoutReq({
        slots: [0, 1, 2, 3],
        grid: 'grid',
        cells: [
          { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
          { cssWidth: 480, cssHeight: 270, mode: 'waveform-parade', planes: 4 },
          { cssWidth: 480, cssHeight: 270, mode: 'vectorscope', planes: 1 },
          { cssWidth: 480, cssHeight: 270, mode: 'cie', planes: 1 },
        ],
      }),
    );
    expect(plan.cols).toBe(2);
    expect(plan.rows).toBe(2);
    expect(plan.cells).toHaveLength(4);
    expect(plan.cells[0]!.y).toBe(plan.cells[1]!.y);
    expect(plan.cells[2]!.y).toBeGreaterThan(plan.cells[0]!.y);
    expect(plan.cells[2]!.x).toBe(plan.cells[0]!.x);
  });

  it('keeps every cell inside the final canvas', () => {
    const plan = planCaptureLayout(layoutReq({ grid: 'grid', slots: [0, 1, 2, 3], cells: [
      { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
      { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
      { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
      { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
    ] }));
    for (const cell of plan.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.width).toBeLessThanOrEqual(plan.width);
      expect(cell.y + cell.height).toBeLessThanOrEqual(plan.height);
    }
  });

  it('shrinks the shared scale when the sheet would exceed the density limit', () => {
    const plan = planCaptureLayout(
      layoutReq({
        grid: 'grid',
        slots: [0, 1, 2, 3],
        scale: 4,
        cells: [
          { cssWidth: 960, cssHeight: 540, mode: 'waveform-parade', planes: 4 },
          { cssWidth: 960, cssHeight: 540, mode: 'waveform-parade', planes: 4 },
          { cssWidth: 960, cssHeight: 540, mode: 'waveform-parade', planes: 4 },
          { cssWidth: 960, cssHeight: 540, mode: 'waveform-parade', planes: 4 },
        ],
        limits: { maxEdge: 8192, maxDensityBytes: 32 * 1024 * 1024 },
      }),
    );
    expect(plan.scale).toBeLessThan(4);
    expect(plan.clamped).toBe(true);
    expect(plan.requestedScale).toBe(4);
  });

  it('uses one shared multiplier across cells of different modes', () => {
    const plan = planCaptureLayout(layoutReq({ scale: 2 }));
    // The histogram cell caps its own density far lower; the sheet must not
    // silently give the pair mismatched scales.
    expect(plan.scale).toBeGreaterThan(0);
    expect(plan.cells.every((c) => c.width > 0)).toBe(true);
  });

  it('names sheets after the grid shape', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(captureSheetFileName('grid', at, 'png')).toBe('scopes-grid-20260102-030405.png');
    expect(captureSheetFileName('triple', at, 'jpeg')).toBe('scopes-triple-20260102-030405.jpg');
  });

  it('stacks a triple layout into one column, top to bottom', () => {
    // The user asked for the sheet to mirror the on-screen 1x3 stack, so the
    // three cells must share an x and march down the canvas without overlap.
    const plan = planCaptureLayout(
      layoutReq({
        grid: 'triple',
        slots: [0, 1, 2],
        cells: [
          { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
          { cssWidth: 480, cssHeight: 270, mode: 'histogram', planes: 4 },
          { cssWidth: 480, cssHeight: 270, mode: 'vectorscope', planes: 1 },
        ],
      }),
    );
    expect(plan.cols).toBe(1);
    expect(plan.rows).toBe(3);
    expect(plan.cells).toHaveLength(3);
    const [a, b, c] = plan.cells;
    expect(b!.x).toBe(a!.x);
    expect(c!.x).toBe(a!.x);
    expect(b!.y).toBeGreaterThan(a!.y);
    expect(c!.y).toBeGreaterThan(b!.y);
    expect(c!.y).toBeGreaterThanOrEqual(b!.y + b!.height);
    expect(plan.height).toBeGreaterThan(plan.width);
    for (const cell of plan.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.width).toBeLessThanOrEqual(plan.width);
      expect(cell.y + cell.height).toBeLessThanOrEqual(plan.height);
    }
  });

  it('does not report a GPU clamp when only the smallest cell limits match', () => {
    // `'match'` resolves against the widest tile, which is also the cell that
    // limits the shared scale. A narrower first cell used to inflate
    // `requestedScale` and paint a bogus "GPU limit" warning.
    const plan = planCaptureLayout(
      layoutReq({
        scale: 'match',
        sourceWidth: 1920,
        slots: [0, 1],
        cells: [
          { cssWidth: 480, cssHeight: 270, mode: 'waveform-luma', planes: 1 },
          { cssWidth: 960, cssHeight: 540, mode: 'waveform-luma', planes: 1 },
        ],
      }),
    );
    expect(plan.requestedScale).toBeCloseTo(2, 5);
    expect(plan.clamped).toBe(false);
  });

  it('falls back to 1x for match when the source width is not known yet', () => {
    const plan = planCaptureLayout(layoutReq({ scale: 'match', sourceWidth: 0 }));
    expect(plan.requestedScale).toBe(1);
    expect(plan.clamped).toBe(false);
    expect(plan.width).toBeGreaterThan(100);
  });

  it('tolerates a missing gap instead of emitting NaN geometry', () => {
    const plan = planCaptureLayout(layoutReq({ gap: undefined as unknown as number }));
    expect(Number.isFinite(plan.width)).toBe(true);
    expect(Number.isFinite(plan.height)).toBe(true);
    for (const cell of plan.cells) {
      expect(Number.isFinite(cell.x)).toBe(true);
      expect(Number.isFinite(cell.y)).toBe(true);
    }
  });

  it('returns a finite empty plan without a wave pad', () => {
    const plan = planCaptureLayout(
      layoutReq({ slots: [], cells: [], wavePad: undefined as never, gap: undefined as unknown as number }),
    );
    expect(plan.cells).toHaveLength(0);
    expect(Number.isFinite(plan.width)).toBe(true);
    expect(plan.width).toBeGreaterThanOrEqual(1);
  });
});
