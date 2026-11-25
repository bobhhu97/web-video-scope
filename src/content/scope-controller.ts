import { configureCanvas, getDevice, initCanvas, type CanvasGpu } from '../gpu/device';
import { SignalTexture } from '../gpu/signal-texture';
import { Downscaler, analysisSize, type AnalysisPreset, type AnalysisTexture } from '../gpu/downscale';
import { ScopeRenderer, type ScopeMode, type ScopeOptions } from '../gpu/scope-renderer';
import { drawGraticule } from '../ui/graticule';
import { renderCie, renderVectorscope } from '../gpu/scatter-cpu';
import { AnalysisReader, unpackRows } from '../gpu/analysis-reader';
import { LUMA } from '../core/color/matrices';
import type { PanelTargets } from '../ui/hud';
import type { PrimariesId } from '../core/color/primaries';
import {
  FrameBufferPool,
  RawPlaneTexture,
  splitNv12,
  nv12Layout,
} from '../gpu/raw-planes';
import { ExternalVideoSource, type ExternalFrame } from '../gpu/external-source';
import DOWNSCALE_WGSL from '../gpu/shaders/downscale.wgsl?raw';
import DOWNSCALE_EXTERNAL_WGSL from '../gpu/shaders/downscale-external.wgsl?raw';
import RAW_DOWNSCALE_WGSL from '../gpu/shaders/raw-downscale.wgsl?raw';

export type SignalMode = 'display' | 'raw';

export type { PanelTargets };

export interface ControllerCallbacks {
  /** Called once per frame with the luma histogram (256 bins) and sample count. */
  onDiagnosis(hist: Uint32Array, total: number): void;
  /** Called after the command buffer for a frame has been submitted. */
  onFrameSubmitted(): void;
}

/**
 * Owns every GPU resource for the scopes.
 *
 * Kept separate from DOM, messaging and rVFC so the resource lifetime is
 * auditable in one place: if it is allocated here, `destroy()` frees it.
 */
export class ScopeController {
  private readonly gpus = new Map<ScopeMode, CanvasGpu>();
  private readonly renderers = new Map<ScopeMode, ScopeRenderer>();
  private device: GPUDevice | null = null;
  private signal: SignalTexture | null = null;
  private downscaler: Downscaler | null = null;
  private downscalerPreset: AnalysisPreset | null = null;
  private minIntervalMs = 1000 / 30;
  private lastAnalysisAt = 0;
  private busy = false;
  private destroyed = false;
  /**
   * Range diagnosis does not need per-frame statistics. A histogram readback is
   * a full GPU->CPU sync that serialises with every panel, so it is throttled
   * to 4 Hz — still far faster than a mislabelled source could realistically
   * change.
   */
  private lastStatsAt = 0;
  private signalMode: SignalMode = 'display';
  private external: ExternalVideoSource | null = null;
  private externalFailed = false;
  private rawPlanes: RawPlaneTexture | null = null;
  private readonly rawPool = new FrameBufferPool();
  private analysisReader: AnalysisReader | null = null;
  private lastScatterAt = 0;
  private rawDownscaler: Downscaler | null = null;
  private rawPending = false;
  /** Set by the owner so raw-path failures reach the UI instead of vanishing. */
  onRawError: ((message: string) => void) | null = null;

  constructor(
    private targets: PanelTargets[],
    private optionsFor: (mode: ScopeMode) => ScopeOptions,
    private readonly callbacks: ControllerCallbacks,
    private readonly gamuts: () => readonly PrimariesId[],
    private readonly preset: () => AnalysisPreset,
  ) {}

  setTargets(targets: PanelTargets[]): void {
    for (const [mode, renderer] of this.renderers) {
      const next = targets.find((t) => t.mode === mode);
      // A layout change rebuilds the canvas elements, so a renderer keyed by
      // mode may be bound to a canvas that is no longer in the document. Compare
      // the element, not just the mode: reusing the old renderer left the new
      // canvas blank (the scope drew into a detached element).
      const gpu = this.gpus.get(mode);
      const stale =
        !next ||
        !gpu ||
        (gpu.context.canvas as HTMLCanvasElement) !== next.gpu ||
        !next.gpu.isConnected;
      if (stale) {
        renderer.destroy();
        this.renderers.delete(mode);
        this.gpus.delete(mode);
      }
    }
    this.targets = targets;
  }

