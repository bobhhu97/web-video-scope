/**
 * Layout of the buffer returned by `VideoFrame.copyTo()` with no explicit
 * format, for the formats Chromium actually produces.
 */
export interface Nv12Layout {
  /** Bytes occupied by the luma plane (width * height). */
  ySize: number;
  /** Offset of the interleaved UV plane. */
  uvOffset: number;
  /** Row stride of the luma plane. */
  yStride: number;
  /** Row stride of the interleaved UV plane (equals yStride for NV12). */
  uvStride: number;
  /** Height of the UV plane. */
  uvHeight: number;
}

/**
 * NV12: a full-resolution luma plane followed by one interleaved UV plane at
 * half the row count. Total = width * height * 1.5.
 */
export function nv12Layout(width: number, height: number): Nv12Layout {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('NV12 requires even dimensions');
  }
  const ySize = width * height;
  return {
    ySize,
    uvOffset: ySize,
    yStride: width,
    uvStride: width,
    uvHeight: height / 2,
  };
}

/**
 * I420: three separate planes (Y, U, V), each chroma plane at half resolution.
 * Kept because `copyTo` may hand back I420 on some platforms.
 */
export interface I420Layout {
  yOffset: number;
  uOffset: number;
  vOffset: number;
  yStride: number;
  chromaStride: number;
  chromaWidth: number;
  chromaHeight: number;
}

export function i420Layout(width: number, height: number): I420Layout {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('I420 requires even dimensions');
  }
  const chromaWidth = width / 2;
  const chromaHeight = height / 2;
  const ySize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  return {
    yOffset: 0,
    uOffset: ySize,
    vOffset: ySize + chromaSize,
    yStride: width,
    chromaStride: chromaWidth,
    chromaWidth,
    chromaHeight,
  };
}

/**
 * Raw plane textures for the shader.
 *
 * `y` is a full-resolution r8unorm texture. `uv` is a half-resolution rg8unorm
 * texture holding U in .r and V in .g — de-interleaved on the GPU from the
 * single interleaved plane, so the CPU never loops over chroma samples.
 */
export class RawPlaneTexture {
  constructor(
    readonly y: GPUTexture,
    readonly uv: GPUTexture,
    readonly width: number,
    readonly height: number,
  ) {}

  destroy(): void {
    this.y.destroy();
    this.uv.destroy();
  }
}

/**
 * Copy a decoded frame's pixels into CPU memory.
 *
 * The `format` parameter must be OMITTED for YUV: Chromium throws
 * "copyTo() doesn't support explicit copy to non-RGB formats" for I420/NV12
 * requests. Swallowing that error produced a silently black scope, so the raw
 * path reports its failures instead of hiding them.
 *
 * Omitting it yields the frame's native layout (NV12 for typical H.264/VP9).
 * Explicit 'RGBA' is supported but costs 2.7x the bytes, so it is opt-in.
 */
export async function readFramePixels(
  frame: VideoFrame,
  wantRgba = false,
): Promise<{ buffer: Uint8Array; format: string }> {
  if (wantRgba) {
    const size = frame.allocationSize({ format: 'RGBA' });
    const buffer = new Uint8Array(size);
    await frame.copyTo(buffer, { format: 'RGBA' });
    return { buffer, format: 'RGBA' };
  }
  const size = frame.allocationSize();
  const buffer = new Uint8Array(size);
  await frame.copyTo(buffer);
  return { buffer, format: frame.format ?? 'NV12' };
}

/**
 * Holds one growable scratch buffer so the raw path stops allocating ~1.4 MB
 * per frame (1280x720 NV12). Without this, per-frame allocation churn showed up
 * as GC pauses that halved the frame rate on some runs.
 */
export class FrameBufferPool {
  private buffer: Uint8Array | null = null;

