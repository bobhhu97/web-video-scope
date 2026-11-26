import { cieViewportFrame } from '../core/color/cie-frame';
import { LUMA, type MatrixId } from '../core/color/matrices';
import { PRIMARIES, type PrimariesId } from '../core/color/primaries';
import { vectorscopeFrame } from '../core/color/vectorscope-frame';
import { axisMapping, type RangeSpec } from '../core/scale/quantize';
import { nitsToAxisForTransfer, type EffectiveTransfer, type Unit } from '../core/scale/units';
import type { CanvasGpu } from './device';
import type { AnalysisTexture } from './downscale';
import { WAVE_PAD } from '../ui/graticule';
import accumulateWgsl from './shaders/accumulate.wgsl?raw';
import resolveWgsl from './shaders/resolve.wgsl?raw';

export type ScopeMode =
  | 'waveform-luma'
  | 'waveform-rgb'
  | 'waveform-parade'
  | 'histogram'
  | 'vectorscope'
  | 'cie';

export type WaveChannelMode = 'Y' | 'RGB' | 'YRGB' | 'YUV' | 'R' | 'G' | 'B';
export type ParadeMode = 'RGB' | 'YRGB' | 'YUV';
export type HistChannelMode = 'Y' | 'RGB' | 'YRGB' | 'YUV';
export type TraceColorMode = 'channel' | 'monochrome' | 'colorize' | 'hdr-zones' | 'green';
export type ToneFilter = 'all' | 'shadows' | 'midtones' | 'highlights';

export interface ScopeOptions {
  mode: ScopeMode;
  channel: 0 | 1 | 2 | 3;
  waveChannels?: WaveChannelMode;
  paradeMode?: ParadeMode;
  histMode?: HistChannelMode;
  traceMode?: TraceColorMode;
  lowPass?: boolean;
  toneFilter?: ToneFilter;
  showSkinLine?: boolean;
  width: number;
  height: number;
  gain: number;
  gamma: number;
  zoom: number;
  panX?: number | null;
  panY?: number | null;
  units: Unit;
  range: RangeSpec;
  matrix: MatrixId;
  /** Decoder matrix used by the browser for YUV->RGB in display mode (recovers true bitstream Cb/Cr). */
  sourceMatrix?: MatrixId;
  /** Vectorscope primary target box level (0.75 for SMPTE HD, 1 for 100% EBU/full-field bars). */
  barTargets?: 0.75 | 1;
  primaries: PrimariesId;
  gamuts?: PrimariesId[];
  coord: 'xy' | 'uv';
  signalKind: 'display' | 'raw';
  sourceTransfer?: EffectiveTransfer;
  effectiveTransfer?: EffectiveTransfer;
  nitLow?: number;
  nitHigh?: number;
  graticuleBrightness?: number;
  dpr: number;
}

export const DEFAULT_SCOPE_OPTIONS: ScopeOptions = {
  mode: 'waveform-luma',
  channel: 0,
  waveChannels: 'Y',
  paradeMode: 'RGB',
  histMode: 'YRGB',
  traceMode: 'channel',
  lowPass: false,
  toneFilter: 'all',
  showSkinLine: true,
  width: 512,
  height: 256,
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  panX: null,
  panY: null,
  units: 'ire',
  range: { limited: true, depth: 8 },
  matrix: 'bt709',
  barTargets: 0.75,
  primaries: 'rec709',
  gamuts: ['rec709', 'p3'],
  coord: 'xy',
  signalKind: 'display',
  sourceTransfer: 'sdr',
  effectiveTransfer: 'sdr',
  nitLow: 100,
  nitHigh: 1000,
  dpr: 1,
};

export interface FrameStatsReadout {
  hist: Uint32Array;
  shadowPx: number;
  midPx: number;
  highPx: number;
  maxNits: number;
}

const ACC_MODE: Record<ScopeMode, number> = {
  'waveform-luma': 0,
  'waveform-rgb': 0,
  'waveform-parade': 1,
  vectorscope: 2,
  cie: 3,
  histogram: 4,
};

