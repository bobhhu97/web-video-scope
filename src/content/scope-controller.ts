import { canvasDpr, configureCanvas, getDevice, initCanvas, type CanvasGpu } from '../gpu/device';
import { SignalTexture } from '../gpu/signal-texture';
import { Downscaler, analysisSize, type AnalysisPreset } from '../gpu/downscale';
import {
  ScopeRenderer,
  type FrameStatsReadout,
  type ScopeMode,
  type ScopeOptions,
} from '../gpu/scope-renderer';
import { drawGraticule } from '../ui/graticule';
import { drawScopeProbeRings, type ProbeSample } from '../ui/probe';
import {
  FalseColorOverlay,
  type FalseColorConfig,
  type FalseColorDiagnostics,
} from '../ui/false-color-overlay';
import type { DisplayTransferFix } from '../core/color/transfer';
import type { PanelTargets } from '../ui/hud';
import type { PrimariesId } from '../core/color/primaries';
import {
  FrameBufferPool,
  RawPlaneTexture,
  floatToHalfBits,
  i420Layout,
  nv12Layout,
  p010Layout,
  splitI420,
  splitNv12,
  splitP010,
} from '../gpu/raw-planes';
import { ExternalVideoSource } from '../gpu/external-source';
import DOWNSCALE_WGSL from '../gpu/shaders/downscale.wgsl?raw';
import DOWNSCALE_EXTERNAL_WGSL from '../gpu/shaders/downscale-external.wgsl?raw';
import RAW_DOWNSCALE_WGSL from '../gpu/shaders/raw-downscale.wgsl?raw';

export type SignalMode = 'display' | 'raw';

export type { PanelTargets };

export interface HdrFrameStats {
  shadowPx: number;
  midPx: number;
  highPx: number;
  maxNits: number;
  totalPx: number;
}

export interface ControllerCallbacks {
  /** Called once per stats tick with the luma histogram (256 bins), sample count, and HDR zone stats. */
  onDiagnosis(hist: Uint32Array, total: number, hdr?: HdrFrameStats): void;
  /** Called after the single batched command buffer for a frame has been submitted. */
  onFrameSubmitted(hadReadback?: boolean): void;
}

/** Precomputed 10-bit code (0..1023) -> IEEE 754 binary16 bits lookup table for fast P010 upload. */
const CODE10_TO_F16 = (() => {
  const lut = new Uint16Array(1024);
  for (let i = 0; i < 1024; i++) {
    lut[i] = floatToHalfBits(i / 1023);
  }
  return lut;
})();

function graticuleCacheKey(w: number, h: number, dpr: number, o: ScopeOptions, gamuts: readonly PrimariesId[]): string {
  const g = (o.gamuts && o.gamuts.length > 0 ? o.gamuts : gamuts).join(',');
  return [
    w,
    h,
    dpr.toFixed(2),
    o.mode,
    o.channel,
    o.waveChannels ?? '',
    o.paradeMode ?? '',
    o.histMode ?? '',
    o.traceMode ?? '',
    o.units,
    o.effectiveTransfer ?? 'sdr',
    o.range.limited ? 1 : 0,
    o.range.depth,
    o.matrix,
    o.primaries,
    o.coord,
    o.barTargets ?? 0.75,
    o.showSkinLine !== false ? 1 : 0,
    o.toneFilter ?? 'all',
    o.nitLow ?? 100,
    o.nitHigh ?? 1000,
    (o.graticuleBrightness ?? 1).toFixed(2),
    (o.zoom ?? 1).toFixed(4),
    o.panX == null ? 'n' : o.panX.toFixed(5),
    o.panY == null ? 'n' : o.panY.toFixed(5),
    g,
  ].join('|');
}

/**
 * Owns every GPU resource for the scopes (keyed per panel slot so multiple
 * cells can even run the same scope type with independent pro settings).
 */
