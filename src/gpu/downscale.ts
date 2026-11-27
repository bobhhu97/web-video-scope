export type AnalysisPreset = 'low' | 'default' | 'high' | 'ultra' | 'fhd' | 'full';
export type PrecisionMode = 'auto' | AnalysisPreset;

/**
 * The fixed-resolution presets, in ascending order of long edge.
 *
 * `fhd` used to be called `native`, which was a misnomer: it is a fixed 1920
 * long edge, not 1:1 with the source. `full` is the only preset that follows
 * the source, so it is deliberately absent from this list.
 */
export const FIXED_PRESETS = ['low', 'default', 'high', 'ultra', 'fhd'] as const;

const PRECISION_MODES: readonly PrecisionMode[] = [
  'auto',
  'low',
  'default',
  'high',
  'ultra',
  'fhd',
  'full',
];

/**
 * Coerce a persisted value into a preset we still understand.
 *
 * Older builds stored `native`; that string is renamed to `fhd`. Anything
 * unrecognised (hand-edited storage, a preset removed in a later version) falls
 * back to `auto` rather than being handed to the renderer.
 */
export function normalizePrecision(value: unknown): PrecisionMode {
  if (value === 'native') return 'fhd';
  return PRECISION_MODES.includes(value as PrecisionMode) ? (value as PrecisionMode) : 'auto';
}

/**
 * The largest long edge we will ever analyse 1:1.
 *
 * 8192 is the smallest `maxTextureDimension2D` a conformant WebGPU adapter may
 * report, so a source at or below this always fits. Anything wider (16K, 32K
 * panoramas) is scaled down to this edge instead of failing texture creation.
 */
export const MAX_ANALYSIS_EDGE = 8192;

/**
 * Long-edge pixel count per preset. Defining the long edge (not the height)
 * means portrait and landscape share one knob and the aspect ratio never
 * distorts. 640 long edge on 16:9 gives exactly 640x360.
 *
 * `full` means literally 1:1: for any source up to 8K the `long <= target`
 * test wins and `analysisSize` returns the source resolution untouched. This
 * costs GPU time and VRAM (an 8K rgba16float analysis texture is ~253 MB), so
 * it is a deliberate manual override and never selected by the auto governor.
 */
export const ANALYSIS_SIZES: Record<AnalysisPreset, number> = {
  low: 320,
  default: 640,
  high: 854,
  ultra: 1280,
  fhd: 1920,
  full: MAX_ANALYSIS_EDGE,
};

export const PRESET_MAX_PIXELS: Record<AnalysisPreset, number> = {
  low: 400_000,
  default: 400_000,
  high: 400_000,
  ultra: 950_000,
  fhd: 2_100_000,
  // No second reduction: `ANALYSIS_SIZES.full` is already the hard edge cap.
  full: Number.POSITIVE_INFINITY,
};

const MIN_DIM = 1;

/**
 * Pick the analysis texture size for a source.
 * - preserves aspect ratio
 * - scales by the preset's long edge
 * - never upscales (a 320x180 source is analysed at 320x180)
 * - optional maxPixels cap for very wide aspect ratios
 */
export function analysisSize(
  srcW: number,
  srcH: number,
  preset: AnalysisPreset,
  maxPixels = PRESET_MAX_PIXELS[preset],
): { width: number; height: number } {
  // Reject non-finite and non-positive sources alike: a detached <video> can
  // report NaN, and `NaN <= 0` is false, so a plain comparison would let NaN
  // through into a texture allocation.
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
    return { width: MIN_DIM, height: MIN_DIM };
  }
  const long = Math.max(srcW, srcH);
  const target = ANALYSIS_SIZES[preset];
  const scale = long <= target ? 1 : target / long;

  let width = Math.max(MIN_DIM, Math.round(srcW * scale));
  let height = Math.max(MIN_DIM, Math.round(srcH * scale));

  const pixels = width * height;
  if (pixels > maxPixels) {
    const k = Math.sqrt(maxPixels / pixels);
    width = Math.max(MIN_DIM, Math.floor(width * k));
    height = Math.max(MIN_DIM, Math.floor(height * k));
  }
  return { width, height };
}

/** Anything the gather pass can read as its signal source. */
export interface AnalysisTexture {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
}

