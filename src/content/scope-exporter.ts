/**
 * Offscreen image export for a single scope panel.
 *
 * The live panel and the export share the same `ScopeRenderer`, but not the
 * same canvas: an export re-renders the *current* analysis texture into an
 * `OffscreenCanvas` at the requested multiplier, then composites the graticule
 * with a 2D context so the ticks stay crisp at any size.
 *
 * Geometry rule: the renderer always receives the panel's **CSS** size as its
 * logical width/height and the multiplier as `dpr`. Every inset (WAVE_PAD,
 * vectorscope ring, CIE padding) is scaled by `dpr`, so the GPU plot box and
 * the 2D graticule land on exactly the same pixels at 1×, 4× or anything else.
 */

import { drawGraticule, WAVE_PAD } from '../ui/graticule';
import {
  ScopeRenderer,
  planesForOptions,
  type ScopeMode,
  type ScopeOptions,
} from '../gpu/scope-renderer';
import type { AnalysisTexture } from '../gpu/downscale';
import type { CanvasGpu } from '../gpu/device';
import type { PrimariesId } from '../core/color/primaries';
import {
  PANEL_BG,
  PAPER_BG,
  captureFileName,
  captureSheetFileName,
  effectiveBackground,
  formatInfo,
  graticuleThemeFor,
  planCapture,
  planCaptureLayout,
  type CaptureGrid,
  type CaptureSettings,
} from '../core/scopes/capture-plan';

export interface CaptureRequest {
  device: GPUDevice;
  /** Analysis texture the live panels are currently showing. */
  analysis: AnalysisTexture;
  /** Live renderer options for this cell (mode/channel/zoom/pan/...). */
  options: ScopeOptions;
  mode: ScopeMode;
  /** Panel size in CSS pixels — the export keeps this aspect ratio. */
  cssWidth: number;
  cssHeight: number;
  gamuts: readonly PrimariesId[];
  settings: CaptureSettings;
  /** Source video width, used by the `'match'` multiplier. */
  sourceWidth?: number;
}

export interface CaptureResult {
  blob: Blob;
  fileName: string;
  width: number;
  height: number;
  /** Multiplier actually used after clamping to device limits. */
  scale: number;
  /** True when the requested multiplier was reduced to fit the GPU. */
  clamped: boolean;
  requestedScale: number;
}

/**
 * A detached HTML canvas for compositing. The graticule helpers are typed
 * against `CanvasRenderingContext2D`, so the composite layer stays a normal
 * canvas while only the WebGPU render target is an `OffscreenCanvas`.
 */
function canvas2d(width: number, height: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable for export');
  return { canvas, ctx };
}

function toBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))),
      type,
      quality,
    );
  });
}

export interface CaptureSheetRequest {
  device: GPUDevice;
  /** Analysis texture the live panels are currently showing. */
  analysis: AnalysisTexture;
  gamuts: readonly PrimariesId[];
  settings: CaptureSettings;
  /** Grid shape to lay the cells out in. */
  grid: CaptureGrid;
  /** One entry per exported cell, in reading order. */
  panels: {
    slot: number;
    mode: ScopeMode;
    /** Live renderer options for this cell. */
    options: ScopeOptions;
    /** Panel size in CSS pixels. */
    cssWidth: number;
    cssHeight: number;
  }[];
  sourceWidth?: number;
  /** Gutter between cells, in CSS pixels of one cell. */
  gap?: number;
}

/**
 * Render each cell into its own `OffscreenCanvas`.
 *
 * One canvas per cell, not one big canvas: a `GPUCanvasContext` hands out a
 * single `getCurrentTexture()`, so several renderers writing into one context
 * would overwrite each other. Separate targets also keep each cell's density
 * buffer independent, which is what lets a 4-up sheet hold four scopes at once.
 */
