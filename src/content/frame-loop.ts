/**
 * Frame-driven scheduler with a safety net.
 *
 * Primary path: `requestVideoFrameCallback` — the video tells us when a new
 * frame is available, so we never poll and never burn GPU while paused.
 *
 * Fallback path: some videos never fire rVFC (notably `captureStream`-backed
 * sources in Chromium, and certain remote-playback pipelines). If no callback
 * arrives within `fallbackAfterMs` of starting, we switch to a rAF loop gated
 * on `currentTime` changing. Both paths respect the same fps cap and the same
 * "only analyse when the timestamp moved" rule, so cost stays bounded.
 */
export class FrameLoop {
  private rvfcHandle = 0;
  private rafHandle = 0;
  private running = false;
  private lastEmit = 0;
  private lastMediaTime = -1;
  private targetFps = 30;
  private usingFallback = false;
  private startedAt = 0;
  private sawCallback = false;

  private readonly onSeeked = (): void => {
    // Force the next frame through even if the fps gate would skip it.
    this.lastEmit = 0;
    this.lastMediaTime = -1;
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: () => void,
    private readonly fallbackAfterMs = 700,
  ) {}

  /** Which path is currently driving the loop; surfaced for diagnostics. */
  get mode(): 'rvfc' | 'raf' {
    return this.usingFallback ? 'raf' : 'rvfc';
  }

  setTargetFps(fps: number): void {
    this.targetFps = Math.max(1, Math.min(120, fps));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.now();
    this.video.addEventListener('seeked', this.onSeeked);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.video.removeEventListener('seeked', this.onSeeked);
    if (this.rvfcHandle && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = 0;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  private shouldEmit(now: number): boolean {
    const minInterval = 1000 / this.targetFps;
    if (this.lastEmit === 0) return true;
    return now - this.lastEmit >= minInterval;
  }

  private emit(now: number): void {
    this.lastEmit = now;
    try {
      this.onFrame();
    } catch {
      // A single bad frame must not kill the loop.
    }
  }

  private schedule(): void {
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = this.video.requestVideoFrameCallback((now) => {
        if (!this.running) return;
        this.sawCallback = true;
        if (this.shouldEmit(now)) this.emit(now);
        this.schedule();
      });
    }
    // Watchdog: if rVFC never fires, fall back to rAF + currentTime polling.
    setTimeout(() => {
      if (!this.running || this.sawCallback) return;
      this.startFallback();
    }, this.fallbackAfterMs);
  }

  private startFallback(): void {
    if (this.usingFallback || !this.running) return;
    this.usingFallback = true;
    const tick = (now: number): void => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(tick);
      const t = this.video.currentTime;
      // Only analyse when the frame timestamp actually moved.
      if (t === this.lastMediaTime) return;
      this.lastMediaTime = t;
      if (this.shouldEmit(now)) this.emit(now);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Diagnostics: why has no frame been produced yet? */
  get idleReason(): string {
    if (!this.running) return 'stopped';
    if (this.sawCallback) return 'running(rvfc)';
    if (this.usingFallback) return 'running(raf)';
    return `waiting for rvfc (${Math.round(performance.now() - this.startedAt)}ms)`;
  }
}