  setOptionsFor(fn: (mode: ScopeMode) => ScopeOptions): void {
    this.optionsFor = fn;
    for (const r of this.renderers.values()) r.setOptions(fn(r.options.mode));
  }

  setMinInterval(ms: number): void {
    this.minIntervalMs = Math.max(0, ms);
  }

  /**
   * Switch between the compositor's display-referred pixels and the decoder's
   * raw YUV planes.
   *
   * Display mode is correct for SDR Rec.709 and is nearly free. Raw mode is
   * required for accurate code values on PQ/HLG or non-Rec.709 sources, at the
   * cost of a frame copy plus a plane upload per analysed frame.
   */
  setSignalMode(mode: SignalMode): void {
    if (mode === this.signalMode) return;
    this.signalMode = mode;
    this.externalFailed = false;
    this.external?.destroy();
    this.external = null;
    this.rawPlanes?.destroy();
    this.rawPlanes = null;
    this.rawDownscaler?.destroy();
    this.rawDownscaler = null;
    for (const r of this.renderers.values()) r.setOptions({ signalKind: mode });
  }

  get mode(): SignalMode {
    return this.signalMode;
  }

  /** Analysis texture size, exposed for the HUD's resolution badge. */
  get analysisDims(): { width: number; height: number } | null {
    return this.downscaler ? { width: this.downscaler.width, height: this.downscaler.height } : null;
  }

  async frame(video: HTMLVideoElement): Promise<void> {
    if (this.destroyed || this.busy) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    const now = performance.now();
    if (now - this.lastAnalysisAt < this.minIntervalMs) return;

    this.busy = true;
    try {
      let analysis: Downscaler | null = null;

      if (this.signalMode === 'raw') {
        analysis = await this.prepareRaw(video);
        if (!analysis) return;
      } else {
        analysis = await this.prepareDisplay(video, now);
        if (!analysis) return;
      }
      if (!analysis) return;
      this.lastAnalysisAt = now;

      const wantStats = now - this.lastStatsAt >= 250;
      if (wantStats) this.lastStatsAt = now;

      // Hot path stays synchronous: no await per panel, so the four scopes are
      // submitted back to back and the GPU pipelines them.
      // Scatter scopes are drawn from a CPU histogram. See scatter-cpu.ts for why.
      const scatterTargets = this.targets.filter(
        (t) => t.mode === 'vectorscope' || t.mode === 'cie',
      );
      const wantsScatter = scatterTargets.length > 0;
      const scatterDue = wantsScatter && now - this.lastScatterAt >= this.scatterIntervalMs;
      if (scatterDue) this.lastScatterAt = now;

      let firstRenderer: ScopeRenderer | null = null;
      for (const target of this.targets) {
        if (target.mode === 'vectorscope' || target.mode === 'cie') {
          // Their canvas is painted below, from pixels rather than density.
          continue;
        }
        const renderer = await this.rendererFor(target);
        if (!renderer) continue;
        renderer.submit(analysis);
        this.drawGraticule(target, renderer);
        firstRenderer ??= renderer;
      }
      if (scatterDue) {
        // Fire and forget: the plots appear when the readback lands, and a slow
        // read must never stall the waveform pass.
        void this.paintScatter(scatterTargets, analysis);
      }

      this.callbacks.onFrameSubmitted();

      if (wantStats && firstRenderer) {
        // Fire and forget: the diagnosis callback runs when the readback lands.
        const reader = firstRenderer;
        const dims = { w: analysis.width, h: analysis.height };
        void (async () => {
          try {
            const hist = await reader.readHistogram();
            if (hist) this.callbacks.onDiagnosis(hist, dims.w * dims.h);
          } catch {
            // A dropped readback only delays the range verdict by one tick.
          }
        })();
      }
    } finally {
      this.busy = false;
    }
  }