const RES_MODE: Record<ScopeMode, number> = {
  'waveform-luma': 0,
  'waveform-rgb': 0,
  'waveform-parade': 1,
  vectorscope: 2,
  cie: 3,
  histogram: 4,
};

/** Legacy helper preserved for unit tests; maps Waveform channel subMode. */
export function accChannel(o: ScopeOptions): number {
  if (o.mode === 'waveform-parade') {
    const pm = o.paradeMode ?? 'RGB';
    return pm === 'YRGB' ? 1 : pm === 'YUV' ? 2 : 0;
  }
  if (o.mode === 'histogram') {
    const hm = o.histMode ?? 'YRGB';
    if (hm === 'Y') return 0;
    if (hm === 'RGB') return 4;
    if (hm === 'YRGB') return 5;
    return 6;
  }
  if (o.mode === 'waveform-rgb') {
    const wc = o.waveChannels ?? 'RGB';
    if (wc === 'YRGB') return 5;
    if (wc === 'YUV') return 6;
    if (wc === 'Y') return 0;
    if (wc === 'R') return 1;
    if (wc === 'G') return 2;
    if (wc === 'B') return 3;
    return 4;
  }
  if (o.mode === 'waveform-luma') {
    const wc = o.waveChannels;
    if (wc === 'RGB') return 4;
    if (wc === 'YRGB') return 5;
    if (wc === 'YUV') return 6;
    if (wc === 'R') return 1;
    if (wc === 'G') return 2;
    if (wc === 'B') return 3;
    return o.channel;
  }
  return 0;
}

function traceModeCode(o: ScopeOptions): number {
  const tm =
    o.traceMode ??
    (o.mode === 'vectorscope' || o.mode === 'cie' ? 'colorize' : 'channel');
  switch (tm) {
    case 'monochrome':
      return 1;
    case 'colorize':
      return 2;
    case 'hdr-zones':
      return 3;
    case 'green':
      return 4;
    default:
      return 0;
  }
}

function transferCode(t: EffectiveTransfer | undefined): number {
  if (t === 'pq') return 1;
  if (t === 'hlg') return 2;
  return 0;
}

function toneFilterCode(t: ToneFilter | undefined): number {
  if (t === 'shadows') return 1;
  if (t === 'midtones') return 2;
  if (t === 'highlights') return 3;
  return 0;
}

function planesForOptions(o: ScopeOptions): number {
  if (o.mode === 'histogram') return 4;
  const tm = traceModeCode(o);
  if (o.mode === 'vectorscope' || o.mode === 'cie') {
    return tm === 3 ? 4 : 1;
  }
  if (o.mode === 'waveform-parade') {
    return tm === 2 ? 4 : 1;
  }
  // Waveform
  if (tm === 2) return 4;
  const sub = accChannel(o);
  if (sub === 5) return 4;
  if (sub === 4 || sub === 6) return 3;
  return 1;
}

const PARAMS_SIZE = 176; // 11 x vec4
const RESOLVE_SIZE = 128; // 8 x vec4
const HIST_WORDS = 260;
const HIST_BYTES = HIST_WORDS * 4;

interface SharedPipelines {
  acc: GPUComputePipeline;
  resByFormat: Map<GPUTextureFormat, GPURenderPipeline>;
  resModule: GPUShaderModule;
}

const pipelineCache = new WeakMap<GPUDevice, SharedPipelines>();

function getPipelines(device: GPUDevice, format: GPUTextureFormat): {
  acc: GPUComputePipeline;
  res: GPURenderPipeline;
} {
  let entry = pipelineCache.get(device);
  if (!entry) {
    const acc = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: accumulateWgsl }),
        entryPoint: 'main',
      },
    });
    const resModule = device.createShaderModule({ code: resolveWgsl });
    entry = { acc, resByFormat: new Map(), resModule };
    pipelineCache.set(device, entry);
  }
  let res = entry.resByFormat.get(format);
  if (!res) {
    res = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: entry.resModule, entryPoint: 'vs' },
      fragment: { module: entry.resModule, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    entry.resByFormat.set(format, res);
  }
  return { acc: entry.acc, res };
}