export class ScopeController {
  private readonly gpus = new Map<number, CanvasGpu>();
  private readonly renderers = new Map<number, ScopeRenderer>();
  private readonly graticuleKeys = new Map<number, string>();
  private readonly falseColor = new FalseColorOverlay(() => {
    if (this.lastSampledVideo && !this.destroyed) {
      void this.frame(this.lastSampledVideo, true);
    }
  });
  private lastProbeSample: ProbeSample | null = null;
  private device: GPUDevice | null = null;
  private signal: SignalTexture | null = null;
  private downscaler: Downscaler | null = null;
  private downscalerPreset: AnalysisPreset | null = null;
  private downscalerSrcW = 0;
  private downscalerSrcH = 0;
  private lastSampledVideo: HTMLVideoElement | null = null;
  private lastSampledTime = -1;
  private lastSampledTransferFix: DisplayTransferFix = 0;
  private minIntervalMs = (1000 / 30) * 0.85;
  private lastAnalysisAt = 0;
  private busy = false;
  private pendingForceVideo: HTMLVideoElement | null = null;
  private destroyed = false;
  private lastStatsAt = 0;
  private signalMode: SignalMode = 'display';
  private external: ExternalVideoSource | null = null;
  private externalFailed = false;
  private rawPlanes: RawPlaneTexture | null = null;
  private rawPlaneFmt = '';
  private readonly rawPool = new FrameBufferPool();
  private uvInterleaveScratch: Uint8Array | null = null;
  private p010YScratch: Uint16Array | null = null;
  private p010UvScratch: Uint16Array | null = null;
  private rawDownscaler: Downscaler | null = null;
  private rawPending = false;
  onRawError: ((message: string) => void) | null = null;

  constructor(
    private targets: PanelTargets[],
    private optionsFor: (slot: number, mode: ScopeMode) => ScopeOptions,
    private readonly callbacks: ControllerCallbacks,
    private readonly gamuts: () => readonly PrimariesId[],
    private readonly preset: () => AnalysisPreset,
    private readonly falseColorCfg?: () => FalseColorConfig,
  ) {}

  setTargets(targets: PanelTargets[]): void {
    for (const [slot, renderer] of this.renderers) {
      const next = targets.find((t) => t.slot === slot);
      const gpu = this.gpus.get(slot);
      const stale =
        !next ||
        !gpu ||
        (gpu.context.canvas as HTMLCanvasElement) !== next.gpu ||
        !next.gpu.isConnected;
      if (stale) {
        renderer.destroy();
        this.renderers.delete(slot);
        this.gpus.delete(slot);
        this.graticuleKeys.delete(slot);
      } else if (next) {
        renderer.setOptions(this.optionsFor(slot, next.mode));
      }
    }
    this.targets = targets;
    if (this.lastProbeSample) {
      this.drawProbeRings(this.lastProbeSample);
    }
  }

  setOptionsFor(fn: (slot: number, mode: ScopeMode) => ScopeOptions): void {
    this.optionsFor = fn;
    for (const target of this.targets) {
      const r = this.renderers.get(target.slot);
      if (r) r.setOptions(fn(target.slot, target.mode));
    }
    if (this.lastProbeSample) {
      this.drawProbeRings(this.lastProbeSample);
    }
  }

