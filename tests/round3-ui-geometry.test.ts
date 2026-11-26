import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  cieViewportFrame,
  frameToScreen,
  screenToFrame,
  zoomCieViewportAt,
} from '../src/core/color/cie-frame';
import { vectorscopeFrame, vectorscopeToScreen } from '../src/core/color/vectorscope-frame';
import { DEFAULT_SCOPE_OPTIONS } from '../src/gpu/scope-renderer';
import { drawVectorscopeGraticule } from '../src/ui/graticule';
import { Hud } from '../src/ui/hud';
import { describeSample, drawScopeProbeRings } from '../src/ui/probe';
import { DEFAULT_STATE } from '../src/ui/settings';

describe('Round 3 UI & Scope Geometry Fixes', () => {
  it('CIE viewport fills the full padded plot rectangle at 1:1 isotropic scale and pins cursor under wheel zoom', () => {
    // Wide landscape cell (like 2-up / 3-up / 4-up scope panels)
    const w = 480;
    const h = 260;
    const f1 = cieViewportFrame(w, h, 'xy', 1, null, null, 1);

    // Plot frame must span the entire padded width, NOT a narrow centered 180px column!
    expect(f1.left).toBeCloseTo(30, 5);
    expect(f1.width).toBeCloseTo(w - 30 - 14, 5);

    // 1:1 equal pixels per chromaticity unit on both X and Y axes
    const [x1, y1] = frameToScreen(f1, 0.2, 0.2);
    const [x2] = frameToScreen(f1, 0.6, 0.2);
    const [, y2] = frameToScreen(f1, 0.2, 0.6);
    expect((x2 - x1) / 0.4).toBeCloseTo((y1 - y2) / 0.4, 8);

    // Exact DPR homogeneity between CSS graticule (dpr=1) and Retina WebGPU scatter (dpr=2)
    for (const z of [1, 1.6, 3.4]) {
      const css = cieViewportFrame(w, h, 'xy', z, 0.12, 0.08, 1);
      const dev = cieViewportFrame(w * 2, h * 2, 'xy', z, 0.12, 0.08, 2);
      expect(dev.left).toBeCloseTo(css.left * 2, 8);
      expect(dev.top).toBeCloseTo(css.top * 2, 8);
      expect(dev.width).toBeCloseTo(css.width * 2, 8);
      expect(dev.height).toBeCloseTo(css.height * 2, 8);
      expect(dev.scale).toBeCloseTo(css.scale * 2, 8);
      expect(dev.x0).toBeCloseTo(css.x0, 10);
      expect(dev.y0).toBeCloseTo(css.y0, 10);
    }

    // Multi-step cursor wheel zoom (1.0 -> 1.3 -> 1.6 -> 2.8) around off-center cursor
    // must keep the exact chromaticity point under the cursor stationary with ZERO drift!
    const cursorX = 110; // left side of wide panel (outside old narrow letterbox!)
    const cursorY = 175;
    const [targetCx, targetCy] = screenToFrame(f1, cursorX, cursorY);

    let zoom = 1;
    let panX: number | null = null;
    let panY: number | null = null;
    for (const nextZ of [1.25, 1.6, 2.4, 4.0]) {
      const step = zoomCieViewportAt(w, h, 'xy', zoom, panX, panY, nextZ, cursorX, cursorY, 1);
      zoom = step.zoom;
      panX = step.panX;
      panY = step.panY;
      const fAfter = cieViewportFrame(w, h, 'xy', zoom, panX, panY, 1);
      const [afterPx, afterPy] = frameToScreen(fAfter, targetCx, targetCy);
      expect(afterPx).toBeCloseTo(cursorX, 6);
      expect(afterPy).toBeCloseTo(cursorY, 6);
    }
  });

  it('Vectorscope wheel zoom scales the outermost circle outward instead of drawing a stationary clipping bezel', () => {
    const arcs: Array<{ x: number; y: number; r: number }> = [];
    const clips: string[] = [];
    const ctx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn((x: number, y: number, w: number, h: number) => clips.push(`rect:${x},${y},${w},${h}`)),
      clip: vi.fn(),
      arc: vi.fn((x: number, y: number, r: number) => arcs.push({ x, y, r })),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      fillRect: vi.fn(),
      measureText: () => ({ width: 90 }),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'middle',
    } as unknown as CanvasRenderingContext2D;

    const w = 400;
    const h = 260;
    const vf = vectorscopeFrame(w, h, 1.4, 0.05, -0.04);
    drawVectorscopeGraticule(ctx, {
      ...DEFAULT_SCOPE_OPTIONS,
      mode: 'vectorscope',
      width: w,
      height: h,
      zoom: 1.4,
      panX: 0.05,
      panY: -0.04,
    });

    // Must clip to the rectangular canvas, NEVER to the unzoomed disc!
    expect(clips).toContain(`rect:0,0,${w},${h}`);
    // Every drawn circle must be centered at the panned/zoomed (cx, cy), and the
    // outermost circle must have radius = vf.radius * 1.4 (NOT stationary vf.radius)!
    expect(arcs.length).toBe(4);
    for (const a of arcs) {
      expect(a.x).toBeCloseTo(vf.cx, 6);
      expect(a.y).toBeCloseTo(vf.cy, 6);
    }
    const maxR = Math.max(...arcs.map((a) => a.r));
    expect(maxR).toBeCloseTo(vf.radius * 1.4, 6);
    expect(arcs.some((a) => Math.abs(a.r - vf.radius) < 0.5)).toBe(false);
  });

  it('Vectorscope 2× magnifies signal & Eyedropper ring by 2× around center while keeping view zoom at 1×', () => {
    const arcs: Array<{ x: number; y: number; r: number }> = [];
    const ctx = {
      clearRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn((x: number, y: number, r: number) => arcs.push({ x, y, r })),
      stroke: vi.fn(),
      fill: vi.fn(),
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;

    const sample = describeSample(
      [165, 125, 105],
      100,
      100,
      'bt709',
      { limited: false, depth: 8 },
      {
        primaries: 'rec709',
        effectiveTransfer: 'sdr',
        sdrWhiteNits: 203,
        videoWidth: 640,
        videoHeight: 360,
      },
    );

    const w = 360;
    const h = 260;
    const vf = vectorscopeFrame(w, h, 1, 0, 0);

    drawScopeProbeRings(
      ctx,
      { ...DEFAULT_SCOPE_OPTIONS, mode: 'vectorscope', width: w, height: h, zoom: 1, vecScale2x: false },
      sample,
    );
    const [x1, y1] = vectorscopeToScreen(vf, sample.cb, sample.cr);
    expect(arcs[0]!.x).toBeCloseTo(x1, 6);
    expect(arcs[0]!.y).toBeCloseTo(y1, 6);

    arcs.length = 0;
    drawScopeProbeRings(
      ctx,
      { ...DEFAULT_SCOPE_OPTIONS, mode: 'vectorscope', width: w, height: h, zoom: 1, vecScale2x: true },
      sample,
    );
    const [x2, y2] = vectorscopeToScreen(vf, sample.cb * 2, sample.cr * 2);
    expect(arcs[0]!.x).toBeCloseTo(x2, 6);
    expect(arcs[0]!.y).toBeCloseTo(y2, 6);
    // Radial distance from center doubles!
    expect(Math.hypot(x2 - vf.cx, y2 - vf.cy)).toBeCloseTo(
      Math.hypot(x1 - vf.cx, y1 - vf.cy) * 2,
      6,
    );
  });

  it('HUD renders box-arrangement SVG icons for 1/2/3/4 layouts, green-highlights all active scopes in multi-up, and toggles vecScale2x without view zoom', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const doc = dom.window.document;

    let latestPatch: Record<string, unknown> | null = null;
    const hud = new Hud(
      {
        ...DEFAULT_STATE,
        visible: true,
        layout: 'triple',
      },
      {
        onStateChange: () => {},
        onCellChange: (_l, _s, patch) => {
          latestPatch = patch as Record<string, unknown>;
        },
        onCellsReplace: () => {},
        onLayoutChange: (l) => hud.relayout(l),
        onPanelsChange: () => {},
        onClose: () => {},
        onOpenPip: () => {},
        onToggleLock: () => {},
      },
    );
    hud.mount(doc);
    const root = doc.getElementById('video-scopes-host')!.shadowRoot!;

    // 1. Layout buttons use SVG box arrangement icons with 1, 2, 3, 4 <rect> elements
    const layoutBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('#layouts button'));
    expect(layoutBtns.map((b) => b.dataset.layout)).toEqual(['single', 'pair', 'triple', 'grid']);
    expect(layoutBtns.map((b) => b.querySelectorAll('svg rect').length)).toEqual([1, 2, 3, 4]);
    expect(layoutBtns.every((b) => b.textContent?.trim() === '')).toBe(true);

    // 2. In 'triple' layout (default: Waveform, Parade, Vectorscope), Wave + Parade + Vector
    //    must ALL be green-highlighted (.scope-active & aria-pressed="true"), while Hist & CIE are off!
    const activeModes = Array.from(root.querySelectorAll<HTMLButtonElement>('#modes button'))
      .filter((b) => b.classList.contains('scope-active') && b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.dataset.mode);
    expect(activeModes).toEqual(['waveform-luma', 'waveform-parade', 'vectorscope']);

    // Switch slot 2 in triple layout from Vectorscope to CIE -> green highlight updates immediately!
    const slot2Select = root.querySelectorAll<HTMLSelectElement>('select.tag')[2]!;
    slot2Select.value = 'cie';
    slot2Select.dispatchEvent(new dom.window.Event('change'));
    const updatedActiveModes = Array.from(root.querySelectorAll<HTMLButtonElement>('#modes button'))
      .filter((b) => b.classList.contains('scope-active'))
      .map((b) => b.dataset.mode);
    expect(updatedActiveModes).toEqual(['waveform-luma', 'waveform-parade', 'cie']);

    // 3. Switch back to Vectorscope and click 2× pill -> toggles vecScale2x (NOT view zoom!)
    slot2Select.value = 'vectorscope';
    slot2Select.dispatchEvent(new dom.window.Event('change'));
    const vecCell = root.querySelector<HTMLElement>('.cell[data-mode="vectorscope"]')!;
    const btn2x = vecCell.querySelector<HTMLButtonElement>('button[data-act="zoom2x"]')!;
    btn2x.click();
    expect(latestPatch).toEqual({ vecScale2x: true });
    expect(vecCell.querySelector<HTMLButtonElement>('button[data-act="zoom2x"]')!.classList.contains('on')).toBe(true);
    // View zoom reset badge remains hidden because cell.zoom stayed 1!
    expect(vecCell.querySelector<HTMLButtonElement>('.zoom-reset')!.hidden).toBe(true);

    // 4. Cell quick-pills contain ONLY signal/target/gamut controls — NO Clr / B&W / Nit / Grn coloring pills!
    const allPillLabels = Array.from(root.querySelectorAll<HTMLButtonElement>('.cell-pills button')).map(
      (b) => b.textContent?.trim(),
    );
    for (const forbidden of ['Clr', 'B&W', 'Nit', 'Grn']) {
      expect(allPillLabels).not.toContain(forbidden);
    }

    // Coloring is changed cleanly via per-cell ⚙ popover AND Global ⚙ Settings (#set-trace-mode)
    const waveCell = root.querySelector<HTMLElement>('.cell[data-slot="0"]')!;
    waveCell.querySelector<HTMLButtonElement>('.cell-gear')!.click();
    const cellTraceSel = waveCell.querySelector<HTMLSelectElement>('select[data-pop="traceMode"]')!;
    cellTraceSel.value = 'colorize';
    cellTraceSel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(latestPatch).toEqual({ traceMode: 'colorize' });

    const globalTraceSel = root.querySelector<HTMLSelectElement>('#set-trace-mode')!;
    expect(globalTraceSel).not.toBeNull();
    globalTraceSel.value = 'monochrome';
    globalTraceSel.dispatchEvent(new dom.window.Event('change'));
    expect(cellTraceSel.value).toBe('monochrome');

    hud.unmount();
  });
});