export class Downscaler implements AnalysisTexture {
  readonly device: GPUDevice;
  private pipeline: GPURenderPipeline;
  /** Zero-copy variant: samples a texture_external instead of an rgba8 copy. */
  private externalPipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler;
  private uniformBuffer: GPUBuffer;
  private readonly uScratch = new Uint32Array(4);
  private lastTransferFix = -1;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  private cachedCopySource: GPUTexture | null = null;
  private cachedCopyBind: GPUBindGroup | null = null;

  constructor(
    device: GPUDevice,
    width: number,
    height: number,
    code: string,
    opts: { format?: GPUTextureFormat; filter?: GPUFilterMode } = {},
  ) {
    this.device = device;
    this.width = width;
    this.height = height;
    // rgba16float preserves 10-bit+ precision AND extended-range (>1.0) HDR floats
    // from importExternalTexture without 8-bit clamping.
    this.format = opts.format ?? 'rgba16float';
    const filter = opts.filter ?? 'linear';
    const module = device.createShaderModule({ code });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.sampler = device.createSampler({ magFilter: filter, minFilter: filter });
    this.uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.syncTransferFix(0);
    this.texture = this.createTarget(width, height);
    this.view = this.texture.createView();
  }

  private syncTransferFix(transferFix: number): void {
    const mode = transferFix >>> 0;
    if (mode === this.lastTransferFix) return;
    this.lastTransferFix = mode;
    this.uScratch[0] = mode;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uScratch);
  }

  /**
   * Install the zero-copy pipeline. Kept separate from the constructor so the
   * copy path still works if external-texture support is missing.
   */
  enableExternalPath(code: string): void {
    const module = this.device.createShaderModule({ code });
    this.externalPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  get hasExternalPath(): boolean {
    return this.externalPipeline !== null;
  }

  /**
   * Zero-copy: sample an imported video texture straight into the analysis
   * texture. Saves the full-resolution copy entirely.
   */
  runExternal(encoder: GPUCommandEncoder, external: GPUExternalTexture, transferFix = 0): void {
    if (!this.externalPipeline) throw new Error('external path not enabled');
    this.syncTransferFix(transferFix);
    const bind = this.device.createBindGroup({
      layout: this.externalPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: external },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniformBuffer } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.externalPipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  private createTarget(w: number, h: number): GPUTexture {
    return this.device.createTexture({
      size: { width: w, height: h },
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  }

  /**
   * Raw NV12 / P010 variant: samples the Y and interleaved-UV planes and packs them
   * into the analysis texture.
   */
  runRaw(encoder: GPUCommandEncoder, planes: { y: GPUTexture; uv: GPUTexture }): void {
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: planes.y.createView() },
        { binding: 1, resource: planes.uv.createView() },
        { binding: 2, resource: this.sampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
  }

  /** Draw the source texture into the analysis target. Costs one fullscreen triangle. */
  run(encoder: GPUCommandEncoder, source: GPUTexture, transferFix = 0): void {
    this.syncTransferFix(transferFix);
    if (source !== this.cachedCopySource || !this.cachedCopyBind) {
      this.cachedCopySource = source;
      this.cachedCopyBind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      });
    }
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.view,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cachedCopyBind);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.cachedCopySource = null;
    this.cachedCopyBind = null;
    this.uniformBuffer.destroy();
    this.texture.destroy();
  }
}

/**
 * Smallest source long edge that makes a preset meaningful.
 *
 * `full` follows the source, so it is always usable. Every other preset asks
 * for a fixed long edge, and asking a 720p video for a 1920 edge would only
 * upscale — the picture gains no detail and the trace just gets blurrier. The
 * UI greys those presets out instead.
 */
export function presetNeedsEdge(preset: AnalysisPreset): number {
  return preset === 'full' ? 0 : ANALYSIS_SIZES[preset];
}

/** Whether the preset can actually gain something from this source size. */
export function presetAvailable(
  preset: AnalysisPreset,
  srcW: number | undefined,
  srcH: number | undefined,
): boolean {
  const need = presetNeedsEdge(preset);
  if (need <= 0) return true;
  // Unknown source (no video attached yet) keeps everything selectable.
  if (!srcW || !srcH || srcW <= 0 || srcH <= 0) return true;
  return Math.max(srcW, srcH) >= need;
}

/** The largest preset this source can still feed, `full` excluded. */
export function largestFixedPreset(
  srcW: number | undefined,
  srcH: number | undefined,
): AnalysisPreset {
  for (let i = FIXED_PRESETS.length - 1; i >= 0; i -= 1) {
    const preset = FIXED_PRESETS[i]!;
    if (presetAvailable(preset, srcW, srcH)) return preset;
  }
  return 'low';
}
