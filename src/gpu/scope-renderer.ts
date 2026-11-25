import { LUMA, type MatrixId } from '../core/color/matrices';
import { PRIMARIES, type PrimariesId } from '../core/color/primaries';
import { axisMapping, type RangeSpec } from '../core/scale/quantize';
import type { Unit } from '../core/scale/units';
import type { CanvasGpu } from './device';
import type { AnalysisTexture } from './downscale';
import { WAVE_PAD } from '../ui/graticule';
import accumulateWgsl from './shaders/accumulate.wgsl?raw';
import resolveWgsl from './shaders/resolve.wgsl?raw';

export type ScopeMode = 'waveform-luma' | 'waveform-rgb' | 'waveform-parade' | 'vectorscope' | 'cie';

export interface ScopeOptions {
  mode: ScopeMode;
  channel: 0 | 1 | 2 | 3;
  width: number;
  height: number;
  gain: number;
  gamma: number;
  zoom: number;
  units: Unit;
  range: RangeSpec;
  matrix: MatrixId;
  primaries: PrimariesId;
  coord: 'xy' | 'uv';
  signalKind: 'display' | 'raw';
}

export const DEFAULT_SCOPE_OPTIONS: ScopeOptions = {
  mode: 'waveform-luma',
  channel: 0,
  width: 512,
  height: 256,
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  units: 'ire',
  range: { limited: true, depth: 8 },
  matrix: 'bt709',
  primaries: 'rec709',
  coord: 'xy',
  signalKind: 'display',
};

/** accumulate.wgsl `accMode` */
const ACC_MODE: Record<ScopeMode, number> = {
  'waveform-luma': 0,
  'waveform-rgb': 0,
  'waveform-parade': 0,
  vectorscope: 2,
  cie: 3,
};

/** resolve.wgsl `resMode` */
const RES_MODE: Record<ScopeMode, number> = {
  'waveform-luma': 0,
  'waveform-parade': 1,
  'waveform-rgb': 2,
  vectorscope: 3,
  cie: 4,
};

const PLANES: Record<ScopeMode, number> = {
  'waveform-luma': 1,
  'waveform-rgb': 3,
  'waveform-parade': 3,
  vectorscope: 1,
  cie: 1,
};

/** accumulate.wgsl `channel`: 4 means "write R, G and B planes in one pass". */
export function accChannel(o: ScopeOptions): number {
  if (o.mode === 'waveform-rgb' || o.mode === 'waveform-parade') return 4;
  if (o.mode === 'waveform-luma') return o.channel;
  return 0;
}

const PARAMS_SIZE = 128;
// ResolveParams is now 5 x vec4 = 80 bytes (size, plot, opts, tint, coeff).
const RESOLVE_SIZE = 80;

export class ScopeRenderer {
  readonly options: ScopeOptions;
  private readonly accumulatePipeline: GPUComputePipeline;
  private readonly resolvePipeline: GPURenderPipeline;
  private densityBuffer: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private readonly resolveBuffer: GPUBuffer;
  private readonly histBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private histPending = false;
  private destroyed = false;

