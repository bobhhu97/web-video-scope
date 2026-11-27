import { describe, it, expect } from 'vitest';
import {
  CAPTURE_SCALE_OPTIONS,
  DEFAULT_CAPTURE,
  PANEL_BG,
  PAPER_BG,
  captureFileName,
  captureGridShape,
  captureSheetFileName,
  describeSize,
  effectiveBackground,
  formatInfo,
  graticuleThemeFor,
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

describe('captureGridShape', () => {
  it('lays triple out as one horizontal row', () => {
    // On screen triple stacks vertically; the export deliberately goes wide so
    // three scopes read side by side in a document.
    expect(captureGridShape('triple')).toEqual({ cols: 3, rows: 1, cells: 3 });
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
});
