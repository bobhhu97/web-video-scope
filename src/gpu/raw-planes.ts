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
