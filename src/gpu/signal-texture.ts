type Source = HTMLVideoElement | VideoFrame;

const FRAME_EPSILON = 1e-4;

/**
 * True when the current video frame has not been uploaded yet.
 * A video element reports readyState < 2 until it has decodable data.
 */
export function shouldUpload(
  readyState: number,
  currentTime: number,
  lastKey: number,
  minDelta = FRAME_EPSILON,
): boolean {
  if (readyState < 2) return false;
  if (lastKey < 0) return true;
  return Math.abs(currentTime - lastKey) >= minDelta;
}

export class SignalTexture {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  private readonly device: GPUDevice;
  private lastFrameKey = -1;
  private closed = false;

  constructor(device: GPUDevice, private readonly source: Source) {
    this.device = device;
    this.width = source instanceof HTMLVideoElement ? source.videoWidth : source.displayWidth;
    this.height = source instanceof HTMLVideoElement ? source.videoHeight : source.displayHeight;
    if (this.width === 0 || this.height === 0) throw new Error('source has no dimensions');
    // RENDER_ATTACHMENT is required by Dawn/Chrome for copyExternalImageToTexture's
    // destination even though the spec only demands COPY_DST.
    // rgba16float preserves 10-bit+ precision and extended-range (>1.0, >203 nits) HDR floats.
    this.texture = device.createTexture({
      size: { width: this.width, height: this.height },
      format: 'rgba16float',
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  update(mediaTime?: number): boolean {
    if (this.closed) return false;
    if (this.source instanceof HTMLVideoElement) {
      const t = mediaTime ?? this.source.currentTime;
      if (!shouldUpload(this.source.readyState, t, this.lastFrameKey)) return false;
      this.lastFrameKey = t;
    }
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.source, flipY: false },
        { texture: this.texture },
        { width: this.width, height: this.height },
      );
    } catch {
      return false;
    }
    return true;
  }

  /** VideoFrame sources must be closed by the caller; this only frees the texture. */
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.texture.destroy();
  }
}
