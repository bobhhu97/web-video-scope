import { configureCanvas, getDevice, initCanvas, type CanvasGpu } from '../gpu/device';
import { SignalTexture } from '../gpu/signal-texture';
import { Downscaler, analysisSize, type AnalysisPreset } from '../gpu/downscale';
import { ScopeRenderer, type ScopeMode, type ScopeOptions } from '../gpu/scope-renderer';
import { drawGraticule } from '../ui/graticule';
import type { PanelTargets } from '../ui/hud';
import type { PrimariesId } from '../core/color/primaries';
import DOWNSCALE_WGSL from '../gpu/shaders/downscale.wgsl?raw';

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

  constructor(
    private targets: PanelTargets[],
    private optionsFor: (mode: ScopeMode) => ScopeOptions,
    private readonly callbacks: ControllerCallbacks,
    private readonly gamuts: () => readonly PrimariesId[],
    private readonly preset: () => AnalysisPreset,
  ) {}

  setTargets(targets: PanelTargets[]): void {
    for (const mode of this.renderers.keys()) {
      if (!targets.some((t) => t.mode === mode)) {
        this.renderers.get(mode)?.destroy();
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
      await this.ensureSignal(video);
      if (!this.signal) return;
      if (!this.signal.update(video.currentTime)) return;
      this.lastAnalysisAt = now;

      const device = this.device!;
      const cmd = device.createCommandEncoder();
      this.downscaler!.run(cmd, this.signal.texture);
      device.queue.submit([cmd.finish()]);

      const wantStats = now - this.lastStatsAt >= 250;
      if (wantStats) this.lastStatsAt = now;

      // Hot path stays synchronous: no await per panel, so the four scopes are
      // submitted back to back and the GPU pipelines them.
      let firstRenderer: ScopeRenderer | null = null;
      for (const target of this.targets) {
        const renderer = await this.rendererFor(target);
        if (!renderer) continue;
        renderer.submit(this.downscaler!);
        this.drawGraticule(target, renderer);
        firstRenderer ??= renderer;
      }
      this.callbacks.onFrameSubmitted();

      if (wantStats && firstRenderer) {
        // Fire and forget: the diagnosis callback runs when the readback lands.
        void firstRenderer
          .readHistogram()
          .then((hist) => {
            if (hist) this.callbacks.onDiagnosis(hist, this.downscaler!.width * this.downscaler!.height);
          })
          .catch(() => {});
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
        this.renderers.get(mode)?.resize(canvas.width, canvas.height);
      }
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

  private async rendererFor(target: PanelTargets): Promise<ScopeRenderer | null> {
    const existing = this.renderers.get(target.mode);
    if (existing) return existing;
    if (target.gpu.clientWidth === 0 || target.gpu.clientHeight === 0) return null;

    const gpu = await initCanvas(target.gpu);
    if (this.destroyed) return null;
    this.gpus.set(target.mode, gpu);
    const canvas = gpu.context.canvas as HTMLCanvasElement;
    const opts = { ...this.optionsFor(target.mode), width: canvas.width, height: canvas.height };
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
    this.device = null;
  }
}