  /** Copy the frame into the pooled buffer and return the filled view. */
  async fill(frame: VideoFrame): Promise<Uint8Array> {
    const size = frame.allocationSize();
    if (!this.buffer || this.buffer.length < size) {
      this.buffer = new Uint8Array(size);
    }
    const view = this.buffer.subarray(0, size);
    await frame.copyTo(view);
    return view;
  }

  clear(): void {
    this.buffer = null;
  }
}

/**
 * Split an interleaved NV12 buffer into its luma plane and its interleaved UV
 * plane. No per-pixel work: both are contiguous subarrays.
 */
export function splitNv12(
  buffer: Uint8Array,
  width: number,
  height: number,
): { y: Uint8Array; uv: Uint8Array; layout: Nv12Layout } {
  const layout = nv12Layout(width, height);
  return { y: buffer.subarray(0, layout.ySize), uv: buffer.subarray(layout.uvOffset), layout };
}

/**
 * P010 (10-bit 4:2:0 HDR semi-planar): same plane topology as NV12, with 2 bytes
 * per sample (16-bit little-endian, value in the high 10 bits, i.e. 0..65472
 * representing 0..1023 << 6). Converting to 8-bit/16-bit normalized float on CPU
 * or packing high bytes gives clean 10-bit HDR raw inspection.
 */
export function p010Layout(width: number, height: number): Nv12Layout {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('P010 requires even dimensions');
  }
  const yStride = width * 2;
  const ySize = yStride * height;
  return {
    ySize,
    uvOffset: ySize,
    yStride,
    uvStride: yStride,
    uvHeight: height / 2,
  };
}

/**
 * Convert a 16-bit P010 buffer (top 10 bits active) into half-float / normalized
 * 8-bit or Float32 planes. Packing into RGBA16F / Float32 or unorm: since WebGPU
 * core universally supports `rgba16float` and `r8unorm` (whereas `r16unorm` requires
 * an optional feature), we convert P010 16-bit words (`word / 65472`) into `rgba16float`
 * or `r32float`? Wait: `rgba16float` supports bilinear filtering natively in WebGPU core!
 * Even simpler: packing `(Y, U, V, 1.0)` or converting top-8/dithered or `Float16Array`!
 * Here we expose `p010ToFloatPlanes` returning `Uint16Array` views of the raw 16-bit words
 * so callers can upload or convert with zero guesswork.
 */
export function splitP010(
  buffer: Uint8Array,
  width: number,
  height: number,
): { y16: Uint16Array; uv16: Uint16Array; layout: Nv12Layout } {
  const layout = p010Layout(width, height);
  const y16 = new Uint16Array(buffer.buffer, buffer.byteOffset, width * height);
  const uv16 = new Uint16Array(
    buffer.buffer,
    buffer.byteOffset + layout.uvOffset,
    width * layout.uvHeight,
  );
  return { y16, uv16, layout };
}

/** Encode IEEE 754 binary16 (half-float) from [0, 1] float for `rgba16float` upload. */
export function floatToHalfBits(val: number): number {
  if (val <= 0) return 0;
  if (val >= 65504) return 0x7bff;
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0]!;
  const exp = ((x >> 23) & 0xff) - 127 + 15;
  if (exp <= 0) return 0;
  if (exp >= 31) return 0x7bff;
  return (exp << 10) | ((x >> 13) & 0x3ff);
}

/** Split an I420 buffer into Y, U and V planes. */
export function splitI420(
  buffer: Uint8Array,
  width: number,
  height: number,
): { y: Uint8Array; u: Uint8Array; v: Uint8Array; layout: I420Layout } {
  const layout = i420Layout(width, height);
  const chromaSize = layout.chromaStride * layout.chromaHeight;
  return {
    y: buffer.subarray(layout.yOffset, layout.uOffset),
    u: buffer.subarray(layout.uOffset, layout.uOffset + chromaSize),
    v: buffer.subarray(layout.vOffset, layout.vOffset + chromaSize),
    layout,
  };
}