export class ScopeRenderer {
  readonly options: ScopeOptions;
  private readonly accumulatePipeline: GPUComputePipeline;
  private readonly resolvePipeline: GPURenderPipeline;
  private densityBuffer: GPUBuffer;
  private densityByteSize = 0;
  private readonly paramsBuffer: GPUBuffer;
  private readonly resolveBuffer: GPUBuffer;
  private readonly histBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private readonly paramsScratch = new ArrayBuffer(PARAMS_SIZE);
  private readonly paramsU32 = new Uint32Array(this.paramsScratch);
  private readonly paramsF32 = new Float32Array(this.paramsScratch);
  private readonly resolveScratch = new ArrayBuffer(RESOLVE_SIZE);
  private readonly resolveU32 = new Uint32Array(this.resolveScratch);
  private readonly resolveF32 = new Float32Array(this.resolveScratch);
  private cachedAnalysisView: GPUTextureView | null = null;
  private cachedAccBind: GPUBindGroup | null = null;
  private cachedResBind: GPUBindGroup | null = null;
  private histPending = false;
  private destroyed = false;

  constructor(
    private readonly gpu: CanvasGpu,
    options: ScopeOptions,
  ) {
    this.options = { ...options };
    const { device, format } = gpu;
    const shared = getPipelines(device, format);
    this.accumulatePipeline = shared.acc;
    this.resolvePipeline = shared.res;
    this.densityBuffer = this.createDensity();
    this.paramsBuffer = device.createBuffer({
      size: PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.resolveBuffer = device.createBuffer({
      size: RESOLVE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histBuffer = device.createBuffer({
      size: HIST_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.readbackBuffer = device.createBuffer({
      size: HIST_BYTES,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  /**
   * Plot rectangle in DEVICE pixels.
   * Vectorscope and CIE occupy the full canvas (matching `vectorscopeFrame` and
   * `cieFrame`), while Waveform, Parade, and Histogram reserve `WAVE_PAD`.
   */
  private plotRect(): { padL: number; padT: number; w: number; h: number } {
    const o = this.options;
    if (o.mode === 'vectorscope' || o.mode === 'cie') {
      return {
        padL: 0,
        padT: 0,
        w: Math.max(8, o.width),
        h: Math.max(8, o.height),
      };
    }
    const dpr = o.dpr;
    const padL = Math.round(WAVE_PAD.left * dpr);
    const padR = Math.round(WAVE_PAD.right * dpr);
    const padT = Math.round(WAVE_PAD.top * dpr);
    const padB = Math.round(WAVE_PAD.bottom * dpr);
    const w = Math.max(8, o.width - padL - padR);
    const h = Math.max(8, o.height - padT - padB);
    return { padL, padT, w, h };
  }

  private requiredDensityBytes(): number {
    const planes = planesForOptions(this.options);
    const { w, h } = this.plotRect();
    if (this.options.mode === 'histogram') {
      return Math.max(256, planes * w * 4);
    }
    return Math.max(256, planes * w * h * 4);
  }

  private createDensity(): GPUBuffer {
    const size = this.requiredDensityBytes();
    this.densityByteSize = size;
    this.cachedAccBind = null;
    this.cachedResBind = null;
    return this.gpu.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  private ensureDensityCapacity(): void {
    const needed = this.requiredDensityBytes();
    if (needed !== this.densityByteSize) {
      this.densityBuffer.destroy();
      this.densityBuffer = this.createDensity();
    }
  }

  /** The axis mapping actually uploaded to the shader on the next submit. */
  get axisMap(): { black: number; span: number } {
    return axisMapping(this.options.range);
  }

  resize(width: number, height: number, dpr = this.options.dpr): void {
    if (
      width === this.options.width &&
      height === this.options.height &&
      dpr === this.options.dpr
    ) {
      return;
    }
    this.options.width = width;
    this.options.height = height;
    this.options.dpr = dpr;
    this.ensureDensityCapacity();
  }

  setOptions(partial: Partial<ScopeOptions>): void {
    const { width: _w, height: _h, dpr: _dpr, ...rest } = partial;
    Object.assign(this.options, rest);
    this.ensureDensityCapacity();
  }

  /**
   * Encode this cell's clear, compute, and resolve passes onto a shared
   * `GPUCommandEncoder` so all visible scopes execute in a single submission.
   */
  encode(encoder: GPUCommandEncoder, analysis: AnalysisTexture, recordStats = true): void {
    if (this.destroyed) return;
    const { device, context } = this.gpu;
    const o = this.options;
    const c = LUMA[o.matrix];
    const sc = LUMA[o.sourceMatrix ?? o.matrix];
    const m = PRIMARIES[o.primaries].rgbToXyz;
    const map = axisMapping(o.range);
    const plot = this.plotRect();

    const accMode = ACC_MODE[o.mode];
    const subMode = accChannel(o);
    const traceMode = traceModeCode(o);
    const srcTr = transferCode(o.sourceTransfer);
    const effTr = transferCode(o.effectiveTransfer);
    const toneCode = toneFilterCode(o.toneFilter);
    const flags =
      (o.signalKind === 'raw' ? 1 : 0) |
      (o.coord === 'uv' ? 2 : 0) |
      (o.lowPass ? 4 : 0) |
      (srcTr << 3) |
      (effTr << 5) |
      (toneCode << 7) |
      (recordStats ? 512 : 0);

    const zoom = Math.max(1, Math.min(16, o.zoom || 1));
    const maxNormPan = Math.max(0, 1 - 1 / zoom);
    const normPanX = Math.min(maxNormPan, Math.max(0, o.panX ?? 0));
    const normPanY = Math.min(maxNormPan, Math.max(0, o.panY ?? 0));
    const nitLow = Math.max(0.01, o.nitLow ?? 100);
    const nitHigh = Math.max(nitLow + 1, o.nitHigh ?? 1000);

    let frameAx = 0;
    let frameAy = 0;
    let frameAz = 0;
    let frameAw = 0;
    let frameBx = 0;
    let frameBy = 0;
    let frameBz = 0;

    if (o.mode === 'vectorscope') {
      const vf = vectorscopeFrame(plot.w, plot.h, zoom, o.panX ?? 0, o.panY ?? 0);
      frameAx = vf.cx;
      frameAy = vf.cy;
      frameAz = vf.discCx;
      frameAw = vf.discCy;
      frameBx = vf.radius;
      frameBy = vf.scale;
    } else if (o.mode === 'cie') {
      // panX/panY in CIE are in chromaticity units (scale-invariant across DPR)
      const cfExact = cieViewportFrame(plot.w, plot.h, o.coord, zoom, o.panX, o.panY, o.dpr);
      frameAx = cfExact.left;
      frameAy = cfExact.top;
      frameAz = cfExact.width;
      frameAw = cfExact.height;
      frameBx = cfExact.x0;
      frameBy = cfExact.y0;
      frameBz = cfExact.scale;
    }

    let densW = plot.w;
    if (o.mode === 'waveform-luma' || o.mode === 'waveform-rgb') {
      const visSrcCols = Math.max(8, Math.ceil(analysis.width / zoom));
      densW = Math.min(plot.w, visSrcCols);
    } else if (o.mode === 'waveform-parade') {
      const numSlices = subMode === 1 ? 4 : 3;
      const screenSliceW = Math.max(1, Math.floor(plot.w / numSlices));
      const visSrcCols = Math.max(8, Math.ceil(analysis.width / zoom));
      densW = Math.min(screenSliceW, visSrcCols) * numSlices;
    }

    const u32 = this.paramsU32;
    const f32 = this.paramsF32;
    u32.set([analysis.width, analysis.height, densW, plot.h], 0);
    u32.set([accMode, subMode, traceMode, flags], 4);
    f32.set([c.kr, c.kg, c.kb, zoom], 8);
    f32.set([sc.kr, sc.kg, sc.kb, 0], 12);
    f32.set([m[0]![0], m[0]![1], m[0]![2], 0], 16);
    f32.set([m[1]![0], m[1]![1], m[1]![2], 0], 20);
    f32.set([m[2]![0], m[2]![1], m[2]![2], 0], 24);
    f32.set([map.black, map.span, o.gain, o.gamma], 28);
    f32.set([normPanX, normPanY, nitLow, nitHigh], 32);
    f32.set([frameAx, frameAy, frameAz, frameAw], 36);
    f32.set([frameBx, frameBy, frameBz, densW], 40);
    device.queue.writeBuffer(this.paramsBuffer, 0, this.paramsScratch);

    const effTransfer = o.effectiveTransfer ?? 'sdr';
    const axisNitLow = nitsToAxisForTransfer(nitLow, effTransfer, o.range);
    const axisNitHigh = nitsToAxisForTransfer(nitHigh, effTransfer, o.range);

    const ru = this.resolveU32;
    const rf = this.resolveF32;
    ru.set([o.width, o.height, planesForOptions(o), RES_MODE[o.mode]], 0);
    ru.set([plot.padL, plot.padT, plot.w, plot.h], 4);
    ru.set([subMode, traceMode, effTr, o.coord === 'uv' ? 1 : 0], 8);
    rf.set([o.gain, o.gamma, zoom, analysis.width * analysis.height], 12);
    rf.set([c.kr, c.kg, c.kb, map.black], 16);
    rf.set([normPanX, normPanY, axisNitLow, axisNitHigh], 20);
    rf.set([frameAx, frameAy, frameAz, frameAw], 24);
    rf.set([frameBx, frameBy, frameBz, densW], 28);
    device.queue.writeBuffer(this.resolveBuffer, 0, this.resolveScratch);

    const analysisView = analysis.view ?? analysis.texture.createView();
    if (analysisView !== this.cachedAnalysisView || !this.cachedAccBind) {
      this.cachedAnalysisView = analysisView;
      this.cachedAccBind = device.createBindGroup({
        layout: this.accumulatePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: analysisView },
          { binding: 1, resource: { buffer: this.densityBuffer } },
          { binding: 2, resource: { buffer: this.histBuffer } },
          { binding: 3, resource: { buffer: this.paramsBuffer } },
        ],
      });
    }
    if (!this.cachedResBind) {
      this.cachedResBind = device.createBindGroup({
        layout: this.resolvePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.densityBuffer } },
          { binding: 1, resource: { buffer: this.resolveBuffer } },
        ],
      });
    }

    encoder.clearBuffer(this.densityBuffer);
    if (recordStats) encoder.clearBuffer(this.histBuffer);

    const compute = encoder.beginComputePass();
    compute.setPipeline(this.accumulatePipeline);
    compute.setBindGroup(0, this.cachedAccBind);
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
    render.setBindGroup(0, this.cachedResBind);
    render.draw(3);
    render.end();
  }

  /** Standalone submit wrapper for single-renderer callers and tests. */
  submit(analysis: AnalysisTexture): void {
    if (this.destroyed) return;
    const encoder = this.gpu.device.createCommandEncoder();
    this.encode(encoder, analysis, true);
    this.gpu.device.queue.submit([encoder.finish()]);
  }

  async readStats(): Promise<FrameStatsReadout | null> {
    if (this.destroyed || this.histPending) return null;
    const { device } = this.gpu;
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.histBuffer, 0, this.readbackBuffer, 0, HIST_BYTES);
    this.histPending = true;
    device.queue.submit([encoder.finish()]);
    try {
      await this.readbackBuffer.mapAsync(GPUMapMode.READ);
      const all = new Uint32Array(this.readbackBuffer.getMappedRange().slice(0));
      this.readbackBuffer.unmap();
      return {
        hist: all.subarray(0, 256),
        shadowPx: all[256] ?? 0,
        midPx: all[257] ?? 0,
        highPx: all[258] ?? 0,
        maxNits: (all[259] ?? 0) / 10,
      };
    } finally {
      this.histPending = false;
    }
  }

  async readHistogram(): Promise<Uint32Array | null> {
    const s = await this.readStats();
    return s ? s.hist : null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cachedAccBind = null;
    this.cachedResBind = null;
    this.cachedAnalysisView = null;
    this.densityBuffer.destroy();
    this.paramsBuffer.destroy();
    this.resolveBuffer.destroy();
    this.histBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