async function renderCellBitmap(
  device: GPUDevice,
  analysis: AnalysisTexture,
  options: ScopeOptions,
  width: number,
  height: number,
  dpr: number,
): Promise<{ bitmap: ImageBitmap; done: () => void }> {
  const offscreen = new OffscreenCanvas(width, height);
  const context = offscreen.getContext('webgpu');
  if (!context) throw new Error('WebGPU offscreen context unavailable');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  const gpu: CanvasGpu = { device, context, format };
  const renderer = new ScopeRenderer(gpu, { ...options, width, height, dpr });
  try {
    const encoder = device.createCommandEncoder();
    renderer.encode(encoder, analysis, false);
    device.queue.submit([encoder.finish()]);
    // The canvas only holds the resolved pixels once the queue drains;
    // without this the bitmap can come back blank on slow GPUs.
    await device.queue.onSubmittedWorkDone();
    const bitmap = await createImageBitmap(offscreen);
    return {
      bitmap,
      done: () => {
        bitmap.close();
        renderer.destroy();
        context.unconfigure();
      },
    };
  } catch (error) {
    renderer.destroy();
    context.unconfigure();
    throw error;
  }
}

/** Composite one cell's GPU bitmap and its graticule into a sheet context. */
function blitCell(
  ctx: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  cell: { x: number; y: number; width: number; height: number; cssWidth: number; cssHeight: number },
  options: ScopeOptions,
  scale: number,
  gamuts: readonly PrimariesId[],
): void {
  ctx.drawImage(bitmap, cell.x, cell.y);

  // The graticule painters start with `clearRect` (they own the live overlay
  // canvas outright), so they cannot draw straight onto the composite or they
  // would erase the trace underneath. Paint them on their own layer and
  // composite that with plain source-over.
  const { canvas: gratCanvas, ctx: gratCtx } = canvas2d(cell.width, cell.height);
  gratCtx.setTransform(scale, 0, 0, scale, 0, 0);
  drawGraticule(
    gratCtx,
    { ...options, width: cell.cssWidth, height: cell.cssHeight, dpr: scale },
    gamuts,
  );
  ctx.drawImage(gratCanvas, cell.x, cell.y);
}

/**
 * Render the whole visible layout to one image.
 *
 * Every cell is re-rendered from the shared analysis texture with its own live
 * options (mode, channel, zoom, pan, gain, gamma...), so the sheet reproduces
 * exactly what the panel shows rather than a scaled-up screenshot.
 */
export async function renderSheetImage(req: CaptureSheetRequest): Promise<CaptureResult> {
  const background = effectiveBackground(req.settings.format, req.settings.background);
  const theme = graticuleThemeFor(background);
  const gap = req.gap ?? 0;

  const baseOptions = req.panels.map((panel) => ({
    ...panel.options,
    mode: panel.mode,
    graticuleTheme: theme,
  }));

  const plan = planCaptureLayout({
    limits: {
      maxEdge: req.device.limits.maxTextureDimension2D,
      maxDensityBytes: req.device.limits.maxStorageBufferBindingSize,
    },
    slots: req.panels.map((p) => p.slot),
    grid: req.grid,
    cells: req.panels.map((panel, i) => ({
      cssWidth: panel.cssWidth,
      cssHeight: panel.cssHeight,
      mode: panel.mode,
      planes: planesForOptions(baseOptions[i]!),
    })),
    scale: req.settings.scale,
    sourceWidth: req.sourceWidth,
    wavePad: WAVE_PAD,
    gap,
  });

  const { canvas: out, ctx } = canvas2d(plan.width, plan.height);
  if (background === 'panel') {
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(0, 0, plan.width, plan.height);
  } else if (background === 'white') {
    ctx.fillStyle = PAPER_BG;
    ctx.fillRect(0, 0, plan.width, plan.height);
  }

  // Sequential per cell: an export is a one-shot action, so a few extra queue
  // round-trips cost nothing, while keeping each cell's setup and teardown
  // self-contained.
  for (let i = 0; i < plan.cells.length; i += 1) {
    const cell = plan.cells[i]!;
    const options = baseOptions[i]!;
    const rendered = await renderCellBitmap(
      req.device,
      req.analysis,
      options,
      cell.width,
      cell.height,
      plan.scale,
    );
    try {
      blitCell(ctx, rendered.bitmap, cell, options, plan.scale, req.gamuts);
    } finally {
      rendered.done();
    }
  }

  const info = formatInfo(req.settings.format);
  const blob = await toBlob(out, info.mime, info.quality);
  return {
    blob,
    fileName: captureSheetFileName(req.grid, new Date(), req.settings.format),
    width: plan.width,
    height: plan.height,
    scale: plan.scale,
    clamped: plan.clamped,
    requestedScale: plan.requestedScale,
  };
}