  /**
   * Render synchronized Eyedropper ring indicators onto every visible cell's
   * lightweight `marker` 2D canvas without re-running WebGPU or redrawing graticules.
   */
  drawProbeRings(sample: ProbeSample | null): void {
    this.lastProbeSample = sample;
    for (const target of this.targets) {
      const marker = target.marker;
      if (!marker) continue;
      const dpr = canvasDpr(marker);
      const w = Math.max(1, Math.round(marker.clientWidth));
      const h = Math.max(1, Math.round(marker.clientHeight));
      if (tGraticuleNeedsResize(marker, w, h, dpr)) {
        marker.width = Math.round(w * dpr);
        marker.height = Math.round(h * dpr);
      }
      const ctx = marker.getContext('2d');
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!sample) {
        ctx.clearRect(0, 0, w, h);
        continue;
      }
      const r = this.renderers.get(target.slot);
      const opts = r ? r.options : this.optionsFor(target.slot, target.mode);
      drawScopeProbeRings(ctx, { ...opts, width: w, height: h, dpr }, sample);
    }
  }

  invalidateStats(): void {
    this.lastStatsAt = 0;
  }

  setMinInterval(ms: number): void {
    this.minIntervalMs = Math.max(0, ms * 0.85);
  }

  setSignalMode(mode: SignalMode): void {
    if (mode === this.signalMode) return;
    this.signalMode = mode;
    this.externalFailed = false;
    this.external?.destroy();
    this.external = null;
    this.rawPlanes?.destroy();
    this.rawPlanes = null;
    this.rawPlaneFmt = '';
    this.rawDownscaler?.destroy();
    this.rawDownscaler = null;
    this.lastSampledVideo = null;
    this.lastSampledTime = -1;
    for (const r of this.renderers.values()) r.setOptions({ signalKind: mode });
  }

  get mode(): SignalMode {
    return this.signalMode;
  }

  get analysisDims(): { width: number; height: number } | null {
    const d = this.signalMode === 'raw' ? this.rawDownscaler : this.downscaler;
    return d ? { width: d.width, height: d.height } : null;
  }

  get falseColorDiagnostics(): FalseColorDiagnostics {
    return this.falseColor.diagnostics;
  }

  async frame(video: HTMLVideoElement, force = false): Promise<void> {
    if (this.destroyed) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    if (this.busy) {
      if (force) this.pendingForceVideo = video;
      return;
    }

    const now = performance.now();
    if (!force && now - this.lastAnalysisAt < this.minIntervalMs) return;

    this.busy = true;
    try {
      this.resize();
      this.device ??= await getDevice();
      if (this.destroyed || !this.device) return;

      // Ensure all visible cell renderers are initialised before encoding the batch.
      // Re-check `this.targets` if a relayout happened while awaiting `initCanvas`.
      let activePairs: { target: PanelTargets; renderer: ScopeRenderer }[] = [];
      for (let pass = 0; pass < 2; pass++) {
        const snap = this.targets;
        activePairs = [];
        for (const target of snap) {
          const renderer = await this.rendererFor(target);
          if (renderer) activePairs.push({ target, renderer });
        }
        if (this.targets === snap) break;
      }

      const fcCfg = this.falseColorCfg?.();
      if (fcCfg?.enabled) {
        this.falseColor.mount();
        await this.falseColor.ensureGpu();
      } else if (this.falseColor.mounted) {
        this.falseColor.unmount();
      }

      const encoder = this.device.createCommandEncoder();
      let analysis: Downscaler | null = null;
      let externalTexForFc: GPUExternalTexture | null = null;
      const transferFix: DisplayTransferFix = fcCfg?.displayTransferFix ?? 0;

      if (this.signalMode === 'raw') {
        analysis = await this.encodeRawDownscale(encoder, video);
      } else {
        const disp = this.encodeDisplayDownscale(encoder, video, force, transferFix);
        analysis = disp.analysis;
        externalTexForFc = disp.externalTex;
      }

      if (!analysis) {
        // Nothing new to sample (e.g. paused frame without force); sync false-color visibility if disabled.
        const fc = this.falseColorCfg?.();
        if (fc && !fc.enabled && this.falseColor.mounted) this.falseColor.unmount();
        return;
      }
      this.lastAnalysisAt = now;

      const wantStats = (force && this.lastStatsAt === 0) || (!force && now - this.lastStatsAt >= 300);
      if (wantStats) this.lastStatsAt = now;

      let firstRenderer: ScopeRenderer | null = null;
      for (let i = 0; i < activePairs.length; i++) {
        const { target, renderer } = activePairs[i]!;
        renderer.encode(encoder, analysis, i === 0);
        this.drawGraticuleIfNeeded(target, renderer);
        if (i === 0) firstRenderer = renderer;
      }

      if (this.falseColorCfg) {
        const latestFc = this.falseColorCfg();
        if (
          latestFc.enabled &&
          !externalTexForFc &&
          this.signalMode === 'display' &&
          !this.externalFailed
        ) {
          this.external ??= new ExternalVideoSource(this.device);
          externalTexForFc = this.external.import(video)?.texture ?? null;
        }
        this.falseColor.encode(encoder, video, analysis, latestFc, externalTexForFc);
      }

      // Single GPU queue submission per frame across downscaler + all cells + false-color!
      this.device.queue.submit([encoder.finish()]);

      if (!force) {
        this.callbacks.onFrameSubmitted(wantStats);
      }

      if (wantStats && firstRenderer) {
        const reader = firstRenderer;
        const totalPx = analysis.width * analysis.height;
        void (async () => {
          try {
            const stats: FrameStatsReadout | null = await reader.readStats();
            if (stats && !this.destroyed) {
              this.callbacks.onDiagnosis(stats.hist, totalPx, {
                shadowPx: stats.shadowPx,
                midPx: stats.midPx,
                highPx: stats.highPx,
                maxNits: stats.maxNits,
                totalPx,
              });
            }
          } catch {
            // Transient mapAsync cancellation on teardown/resize is non-fatal.
          }
        })();
      }
    } finally {
      this.busy = false;
      if (this.pendingForceVideo && !this.destroyed) {
        const nextVideo = this.pendingForceVideo;
        this.pendingForceVideo = null;
        void this.frame(nextVideo, true);
      }
    }
  }

  resize(): void {
    for (const [slot, gpu] of this.gpus) {
      const target = this.targets.find((t) => t.slot === slot);
      if (!target) continue;
      const cssW = target.gpu.clientWidth;
      const cssH = target.gpu.clientHeight;
      if (cssW <= 0 || cssH <= 0) continue;
      configureCanvas(gpu, cssW, cssH);
      const canvas = gpu.context.canvas as HTMLCanvasElement;
      const dpr = canvasDpr(canvas);
      const r = this.renderers.get(slot);
      if (r) {
        r.resize(canvas.width, canvas.height, dpr);
        this.drawGraticuleIfNeeded(target, r);
      }
    }
    if (this.lastProbeSample) {
      this.drawProbeRings(this.lastProbeSample);
    }
  }

  private ensureRawPlanes(
    device: GPUDevice,
    width: number,
    height: number,
    fmt: 'u8' | 'f16',
  ): RawPlaneTexture {
    const key = `${width}x${height}:${fmt}`;
    if (this.rawPlanes && this.rawPlaneFmt === key) {
      return this.rawPlanes;
    }
    this.rawPlanes?.destroy();
    const yTex = device.createTexture({
      size: { width, height },
      format: fmt === 'f16' ? 'r16float' : 'r8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    const uvTex = device.createTexture({
      size: { width: width / 2, height: height / 2 },
      format: fmt === 'f16' ? 'rg16float' : 'rg8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.rawPlanes = new RawPlaneTexture(yTex, uvTex, width, height);
    this.rawPlaneFmt = key;
    return this.rawPlanes;
  }

  private async encodeRawDownscale(
    encoder: GPUCommandEncoder,
    video: HTMLVideoElement,
  ): Promise<Downscaler | null> {
    if (this.rawPending || !this.device) return this.rawDownscaler;

    const preset = this.preset();
    if (
      !this.rawDownscaler ||
      this.downscalerPreset !== preset ||
      this.downscalerSrcW !== video.videoWidth ||
      this.downscalerSrcH !== video.videoHeight
    ) {
      this.rawDownscaler?.destroy();
      const a = analysisSize(video.videoWidth, video.videoHeight, preset);
      const filter: GPUFilterMode = preset === 'native' ? 'nearest' : 'linear';
      this.rawDownscaler = new Downscaler(this.device, a.width, a.height, RAW_DOWNSCALE_WGSL, {
        filter,
      });
      this.downscalerPreset = preset;
      this.downscalerSrcW = video.videoWidth;
      this.downscalerSrcH = video.videoHeight;
    }

    let frame: VideoFrame | null = null;
    this.rawPending = true;
    try {
      frame = new VideoFrame(video);
      if (frame.format === null) {
        throw new Error(
          'Hardware-decoded opaque GPU frame (format=null); switch back to Display (0-copy) mode',
        );
      }
      const rect = frame.visibleRect ?? { width: frame.codedWidth, height: frame.codedHeight };
      const width = rect.width & ~1;
      const height = rect.height & ~1;
      const fmt: string = frame.format ?? 'NV12';
      const buffer = await this.rawPool.fill(frame);
      if (this.destroyed || !this.device) return null;

      if (fmt === 'P010') {
        const layout = p010Layout(width, height);
        if (buffer.length < layout.uvOffset + layout.uvStride * layout.uvHeight) {
          throw new Error(`unexpected P010 frame size ${buffer.length} for ${width}x${height}`);
        }
        const { y16, uv16 } = splitP010(buffer, width, height);
        const yLen = width * height;
        const uvLen = width * layout.uvHeight;
        if (!this.p010YScratch || this.p010YScratch.length < yLen) {
          this.p010YScratch = new Uint16Array(yLen);
        }
        if (!this.p010UvScratch || this.p010UvScratch.length < uvLen) {
          this.p010UvScratch = new Uint16Array(uvLen);
        }
        for (let i = 0; i < yLen; i++) {
          this.p010YScratch[i] = CODE10_TO_F16[y16[i]! >> 6]!;
        }
        for (let i = 0; i < uvLen; i++) {
          this.p010UvScratch[i] = CODE10_TO_F16[uv16[i]! >> 6]!;
        }
        const planes = this.ensureRawPlanes(this.device, width, height, 'f16');
        this.device.queue.writeTexture(
          { texture: planes.y },
          this.p010YScratch.subarray(0, yLen) as unknown as BufferSource,
          { bytesPerRow: width * 2, rowsPerImage: height },
          { width, height },
        );
        this.device.queue.writeTexture(
          { texture: planes.uv },
          this.p010UvScratch.subarray(0, uvLen) as unknown as BufferSource,
          { bytesPerRow: width * 2, rowsPerImage: height / 2 },
          { width: width / 2, height: height / 2 },
        );
        this.rawDownscaler.runRaw(encoder, planes);
      } else if (fmt === 'I420' || fmt === 'I420A') {
        const layout = i420Layout(width, height);
        if (buffer.length < layout.vOffset + layout.chromaStride * layout.chromaHeight) {
          throw new Error(`unexpected I420 frame size ${buffer.length} for ${width}x${height}`);
        }
        const { y, u, v } = splitI420(buffer, width, height);
        const uvPairs = layout.chromaWidth * layout.chromaHeight;
        if (!this.uvInterleaveScratch || this.uvInterleaveScratch.length < uvPairs * 2) {
          this.uvInterleaveScratch = new Uint8Array(uvPairs * 2);
        }
        for (let i = 0; i < uvPairs; i++) {
          this.uvInterleaveScratch[i * 2] = u[i]!;
          this.uvInterleaveScratch[i * 2 + 1] = v[i]!;
        }
        const planes = this.ensureRawPlanes(this.device, width, height, 'u8');
        this.device.queue.writeTexture(
          { texture: planes.y },
          y as BufferSource,
          { bytesPerRow: layout.yStride, rowsPerImage: height },
          { width, height },
        );
        this.device.queue.writeTexture(
          { texture: planes.uv },
          this.uvInterleaveScratch.subarray(0, uvPairs * 2) as BufferSource,
          { bytesPerRow: width, rowsPerImage: height / 2 },
          { width: width / 2, height: height / 2 },
        );
        this.rawDownscaler.runRaw(encoder, planes);
      } else {
        const layout = nv12Layout(width, height);
        if (buffer.length < layout.uvOffset + layout.uvStride * layout.uvHeight) {
          throw new Error(`unexpected raw frame size ${buffer.length} for ${width}x${height} (${fmt})`);
        }
        const { y, uv } = splitNv12(buffer, width, height);
        const planes = this.ensureRawPlanes(this.device, width, height, 'u8');
        this.device.queue.writeTexture(
          { texture: planes.y },
          y as BufferSource,
          { bytesPerRow: layout.yStride, rowsPerImage: height },
          { width, height },
        );
        this.device.queue.writeTexture(
          { texture: planes.uv },
          uv as BufferSource,
          { bytesPerRow: layout.uvStride, rowsPerImage: layout.uvHeight },
          { width: width / 2, height: height / 2 },
        );
        this.rawDownscaler.runRaw(encoder, planes);
      }
      return this.rawDownscaler;
    } catch (e) {
      this.onRawError?.(e instanceof Error ? e.message : String(e));
      return this.rawDownscaler;
    } finally {
      this.rawPending = false;
      frame?.close();
    }
  }

  private ensureDisplayDownscaler(video: HTMLVideoElement): boolean {
    if (!this.device) return false;
    const preset = this.preset();
    const needsRebuild =
      !this.downscaler ||
      this.downscalerPreset !== preset ||
      this.downscalerSrcW !== video.videoWidth ||
      this.downscalerSrcH !== video.videoHeight;
    if (!needsRebuild) return false;

    this.downscaler?.destroy();
    const a = analysisSize(video.videoWidth, video.videoHeight, preset);
    const filter: GPUFilterMode = preset === 'native' ? 'nearest' : 'linear';
    this.downscaler = new Downscaler(this.device, a.width, a.height, DOWNSCALE_WGSL, { filter });
    try {
      this.downscaler.enableExternalPath(DOWNSCALE_EXTERNAL_WGSL);
    } catch {
      // Keep the copy path only.
    }
    this.downscalerPreset = preset;
    this.downscalerSrcW = video.videoWidth;
    this.downscalerSrcH = video.videoHeight;
    return true;
  }

  private encodeDisplayDownscale(
    encoder: GPUCommandEncoder,
    video: HTMLVideoElement,
    force: boolean,
    transferFix: DisplayTransferFix,
  ): { analysis: Downscaler | null; externalTex: GPUExternalTexture | null } {
    if (!this.device) return { analysis: null, externalTex: null };
    const rebuiltDownscaler = this.ensureDisplayDownscaler(video);
    if (!this.downscaler) return { analysis: null, externalTex: null };

    const samePausedFrame =
      !rebuiltDownscaler &&
      transferFix === this.lastSampledTransferFix &&
      video === this.lastSampledVideo &&
      video.paused &&
      !video.seeking &&
      Math.abs(video.currentTime - this.lastSampledTime) < 1e-5;
    if (samePausedFrame) {
      // Reuse the existing analysis texture on forced UI/zoom/pan redraws while paused!
      return { analysis: force ? this.downscaler : null, externalTex: null };
    }

    // Zero-copy external texture path (preserves extended HDR floats into rgba16float!).
    if (!this.externalFailed && this.downscaler.hasExternalPath) {
      this.external ??= new ExternalVideoSource(this.device);
      const extFrame = this.external.import(video);
      if (extFrame) {
        this.downscaler.runExternal(encoder, extFrame.texture, transferFix);
        this.lastUpload = 'external';
        this.lastSampledVideo = video;
        this.lastSampledTime = video.currentTime;
        this.lastSampledTransferFix = transferFix;
        return { analysis: this.downscaler, externalTex: extFrame.texture };
      }
      this.externalFailed = true;
    }

    // Copy fallback.
    if (
      !this.signal ||
      this.signal.width !== video.videoWidth ||
      this.signal.height !== video.videoHeight
    ) {
      this.signal?.destroy();
      this.signal = new SignalTexture(this.device, video);
    }
    const signal = this.signal;
    const uploaded = signal.update(video.currentTime);
    if (!uploaded && !rebuiltDownscaler && transferFix === this.lastSampledTransferFix) {
      return { analysis: force ? this.downscaler : null, externalTex: null };
    }
    this.downscaler.run(encoder, signal.texture, transferFix);
    this.lastUpload = 'copy';
    this.lastSampledVideo = video;
    this.lastSampledTime = video.currentTime;
    this.lastSampledTransferFix = transferFix;
    return { analysis: this.downscaler, externalTex: null };
  }

  private lastUpload: 'external' | 'copy' | 'raw' = 'copy';

  get uploadPath(): 'external' | 'copy' | 'raw' {
    return this.signalMode === 'raw' ? 'raw' : this.lastUpload;
  }

  private async rendererFor(target: PanelTargets): Promise<ScopeRenderer | null> {
    const existing = this.renderers.get(target.slot);
    const existingGpu = this.gpus.get(target.slot);
    if (existing && existingGpu && (existingGpu.context.canvas as HTMLCanvasElement) === target.gpu) {
      return existing;
    }
    if (existing) {
      existing.destroy();
      this.renderers.delete(target.slot);
      this.gpus.delete(target.slot);
      this.graticuleKeys.delete(target.slot);
    }
    if (target.gpu.clientWidth === 0 || target.gpu.clientHeight === 0) return null;

    const gpu = await initCanvas(target.gpu);
    if (
      this.destroyed ||
      !target.gpu.isConnected ||
      this.targets.find((t) => t.slot === target.slot)?.gpu !== target.gpu
    ) {
      return null;
    }
    this.gpus.set(target.slot, gpu);

    configureCanvas(gpu, target.gpu.clientWidth, target.gpu.clientHeight);

    const canvas = gpu.context.canvas as HTMLCanvasElement;
    const dpr = canvasDpr(canvas);
    const opts = {
      ...this.optionsFor(target.slot, target.mode),
      width: canvas.width,
      height: canvas.height,
      dpr,
    };
    const renderer = new ScopeRenderer(gpu, opts);
    this.renderers.set(target.slot, renderer);
    return renderer;
  }

  private drawGraticuleIfNeeded(target: PanelTargets, renderer: ScopeRenderer): void {
    const dpr = canvasDpr(target.grat);
    const w = Math.max(1, Math.round(target.grat.clientWidth));
    const h = Math.max(1, Math.round(target.grat.clientHeight));
    const resized = tGraticuleNeedsResize(target.grat, w, h, dpr);
    const key = graticuleCacheKey(w, h, dpr, renderer.options, this.gamuts());
    if (!resized && this.graticuleKeys.get(target.slot) === key) {
      return;
    }
    const ctx = target.grat.getContext('2d');
    if (!ctx) return;
    if (resized) {
      target.grat.width = Math.round(w * dpr);
      target.grat.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraticule(ctx, { ...renderer.options, width: w, height: h, dpr }, this.gamuts());
    this.graticuleKeys.set(target.slot, key);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingForceVideo = null;
    this.falseColor.unmount();
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.gpus.clear();
    this.graticuleKeys.clear();
    this.downscaler?.destroy();
    this.downscaler = null;
    this.signal?.destroy();
    this.signal = null;
    this.rawPlanes?.destroy();
    this.rawPlanes = null;
    this.rawPlaneFmt = '';
    this.rawDownscaler?.destroy();
    this.rawDownscaler = null;
    this.rawPool.clear();
    this.uvInterleaveScratch = null;
    this.p010YScratch = null;
    this.p010UvScratch = null;
    this.external?.destroy();
    this.external = null;
    this.device = null;
  }
}

function tGraticuleNeedsResize(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
  dpr: number,
): boolean {
  return canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr);
}
