/**
 * Measures how long the GPU actually takes for the work we submitted.
 *
 * `onSubmittedWorkDone` resolves when everything queued so far has finished,
 * which includes our compute passes plus whatever the compositor queued. That
 * makes it an *upper bound* rather than an exact GPU time — which is the right
 * bias for a governor: step down early rather than drop frames on the user's
 * video.
 *
 * Returns null while a measurement is in flight so the caller simply skips that
 * frame instead of stacking promises.
 */
export class GpuTimer {
  private inFlight = false;
  private last: number | null = null;

  async sample(device: GPUDevice): Promise<number | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    const start = performance.now();
    try {
      await device.queue.onSubmittedWorkDone();
      this.last = performance.now() - start;
      return this.last;
    } catch {
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  get lastMs(): number | null {
    return this.last;
  }
}
