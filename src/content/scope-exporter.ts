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
  effectiveBackground,
  formatInfo,
  graticuleThemeFor,
  planCapture,
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