  constructor(
    private readonly gpu: CanvasGpu,
    options: ScopeOptions,
  ) {
    this.options = { ...options };
    const { device } = gpu;
    this.accumulatePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: accumulateWgsl }),
        entryPoint: 'main',
      },
    });
    const resolveModule = device.createShaderModule({ code: resolveWgsl });
    this.resolvePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: resolveModule, entryPoint: 'vs' },
      fragment: { module: resolveModule, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.densityBuffer = this.createDensity();
    this.paramsBuffer = device.createBuffer({
      size: PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.resolveBuffer = device.createBuffer({
      size: RESOLVE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // COPY_DST is required because clearBuffer() is used on it every frame.
    this.histBuffer = device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.readbackBuffer = device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * The density grid covers only the *plot* rectangle (canvas minus the
   * graticule padding), so a value at 75 IRE lands exactly on the drawn 75 IRE
   * gridline instead of being stretched over the full canvas height.
   */
  private plotSize(): { w: number; h: number } {
    const w = Math.max(8, Math.round(this.options.width - WAVE_PAD.left - WAVE_PAD.right));
    const h = Math.max(8, Math.round(this.options.height - WAVE_PAD.top - WAVE_PAD.bottom));
    return { w, h };
  }

  private createDensity(): GPUBuffer {
    const planes = PLANES[this.options.mode];
    const { w, h } = this.plotSize();
    return this.gpu.device.createBuffer({
      size: planes * w * h * 4,
      // COPY_DST because clearBuffer() validates against it.
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  resize(width: number, height: number): void {
    if (width === this.options.width && height === this.options.height) return;
    this.options.width = width;
    this.options.height = height;
    this.densityBuffer.destroy();
    this.densityBuffer = this.createDensity();
  }

  setOptions(partial: Partial<ScopeOptions>): void {
    const prev = { ...this.options };
    Object.assign(this.options, partial);
    const needsRealloc =
      PLANES[prev.mode] !== PLANES[this.options.mode] ||
      prev.width !== this.options.width ||
      prev.height !== this.options.height;
    if (needsRealloc) {
      this.densityBuffer.destroy();
      this.densityBuffer = this.createDensity();
    }
  }

  async render(analysis: AnalysisTexture, readStats = false): Promise<Uint32Array | null> {
    if (this.destroyed) return null;
    const { device, context } = this.gpu;
    const o = this.options;
    const c = LUMA[o.matrix];
    const m = PRIMARIES[o.primaries].rgbToXyz;
    const map = axisMapping(o.range);

    const params = new ArrayBuffer(PARAMS_SIZE);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    // Every scope reads the same downscaled analysis texture, so the dispatch
    // cost is independent of the source resolution.
    const plot = this.plotSize();
    u32.set([analysis.width, analysis.height, plot.w, plot.h], 0);
    u32.set([ACC_MODE[o.mode], accChannel(o), o.coord === 'uv' ? 1 : 0, o.signalKind === 'raw' ? 1 : 0], 4);
    f32.set([c.kr, c.kg, c.kb, o.zoom], 8);
    f32.set([m[0]![0], m[0]![1], m[0]![2], 0], 12);
    f32.set([m[1]![0], m[1]![1], m[1]![2], 0], 16);
    f32.set([m[2]![0], m[2]![1], m[2]![2], 0], 20);
    f32.set([map.black, map.span, o.gain, o.gamma], 24);
    device.queue.writeBuffer(this.paramsBuffer, 0, params);

    const rp = new ArrayBuffer(RESOLVE_SIZE);
    const ru = new Uint32Array(rp);
    const rf = new Float32Array(rp);
    // Resolve needs canvas dims plus the plot rect so it can place the density
    // grid at the right offset. Field order must match ResolveParams exactly.
    ru.set([o.width, o.height, PLANES[o.mode], RES_MODE[o.mode]], 0); // size
    ru.set([WAVE_PAD.left, WAVE_PAD.top, plot.w, plot.h], 4); // plot
    rf.set([o.gain, o.gamma, o.zoom, o.coord === 'uv' ? 1 : 0], 8); // opts
    rf.set([0.45, 1.0, 0.6, 0], 12); // tint
    rf.set([c.kr, c.kg, c.kb, 0], 16); // coeff
    device.queue.writeBuffer(this.resolveBuffer, 0, rp);

    const accBind = device.createBindGroup({
      layout: this.accumulatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: analysis.texture.createView() },
        { binding: 1, resource: { buffer: this.densityBuffer } },
        { binding: 2, resource: { buffer: this.histBuffer } },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
      ],
    });
    const resBind = device.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.densityBuffer } },
        { binding: 1, resource: { buffer: this.resolveBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(this.densityBuffer);
    encoder.clearBuffer(this.histBuffer);

    const compute = encoder.beginComputePass();
    compute.setPipeline(this.accumulatePipeline);
    compute.setBindGroup(0, accBind);
    compute.dispatchWorkgroups(Math.ceil(analysis.width / 8), Math.ceil(analysis.height / 8));
    compute.end();

    const render = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    render.setPipeline(this.resolvePipeline);
    render.setBindGroup(0, resBind);
    render.draw(3);
    render.end();

    const wantStats = readStats && !this.histPending;
    if (wantStats) {
      encoder.copyBufferToBuffer(this.histBuffer, 0, this.readbackBuffer, 0, 1024);
      this.histPending = true;
    }
    device.queue.submit([encoder.finish()]);

    if (!wantStats) return null;
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const hist = new Uint32Array(this.readbackBuffer.getMappedRange().slice(0));
    this.readbackBuffer.unmap();
    this.histPending = false;
    return hist;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.densityBuffer.destroy();
    this.paramsBuffer.destroy();
    this.resolveBuffer.destroy();
    this.histBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
