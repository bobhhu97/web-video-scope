export type AnalysisPreset = 'low' | 'default' | 'high';

/**
 * Long-edge pixel count per preset. Defining the long edge (not the height)
 * means portrait and landscape share one knob and the aspect ratio never
 * distorts. 640 long edge on 16:9 gives exactly 640x360.
 */
export const ANALYSIS_SIZES: Record<AnalysisPreset, number> = {
  low: 320,
  default: 640,
  high: 854,
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
  maxPixels = 400_000,
): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: MIN_DIM, height: MIN_DIM };
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
  readonly width: number;
  readonly height: number;
}

export class Downscaler implements AnalysisTexture {
  readonly device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;

  constructor(device: GPUDevice, width: number, height: number, code: string) {
    this.device = device;
    this.width = width;
    this.height = height;
    const module = device.createShaderModule({ code });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    // Linear filtering does the bilinear averaging; `nearest` would degrade
    // this back into point sampling and reintroduce aliasing.
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.texture = this.createTarget(width, height);
  }

  private createTarget(w: number, h: number): GPUTexture {
    return this.device.createTexture({
      size: { width: w, height: h },
      format: 'rgba8unorm',
      // COPY_SRC lets tests read the analysis texture back when diagnosing.
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });
  }

  /** Draw the source texture into the analysis target. Costs one fullscreen triangle. */
  run(encoder: GPUCommandEncoder, source: GPUTexture): void {
    const bind = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.sampler },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.texture.createView(),
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

  destroy(): void {
    this.texture.destroy();
  }
}