/**
 * Render one panel to an image blob.
 *
 * Throws when WebGPU cannot provide an offscreen context; callers surface the
 * message through the HUD notice rather than failing silently.
 */
export async function renderPanelImage(req: CaptureRequest): Promise<CaptureResult> {
  const background = effectiveBackground(req.settings.format, req.settings.background);
  const theme = graticuleThemeFor(background);
  const baseOptions: ScopeOptions = {
    ...req.options,
    mode: req.mode,
    graticuleTheme: theme,
  };

  const plan = planCapture({
    cssWidth: req.cssWidth,
    cssHeight: req.cssHeight,
    scale: req.settings.scale,
    sourceWidth: req.sourceWidth,
    mode: req.mode,
    planes: planesForOptions(baseOptions),
    wavePad: WAVE_PAD,
    maxEdge: req.device.limits.maxTextureDimension2D,
    maxDensityBytes: req.device.limits.maxStorageBufferBindingSize,
  });

  const offscreen = new OffscreenCanvas(plan.width, plan.height);
  const context = offscreen.getContext('webgpu');
  if (!context) throw new Error('WebGPU offscreen context unavailable');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device: req.device, format, alphaMode: 'premultiplied' });

  const gpu: CanvasGpu = { device: req.device, context, format };
  const renderer = new ScopeRenderer(gpu, {
    ...baseOptions,
    width: plan.width,
    height: plan.height,
    dpr: plan.scale,
  });

  let bitmap: ImageBitmap | null = null;
  try {
    const encoder = req.device.createCommandEncoder();
    renderer.encode(encoder, req.analysis, false);
    req.device.queue.submit([encoder.finish()]);
    // The canvas is only guaranteed to hold the resolved pixels once the queue
    // drains; without this the bitmap can come back blank on slow GPUs.
    await req.device.queue.onSubmittedWorkDone();
    bitmap = await createImageBitmap(offscreen);

    const { canvas: out, ctx } = canvas2d(plan.width, plan.height);
    if (background === 'panel') {
      ctx.fillStyle = PANEL_BG;
      ctx.fillRect(0, 0, plan.width, plan.height);
    } else if (background === 'white') {
      ctx.fillStyle = PAPER_BG;
      ctx.fillRect(0, 0, plan.width, plan.height);
    }
    ctx.drawImage(bitmap, 0, 0);

    // The graticule painters start with `clearRect` (they own the live overlay
    // canvas outright), so they cannot draw straight onto the composite or they
    // would erase the trace underneath. Paint them on their own layer and
    // composite that with plain source-over.
    const { canvas: gratCanvas, ctx: gratCtx } = canvas2d(plan.width, plan.height);
    // Logical (CSS) space: the transform reproduces the export multiplier so
    // line widths and label sizes scale with the image instead of staying thin.
    gratCtx.setTransform(plan.scale, 0, 0, plan.scale, 0, 0);
    drawGraticule(
      gratCtx,
      {
        ...baseOptions,
        width: plan.cssWidth,
        height: plan.cssHeight,
        dpr: plan.scale,
      },
      req.gamuts,
    );
    ctx.drawImage(gratCanvas, 0, 0);

    const info = formatInfo(req.settings.format);
    const blob = await toBlob(out, info.mime, info.quality);
    return {
      blob,
      fileName: captureFileName(req.mode, new Date(), req.settings.format),
      width: plan.width,
      height: plan.height,
      scale: plan.scale,
      clamped: plan.clamped,
      requestedScale: plan.requestedScale,
    };
  } finally {
    bitmap?.close();
    renderer.destroy();
    context.unconfigure();
  }
}
