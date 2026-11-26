import { LUMA, type MatrixId } from '../core/color/matrices';
import type { DisplayTransferFix } from '../core/color/transfer';
import { axisMapping, type RangeSpec } from '../core/scale/quantize';
import type { EffectiveTransfer } from '../core/scale/units';
import {
  isPopoverOpen,
  placeTopLayerOverlayHost,
  renderedVideoBox,
  type RenderedVideoBox,
} from '../content/fullscreen';
import { configureCanvas, initCanvas, type CanvasGpu } from '../gpu/device';
import type { AnalysisTexture } from '../gpu/downscale';
import falseColorWgsl from '../gpu/shaders/false-color.wgsl?raw';
import type { Locale } from './i18n';
import type { FalseColorPreset } from './settings';

const OVERLAY_ID = 'video-scopes-false-color';
const UNIFORM_BYTES = 80;

const falseColorExternalWgsl = falseColorWgsl
  .replace(
    '@group(0) @binding(0) var srcTex: texture_2d<f32>;',
    '@group(0) @binding(0) var srcTex: texture_external;',
  )
  .replace(
    'textureSampleLevel(srcTex, samp, sampleUv, 0.0)',
    'textureSampleBaseClampToEdge(srcTex, samp, sampleUv)',
  );

export interface FalseColorConfig {
  enabled: boolean;
  preset: FalseColorPreset;
  opacity: number;
  showLegend: boolean;
  lang: Locale;
  sdrWhiteNits: number;
  nitLow: number;
  nitHigh: number;
  matrix: MatrixId;
  range: RangeSpec;
  signalKind: 'display' | 'raw';
  sourceTransfer: EffectiveTransfer;
  effectiveTransfer: EffectiveTransfer;
  displayTransferFix?: DisplayTransferFix;
}

function transferCode(t: EffectiveTransfer): number {
  if (t === 'pq') return 1;
  if (t === 'hlg') return 2;
  return 0;
}

function resolveFcPreset(cfg: FalseColorConfig): Exclude<FalseColorPreset, 'auto'> {
  if (cfg.preset === 'auto') {
    return cfg.effectiveTransfer !== 'sdr' ? 'hdr-nits' : 'arri';
  }
  return cfg.preset;
}

function presetCode(p: Exclude<FalseColorPreset, 'auto'>): number {
  if (p === 'smallhd') return 1;
  if (p === 'spectrum') return 2;
  if (p === 'hdr-nits') return 3;
  return 0; // 'arri'
}

function legendItems(cfg: FalseColorConfig): { title: string; badges: Array<[string, string]> } {
  const zh = cfg.lang === 'zh';
  const nitLow = Math.round(cfg.nitLow);
  const nitHigh = Math.round(cfg.nitHigh);
  const effPreset = resolveFcPreset(cfg);

  switch (effPreset) {
    case 'arri':
      return {
        title: 'ARRI',
        badges: [
          ['#a855f7', '■ <2.5%'],
          ['#3b82f6', '■ 4%'],
          ['#34d399', `■ 38–42% ${zh ? '18%灰' : 'Grey'}`],
          ['#f472b6', `■ 52–56% ${zh ? '肤色' : 'Skin'}`],
          ['#facc15', '■ 97%'],
          ['#ef4444', `■ ≥99% ${zh ? '过曝' : 'Clip'}`],
        ],
      };
    case 'smallhd':
      return {
        title: 'SmallHD',
        badges: [
          ['#9333ea', '■ <3%'],
          ['#3b82f6', '■ 3–9%'],
          ['#22d3ee', '■ 9–16%'],
          ['#34d399', `■ 38–45% ${zh ? '中灰' : 'Grey'}`],
          ['#f472b6', `■ 52–58% ${zh ? '肤色' : 'Skin'}`],
          ['#facc15', '■ 85–94%'],
          ['#ef4444', '■ ≥94%'],
        ],
      };
    case 'spectrum':
      return {
        title: zh ? 'IRE光谱' : 'Spectrum',
        badges: [
          ['#8b5cf6', '0'],
          ['#22d3ee', '20'],
          ['#34d399', '40'],
          ['#e2e838', '60'],
          ['#fb923c', '80'],
          ['#ef4444', '100 IRE'],
        ],
      };
    case 'hdr-nits':
      return {
        title: 'HDR',
        badges: [
          ['#38bdf8', `■ <${nitLow}n`],
          ['#5cd68d', `■ ${nitLow}–${nitHigh}n`],
          ['#fb7185', `■ >${nitHigh}n ${zh ? '峰值' : 'Peak'}`],
        ],
      };
  }
}