  resize(): void {
    for (const [mode, gpu] of this.gpus) {
      const target = this.targets.find((t) => t.mode === mode);
      if (!target) continue;
      const resized = configureCanvas(gpu, target.gpu.clientWidth, target.gpu.clientHeight);
      if (resized) {
        const canvas = gpu.context.canvas as HTMLCanvasElement;
        const r = this.renderers.get(mode);
        r?.resize(canvas.width, canvas.height);
        r?.setOptions({ dpr: Math.min(window.devicePixelRatio || 1, 2.5) });
      }
    }
  }

  /**
   * Wrap the current frame, copy its native YUV planes, upload them and pack
   * them into the shared analysis texture.
   *
   * Chromium refuses `copyTo({format:'I420'})` ("doesn't support explicit copy
   * to non-RGB formats"), so the format argument is omitted and the frame's
   * native layout is used — NV12 for typical H.264/VP9. Failures are surfaced
   * via the notice bar rather than swallowed, because a silent failure here is
   * indistinguishable from a black image.
   */
  private async prepareRaw(video: HTMLVideoElement): Promise<Downscaler | null> {
    if (this.rawPending) return this.rawDownscaler;
    this.device ??= await getDevice();
    if (this.destroyed || !this.device) return null;

    if (!this.rawDownscaler) {
      const a = analysisSize(video.videoWidth, video.videoHeight, this.preset());
      this.rawDownscaler = new Downscaler(this.device, a.width, a.height, RAW_DOWNSCALE_WGSL);
    }

    let frame: VideoFrame | null = null;
    this.rawPending = true;
    try {
      frame = new VideoFrame(video);
      const rect = frame.visibleRect ?? { width: frame.codedWidth, height: frame.codedHeight };
      const width = rect.width;
      const height = rect.height;
      const buffer = await this.rawPool.fill(frame);

      // NV12 is the common case; anything else with the same 1.5 bpp shape is
      // treated identically.
      const layout = nv12Layout(width, height);
      if (buffer.length < layout.uvOffset + layout.uvStride * layout.uvHeight) {
        throw new Error(`unexpected raw frame size ${buffer.length} for ${width}x${height}`);
      }
      const { y, uv } = splitNv12(buffer, width, height);

      const device = this.device;
      const yTex = device.createTexture({
        size: { width, height },
        format: 'r8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      device.queue.writeTexture(
        { texture: yTex },
        y as BufferSource,
        { bytesPerRow: layout.yStride, rowsPerImage: height },
        { width, height },
      );

      // The interleaved UV plane is already `rg8`-shaped: one texel per chroma
      // sample, U in .r and V in .g. No CPU de-interleaving needed.
      const uvTex = device.createTexture({
        size: { width: width / 2, height: height / 2 },
        format: 'rg8unorm',
        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      });
      device.queue.writeTexture(
        { texture: uvTex },
        uv as BufferSource,
        { bytesPerRow: layout.uvStride, rowsPerImage: layout.uvHeight },
        { width: width / 2, height: height / 2 },
      );

      if (this.destroyed) {
        yTex.destroy();
        uvTex.destroy();
        return null;
      }
      this.rawPlanes?.destroy();
      this.rawPlanes = new RawPlaneTexture(yTex, uvTex, width, height);

      const cmd = device.createCommandEncoder();
      this.rawDownscaler.runRaw(cmd, this.rawPlanes);
      device.queue.submit([cmd.finish()]);
      return this.rawDownscaler;
    } catch (e) {
      // Report once per failure burst; the caller surfaces it in the notice bar.
      this.onRawError?.(e instanceof Error ? e.message : String(e));
      return this.rawDownscaler;
    } finally {
      this.rawPending = false;
      frame?.close();
    }
  }

  private async ensureSignal(video: HTMLVideoElement): Promise<void> {
    const needsSignal =
      !this.signal || this.signal.width !== video.videoWidth || this.signal.height !== video.videoHeight;
    const preset = this.preset();
    const needsDownscaler = !this.downscaler || this.downscalerPreset !== preset;

    if (!needsSignal && !needsDownscaler) return;

    this.device ??= await getDevice();
    if (this.destroyed) return;

    if (needsSignal) {
      this.signal?.destroy();
      this.signal = new SignalTexture(this.device, video);
    }
    if (needsDownscaler) {
      this.downscaler?.destroy();
      const a = analysisSize(this.signal!.width, this.signal!.height, preset);
      this.downscaler = new Downscaler(this.device, a.width, a.height, DOWNSCALE_WGSL);
      this.downscalerPreset = preset;
      // A new analysis size invalidates density buffers sized to the old plot.
      for (const r of this.renderers.values()) r.setOptions({});
    }
  }

  /**
   * Display path, preferring zero copy.
   *
   * `importExternalTexture` measured 0.10 ms/frame against 0.80 ms for
   * copyExternalImageToTexture, and moves no pixels. It is used whenever the
   * source can be imported; a tainted or unsupported source falls back to the
   * copy path permanently for that video.
   */
  private async prepareDisplay(
    video: HTMLVideoElement,
    now: number,
  ): Promise<Downscaler | null> {
    this.device ??= await getDevice();
    if (this.destroyed || !this.device) return null;

    if (!this.downscaler) {
      const a = analysisSize(video.videoWidth, video.videoHeight, this.preset());
      this.downscaler = new Downscaler(this.device, a.width, a.height, DOWNSCALE_WGSL);
      try {
        this.downscaler.enableExternalPath(DOWNSCALE_EXTERNAL_WGSL);
      } catch {
        // Keep the copy path only.
      }
    }

    // Zero-copy attempt.
    if (!this.externalFailed && this.downscaler.hasExternalPath) {
      this.external ??= new ExternalVideoSource(this.device);
      const frame = this.external.import(video);
      if (frame) {
        const cmd = this.device.createCommandEncoder();
        this.downscaler.runExternal(cmd, frame.texture);
        this.device.queue.submit([cmd.finish()]);
        this.lastUpload = 'external';
        return this.downscaler;
      }
      // One failed import is enough to stop retrying: the cause (taint) is
      // stable for the lifetime of the video element.
      this.externalFailed = true;
    }

    // Copy fallback.
    await this.ensureSignal(video);
    if (!this.signal) return null;
    if (!this.signal.update(video.currentTime)) return null;
    const cmd = this.device.createCommandEncoder();
    this.downscaler.run(cmd, this.signal.texture);
    this.device.queue.submit([cmd.finish()]);
    this.lastUpload = 'copy';
    return this.downscaler;
  }

  /** How often the scatter scopes are refreshed; they tolerate a low rate. */
  private scatterIntervalMs = 100;

  /**
   * Paint the scatter scopes from the analysis pixels.
   *
   * Deliberately decoupled from the waveform pass and rate-limited: a readback is
   * a synchronous GPU stall (1.5 MB for a 843x474 frame) and a vectorscope does
   * not need to update at the video's frame rate to be readable.
   */
  private async paintScatter(
    targets: PanelTargets[],
    analysis: AnalysisTexture,
  ): Promise<void> {
    if (!this.device) return;
    this.analysisReader ??= new AnalysisReader(this.device);
    if (this.analysisReader.busy) return;
    const raw = await this.analysisReader.read(analysis);
    if (!raw || this.destroyed) return;
    const packed = unpackRows(raw, analysis.width, analysis.height);

    for (const t of targets) {
      const opts = this.optionsFor(t.mode);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const cssW = Math.max(8, t.gpu.clientWidth);
      const cssH = Math.max(8, t.gpu.clientHeight);
      const dprW = Math.round(cssW * dpr);
      const dprH = Math.round(cssH * dpr);
      if (t.gpu.width !== dprW || t.gpu.height !== dprH) {
        t.gpu.width = dprW;
        t.gpu.height = dprH;
      }
      const ctx = t.gpu.getContext('2d');
      if (!ctx) continue;
      const plot = t.mode === 'vectorscope'
        ? renderVectorscope(
            packed,
            analysis.width,
            analysis.height,
            dprW,
            dprH,
            LUMA[opts.matrix],
            opts.zoom,
          )
        : renderCie(packed, analysis.width, analysis.height, dprW, dprH, opts.primaries, opts.coord, opts.zoom);
      ctx.putImageData(new ImageData(plot.data, plot.width, plot.height), 0, 0);
      this.drawScatterGraticule(t, opts);
    }
  }

  private drawScatterGraticule(t: PanelTargets, opts: ScopeOptions): void {
    const ctx = t.grat.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(t.grat.clientWidth));
    const h = Math.max(1, Math.round(t.grat.clientHeight));
    if (t.grat.width !== Math.round(w * dpr) || t.grat.height !== Math.round(h * dpr)) {
      t.grat.width = Math.round(w * dpr);
      t.grat.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraticule(ctx, { ...opts, width: w, height: h }, this.gamuts());
  }

  /** Which upload path the last frame used; surfaced in diagnostics. */
  private lastUpload: 'external' | 'copy' | 'raw' = 'copy';

  get uploadPath(): 'external' | 'copy' | 'raw' {
    return this.signalMode === 'raw' ? 'raw' : this.lastUpload;
  }

  private async rendererFor(target: PanelTargets): Promise<ScopeRenderer | null> {
    const existing = this.renderers.get(target.mode);
    if (existing) return existing;
    if (target.gpu.clientWidth === 0 || target.gpu.clientHeight === 0) return null;

    const gpu = await initCanvas(target.gpu);
    if (this.destroyed) return null;
    this.gpus.set(target.mode, gpu);

    // Size the backing store BEFORE creating the renderer. A freshly inserted
    // canvas is 300x150 by default; the renderer snapshots its dimensions in the
    // constructor, so creating it first left it drawing into the wrong size and
    // the scope appeared blank until some later resize corrected it.
    configureCanvas(gpu, target.gpu.clientWidth, target.gpu.clientHeight);

    const canvas = gpu.context.canvas as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const opts = {
      ...this.optionsFor(target.mode),
      width: canvas.width,
      height: canvas.height,
      dpr,
    };
    const renderer = new ScopeRenderer(gpu, opts);
    this.renderers.set(target.mode, renderer);
    return renderer;
  }

  private drawGraticule(target: PanelTargets, renderer: ScopeRenderer): void {
    const ctx = target.grat.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(target.grat.clientWidth));
    const h = Math.max(1, Math.round(target.grat.clientHeight));
    if (target.grat.width !== Math.round(w * dpr) || target.grat.height !== Math.round(h * dpr)) {
      target.grat.width = Math.round(w * dpr);
      target.grat.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraticule(ctx, { ...renderer.options, width: w, height: h }, this.gamuts());

    // One renderer draws the trace and the gridlines for a panel, so they share
    // a range by construction. Verify it anyway: a mismatch here is exactly the
    // "white reads above 100 IRE" symptom, and it is silent otherwise.
    const map = renderer.axisMap;
    const expected = renderer.options.range.limited
      ? { black: 16 / 255, span: 219 / 255 }
      : { black: 0, span: 1 };
    if (Math.abs(map.black - expected.black) > 1e-6 || Math.abs(map.span - expected.span) > 1e-6) {
      console.error('[video-scopes] axis mismatch', map, expected);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.gpus.clear();
    this.downscaler?.destroy();
    this.downscaler = null;
    this.signal?.destroy();
    this.signal = null;
    this.rawPlanes?.destroy();
    this.rawPlanes = null;
    this.rawDownscaler?.destroy();
    this.rawDownscaler = null;
    this.rawPool.clear();
    this.analysisReader?.destroy();
    this.analysisReader = null;
    this.external?.destroy();
    this.external = null;
    this.device = null;
  }
}
