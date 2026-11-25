/**
 * Reads the analysis texture back to the CPU for the scatter scopes.
 *
 * Why the CPU draws vectorscope and CIE: they are 2D histograms, and a histogram
 * of a 230k-pixel frame is a cheap CPU loop. The GPU version needed an atomic
 * pass, a resolve pass and a correctly-sized density buffer per panel, and a
 * mismatch between those produced a silently empty plot that took several rounds
 * to isolate. The CPU path is also what allows smooth graticules — the spectral
 * locus and the vectorscope circle need real curves, not the straight chords a
 * fragment shader is limited to.
 *
 * Cost control: the readback is the expensive part (1.5 MB for a 843x474 frame),
 * so it runs on its own timer, slower than the waveform pass, and only while a
 * scatter panel is on screen.
 */
import type { AnalysisTexture } from './downscale';

interface Reader {
  buffer: GPUBuffer;
  readback: GPUBuffer;
  bytesPerRow: number;
  width: number;
  height: number;
}

export class AnalysisReader {
  private reader: Reader | null = null;
  private pending = false;
  private lastPixels: Uint8Array | null = null;

  constructor(private readonly device: GPUDevice) {}

  /** True when a readback is already in flight; skip this tick. */
  get busy(): boolean {
    return this.pending;
  }

  /** Last frame read back, or null before the first read completes. */
  get pixels(): Uint8Array | null {
    return this.lastPixels;
  }

  private ensure(tex: AnalysisTexture): Reader {
    const bytesPerRow = Math.ceil((tex.width * 4) / 256) * 256;
    if (this.reader && this.reader.width === tex.width && this.reader.height === tex.height) {
      return this.reader;
    }
    this.reader?.buffer.destroy();
    this.reader?.readback.destroy();
    this.reader = {
      width: tex.width,
      height: tex.height,
      bytesPerRow,
      buffer: this.device.createBuffer({
        size: bytesPerRow * tex.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      }),
      readback: this.device.createBuffer({
        size: bytesPerRow * tex.height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
    };
    return this.reader;
  }

  /**
   * Copy the analysis texture to the CPU.
   *
   * Returns the previous frame's pixels immediately (so the caller can render
   * without waiting) and schedules the next read. A readback that is still in
   * flight is never queued twice.
   */
  async read(tex: AnalysisTexture): Promise<Uint8Array | null> {
    const r = this.ensure(tex);
    if (this.pending) return this.lastPixels;

    this.pending = true;
    try {
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex.texture },
        { buffer: r.buffer, bytesPerRow: r.bytesPerRow, rowsPerImage: r.height },
        { width: r.width, height: r.height },
      );
      enc.copyBufferToBuffer(r.buffer, 0, r.readback, 0, r.bytesPerRow * r.height);
      this.device.queue.submit([enc.finish()]);

      await r.readback.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(r.readback.getMappedRange());
      const pixels = new Uint8Array(src.length);
      pixels.set(src);
      r.readback.unmap();
      this.lastPixels = pixels;
      return pixels;
    } catch {
      return this.lastPixels;
    } finally {
      this.pending = false;
    }
  }

  destroy(): void {
    this.reader?.buffer.destroy();
    this.reader?.readback.destroy();
    this.reader = null;
    this.lastPixels = null;
  }
}

/**
 * Convert a padded readback buffer into a tightly packed RGBA array.
 * `copyTextureToBuffer` requires 256-byte row alignment, so the raw buffer has
 * padding at the end of each row that the pixel maths must not see.
 */
export function unpackRows(padded: Uint8Array, width: number, height: number): Uint8Array {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  if (bytesPerRow === width * 4) return padded;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  }
  return out;
}