/** Pure DOM legend builder (Trusted-Types safe: never invokes `.innerHTML`). */
function renderLegendDom(container: HTMLElement, cfg: FalseColorConfig): void {
  const doc = container.ownerDocument;
  container.textContent = '';
  const { title, badges } = legendItems(cfg);
  const b = doc.createElement('b');
  b.style.color = '#9fb2c2';
  b.textContent = title;
  container.appendChild(b);
  for (const [color, text] of badges) {
    const s = doc.createElement('span');
    s.style.color = color;
    s.textContent = text;
    container.appendChild(s);
  }
}

export interface FalseColorDiagnostics {
  mounted: boolean;
  popoverOpen: boolean;
  status: 'disabled' | 'offscreen' | 'gpu-pending' | 'gpu-error' | 'rendering';
  box: RenderedVideoBox | null;
  gpuError: string | null;
}

function setHostImportant(el: HTMLElement, prop: string, val: string): void {
  el.style.setProperty(prop, val, 'important');
}

function applyIsolatedOverlayHostStyle(host: HTMLElement): void {
  // Never use `all: initial` on a `[popover]` host: Shadow DOM already isolates
  // internal styles, whereas `all: initial` resets browser-managed properties.
  // Use `!important` on every layout/visibility property so host-page cosmetic
  // filters (e.g. `html > div:not(#app) { display: none !important }`) cannot hide it.
  const props: Array<[string, string]> = [
    ['position', 'fixed'],
    ['inset', 'auto'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['box-sizing', 'border-box'],
    ['background', 'transparent'],
    ['pointer-events', 'none'],
    ['z-index', '2147483646'],
    ['overflow', 'hidden'],
    ['border-radius', '2px'],
    ['visibility', 'visible'],
    ['opacity', '1'],
    ['transform', 'none'],
    ['filter', 'none'],
    ['mix-blend-mode', 'normal'],
    ['clip-path', 'none'],
    ['max-width', 'none'],
    ['max-height', 'none'],
    ['min-width', '0'],
    ['min-height', '0'],
  ];
  for (const [k, v] of props) {
    setHostImportant(host, k, v);
  }
}

/**
 * Live WebGPU False-Color overlay positioned directly over the active `<video>`.
 *
 * Uses the browser's Top Layer (`popover="manual"`) at all times so it stays
 * strictly above `z-index: 2147483647` player shells, danmaku layers, and
 * `<dialog>` modals while remaining immune to `transform`/`filter`/`contain`
 * containing-block offsets on `<html>` or `<body>`.
 */
export class FalseColorOverlay {
  private host: HTMLDivElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private legend: HTMLDivElement | null = null;
  private gpu: CanvasGpu | null = null;
  private initPromise: Promise<boolean> | null = null;
  private gpuError: string | null = null;
  private status: FalseColorDiagnostics['status'] = 'disabled';
  private pipeline: GPURenderPipeline | null = null;
  private externalPipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private readonly uniformScratch = new ArrayBuffer(UNIFORM_BYTES);
  private readonly uF32 = new Float32Array(this.uniformScratch);
  private readonly uU32 = new Uint32Array(this.uniformScratch);
  private cachedView: GPUTextureView | null = null;
  private cachedBind: GPUBindGroup | null = null;
  private lastLegendKey = '';

  private trackedVideo: HTMLVideoElement | null = null;
  private resizeObs: ResizeObserver | null = null;
  private mutObs: MutationObserver | null = null;
  private rafId = 0;
  private lastBoxKey = '';
  private lastBox: RenderedVideoBox | null = null;
  private onGeometryChanged?: () => void;

  constructor(onGeometryChanged?: () => void) {
    this.onGeometryChanged = onGeometryChanged;
  }

  get diagnostics(): FalseColorDiagnostics {
    return {
      mounted: this.host !== null,
      popoverOpen: this.host ? isPopoverOpen(this.host) : false,
      status: this.status,
      box: this.lastBox,
      gpuError: this.gpuError,
    };
  }

  private readonly handleSync = (): void => {
    this.syncGeometry();
  };

  private readonly handleFullscreen = (): void => {
    if (this.host) placeTopLayerOverlayHost(this.host, true);
    this.lastBoxKey = '';
    this.syncGeometry(true);
  };

  mount(): void {
    if (this.host) {
      placeTopLayerOverlayHost(this.host);
      return;
    }
    // Clean up any stale orphan left behind by an invalidated/reloaded extension context
    for (const stale of Array.from(document.querySelectorAll(`#${OVERLAY_ID}`))) {
      stale.remove();
    }

    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    applyIsolatedOverlayHostStyle(host);

    const shadow = host.attachShadow({ mode: 'open' });
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';

    const legend = document.createElement('div');
    legend.className = 'legend';
    legend.style.cssText =
      'position:absolute;left:8px;bottom:8px;display:flex;flex-wrap:wrap;gap:7px;align-items:center;' +
      'padding:3px 8px;border-radius:4px;background:rgba(11,15,18,0.86);border:1px solid rgba(255,255,255,0.16);' +
      'font:10px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d7e3ec;max-width:calc(100% - 20px);';

    shadow.appendChild(canvas);
    shadow.appendChild(legend);

    this.host = host;
    this.canvas = canvas;
    this.legend = legend;
    this.gpuError = null;
    placeTopLayerOverlayHost(host);

    window.addEventListener('scroll', this.handleSync, { capture: true, passive: true });
    window.addEventListener('resize', this.handleSync, { passive: true });
    window.visualViewport?.addEventListener('resize', this.handleSync, { passive: true });
    window.visualViewport?.addEventListener('scroll', this.handleSync, { passive: true });
    document.addEventListener('fullscreenchange', this.handleFullscreen);
    this.startPositionWatch();
  }

  unmount(): void {
    if (this.rafId && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;
    this.unwatchVideo();
    window.removeEventListener('scroll', this.handleSync, true);
    window.removeEventListener('resize', this.handleSync);
    window.visualViewport?.removeEventListener('resize', this.handleSync);
    window.visualViewport?.removeEventListener('scroll', this.handleSync);
    document.removeEventListener('fullscreenchange', this.handleFullscreen);

    this.cachedBind = null;
    this.cachedView = null;
    this.uniformBuffer?.destroy();
    this.uniformBuffer = null;
    this.pipeline = null;
    this.externalPipeline = null;
    this.sampler = null;
    this.gpu = null;
    this.initPromise = null;
    this.gpuError = null;
    this.status = 'disabled';
    if (this.host) {
      const anyHost = this.host as HTMLElement & { hidePopover?: () => void };
      try {
        anyHost.hidePopover?.();
      } catch {
        // Ignore
      }
      this.host.remove();
    }
    this.host = null;
    this.canvas = null;
    this.legend = null;
    this.lastLegendKey = '';
    this.lastBoxKey = '';
    this.lastBox = null;
  }

  get mounted(): boolean {
    return this.host !== null;
  }

  private watchVideo(video: HTMLVideoElement): void {
    if (this.trackedVideo === video) return;
    this.unwatchVideo();
    this.trackedVideo = video;
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(this.handleSync);
      this.resizeObs.observe(video);
      if (video.parentElement) this.resizeObs.observe(video.parentElement);
    }
    if (typeof MutationObserver !== 'undefined') {
      this.mutObs = new MutationObserver(this.handleSync);
      this.mutObs.observe(video, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  }

  private unwatchVideo(): void {
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.mutObs?.disconnect();
    this.mutObs = null;
    this.trackedVideo = null;
  }

  private startPositionWatch(): void {
    if (this.rafId || typeof window.requestAnimationFrame !== 'function') return;
    const tick = (): void => {
      if (!this.host || !this.host.isConnected) {
        this.rafId = 0;
        return;
      }
      this.syncGeometry();
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  /**
   * Synchronize overlay DOM position & visibility against the video's current
   * viewport bounding box. If the video resized or the host was re-attached
   * while paused, triggers `onGeometryChanged` so WebGPU immediately redraws!
   */
  syncGeometry(forceNotify = false): { width: number; height: number } | null {
    if (!this.host || !this.trackedVideo) return null;
    const reattached = placeTopLayerOverlayHost(this.host);
    if (reattached) {
      this.lastBoxKey = '';
    }
    const box = renderedVideoBox(this.trackedVideo);
    this.lastBox = box;
    if (!box) {
      this.status = 'offscreen';
      if (this.lastBoxKey !== 'hidden') {
        setHostImportant(this.host, 'display', 'none');
        this.lastBoxKey = 'hidden';
      }
      return null;
    }

    const rawZoom = Number((this.host as unknown as { currentCSSZoom?: number }).currentCSSZoom);
    const z = Number.isFinite(rawZoom) && rawZoom > 0.05 ? rawZoom : 1;
    const l = Math.round(box.left / z);
    const t = Math.round(box.top / z);
    const w = Math.max(4, Math.round(box.width / z));
    const h = Math.max(4, Math.round(box.height / z));
    const key = `${l},${t},${w},${h}`;

    if (key !== this.lastBoxKey) {
      const prevParts = this.lastBoxKey.split(',');
      const sizeChanged = prevParts[2] !== String(w) || prevParts[3] !== String(h);
      this.lastBoxKey = key;
      setHostImportant(this.host, 'display', 'block');
      setHostImportant(this.host, 'visibility', 'visible');
      setHostImportant(this.host, 'opacity', '1');
      setHostImportant(this.host, 'left', `${l}px`);
      setHostImportant(this.host, 'top', `${t}px`);
      setHostImportant(this.host, 'width', `${w}px`);
      setHostImportant(this.host, 'height', `${h}px`);
      if ((sizeChanged || forceNotify || reattached) && this.trackedVideo.paused) {
        this.onGeometryChanged?.();
      }
    } else if ((forceNotify || reattached) && this.trackedVideo.paused) {
      this.onGeometryChanged?.();
    }
    return { width: Math.max(4, Math.round(box.width)), height: Math.max(4, Math.round(box.height)) };
  }

  ensureGpu(): Promise<boolean> {
    if (this.gpu && this.pipeline) return Promise.resolve(true);
    if (!this.canvas) return Promise.resolve(false);
    if (this.initPromise) return this.initPromise;

    const targetCanvas = this.canvas;
    this.initPromise = (async () => {
      try {
        const gpu = await initCanvas(targetCanvas);
        if (this.canvas !== targetCanvas) return false;
        const mod = gpu.device.createShaderModule({ code: falseColorWgsl });
        this.pipeline = gpu.device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: mod, entryPoint: 'vs' },
          fragment: { module: mod, entryPoint: 'fs', targets: [{ format: gpu.format }] },
          primitive: { topology: 'triangle-list' },
        });
        try {
          const extMod = gpu.device.createShaderModule({ code: falseColorExternalWgsl });
          this.externalPipeline = gpu.device.createRenderPipeline({
            layout: 'auto',
            vertex: { module: extMod, entryPoint: 'vs' },
            fragment: { module: extMod, entryPoint: 'fs', targets: [{ format: gpu.format }] },
            primitive: { topology: 'triangle-list' },
          });
        } catch {
          this.externalPipeline = null;
        }
        this.sampler = gpu.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
        this.uniformBuffer = gpu.device.createBuffer({
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.gpu = gpu;
        this.gpuError = null;
        if (this.trackedVideo?.paused) {
          this.onGeometryChanged?.();
        }
        return true;
      } catch (err) {
        this.gpuError = err instanceof Error ? err.message : String(err);
        this.status = 'gpu-error';
        console.warn('[video-scopes] false-color GPU init failed:', err);
        return false;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  encode(
    encoder: GPUCommandEncoder,
    video: HTMLVideoElement,
    analysis: AnalysisTexture,
    cfg: FalseColorConfig,
    externalTex: GPUExternalTexture | null = null,
  ): void {
    if (!cfg.enabled) {
      this.status = 'disabled';
      if (this.host) this.unmount();
      return;
    }
    this.mount();
    this.watchVideo(video);
    const dims = this.syncGeometry();
    if (!dims || !this.host || !this.canvas) return;

    const nitLow = Math.max(0.01, cfg.nitLow);
    const nitHigh = Math.max(nitLow + 1, cfg.nitHigh);
    const effPreset = resolveFcPreset(cfg);
    if (this.legend) {
      this.legend.style.display = cfg.showLegend !== false ? 'flex' : 'none';
      const legendKey = `${effPreset}:${nitLow}:${nitHigh}:${cfg.lang}:${cfg.showLegend}`;
      if (legendKey !== this.lastLegendKey) {
        this.lastLegendKey = legendKey;
        renderLegendDom(this.legend, cfg);
      }
    }

    if (!this.gpu || !this.pipeline || !this.sampler || !this.uniformBuffer) {
      if (!this.gpuError) this.status = 'gpu-pending';
      void this.ensureGpu();
      return;
    }

    this.status = 'rendering';
    configureCanvas(this.gpu, dims.width, dims.height);

    const c = LUMA[cfg.matrix];
    const map = axisMapping(cfg.range);
    const opacity = Math.max(0.2, Math.min(1, cfg.opacity ?? 0.88));
    const vw = Math.max(1, video.videoWidth);
    const vh = Math.max(1, video.videoHeight);
    const box = this.lastBox;
    const u0 = box ? box.cropX / vw : 0;
    const v0 = box ? box.cropY / vh : 0;
    const uSpan = box ? box.cropW / vw : 1;
    const vSpan = box ? box.cropH / vh : 1;

    const useNativeExternal =
      externalTex !== null && this.externalPipeline !== null && cfg.signalKind === 'display';
    // When sampling native externalTex directly, apply displayTransferFix here;
    // when falling back to `analysis`, Downscaler already applied it.
    const shaderTransferFix = useNativeExternal ? (cfg.displayTransferFix ?? 0) : 0;

    this.uF32.set([c.kr, c.kg, c.kb, map.black], 0);
    this.uF32.set([map.span, nitLow, nitHigh, opacity], 4);
    this.uU32.set(
      [
        cfg.signalKind === 'raw' ? 1 : 0,
        transferCode(cfg.sourceTransfer),
        transferCode(cfg.effectiveTransfer),
        presetCode(effPreset),
      ],
      8,
    );
    this.uF32.set([cfg.sdrWhiteNits ?? 203, shaderTransferFix, 0, 0], 12);
    this.uF32.set([u0, v0, uSpan, vSpan], 16);
    this.gpu.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch);

    let activePipeline = this.pipeline;
    let activeBind: GPUBindGroup;
    if (useNativeExternal && this.externalPipeline) {
      activePipeline = this.externalPipeline;
      activeBind = this.gpu.device.createBindGroup({
        layout: this.externalPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: externalTex },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      });
    } else {
      const view = analysis.view ?? analysis.texture.createView();
      if (view !== this.cachedView || !this.cachedBind) {
        this.cachedView = view;
        this.cachedBind = this.gpu.device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: view },
            { binding: 1, resource: this.sampler },
            { binding: 2, resource: { buffer: this.uniformBuffer } },
          ],
        });
      }
      activeBind = this.cachedBind;
    }

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.gpu.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    pass.setPipeline(activePipeline);
    pass.setBindGroup(0, activeBind);
    pass.draw(3);
    pass.end();
  }
}
