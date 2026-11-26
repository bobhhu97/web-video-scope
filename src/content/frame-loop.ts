/**
 * Frame-driven scheduler with a safety net.
 *
 * Primary path: `requestVideoFrameCallback` — the video tells us when a new
 * decoded frame is presented, so we never poll and never burn GPU while paused.
 *
 * Fallback path: some videos never fire rVFC even while playing (notably
 * `captureStream`-backed sources in Chromium). A watchdog checks after
 * `fallbackAfterMs` of *active playback*; a paused video not firing rVFC is
 * expected behaviour and must NOT trigger the fallback loop (doing so left both
 * rAF and rVFC running once playback resumed).
 */
export class FrameLoop {
  private rvfcHandle = 0;
  private rafHandle = 0;
  private watchdogHandle: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastEmit = 0;
  private lastMediaTime = -1;
  private targetFps = 30;
  private usingFallback = false;
  private startedAt = 0;
  private sawCallback = false;

  private readonly onSeeked = (): void => {
    // Force an immediate sample of the newly seeked frame, even while paused.
    this.lastEmit = 0;
    this.lastMediaTime = -1;
    if (this.running && this.video.readyState >= 2) {
      this.emit(performance.now());
    }
  };

  private readonly onLoadedData = (): void => {
    if (this.running && this.lastEmit === 0 && this.video.readyState >= 2) {
      this.emit(performance.now());
    }
  };

  private readonly onPlay = (): void => {
    if (!this.running || this.sawCallback || this.usingFallback) return;
    this.armWatchdog();
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
    this.video.addEventListener('loadeddata', this.onLoadedData);
    this.video.addEventListener('play', this.onPlay);

    // Paint the current frame immediately if one is already decoded (e.g. the
    // user opened scopes while the video is paused).
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      this.lastMediaTime = this.video.currentTime;
      this.emit(performance.now());
    }

    this.scheduleRvfc();
    if (!this.video.paused && !this.video.ended) {
      this.armWatchdog();
    }
  }

  stop(): void {
    this.running = false;
    this.video.removeEventListener('seeked', this.onSeeked);
    this.video.removeEventListener('loadeddata', this.onLoadedData);
    this.video.removeEventListener('play', this.onPlay);
    if (this.watchdogHandle !== null) {
      clearTimeout(this.watchdogHandle);
      this.watchdogHandle = null;
    }
    if (this.rvfcHandle && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
    }
    this.rvfcHandle = 0;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.usingFallback = false;
  }

  private shouldEmit(now: number): boolean {
    // 0.85x tolerance avoids dropping every other frame when a 30 fps source's
    // rVFC jitter lands at 32.8 ms (< 33.33 ms), while still halving 60 -> 30.
    const minInterval = (1000 / this.targetFps) * 0.85;
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

  private scheduleRvfc(): void {
    if (typeof this.video.requestVideoFrameCallback !== 'function') {
      this.startFallback();
      return;
    }
    this.rvfcHandle = this.video.requestVideoFrameCallback((now, meta) => {
      if (!this.running) return;
      this.sawCallback = true;
      // If the fallback started before the first rVFC arrived, retire it so
      // the two loops never run concurrently.
      if (this.usingFallback) {
        this.usingFallback = false;
        if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
        this.rafHandle = 0;
      }
      if (this.watchdogHandle !== null) {
        clearTimeout(this.watchdogHandle);
        this.watchdogHandle = null;
      }
      const mediaTime = typeof meta?.mediaTime === 'number' ? meta.mediaTime : this.video.currentTime;
      const samePaused = this.video.paused && !this.video.seeking && this.lastEmit > 0 && mediaTime === this.lastMediaTime;
      this.lastMediaTime = mediaTime;
      if (!samePaused && !(this.video.paused && !this.video.seeking && this.lastEmit > 0) && this.shouldEmit(now)) {
        this.emit(now);
      }
      this.scheduleRvfc();
    });
  }

  private armWatchdog(): void {
    if (this.watchdogHandle !== null || this.sawCallback || this.usingFallback) return;
    this.watchdogHandle = setTimeout(() => {
      this.watchdogHandle = null;
      if (!this.running || this.sawCallback) return;
      // Only fall back if the video is actually playing without firing rVFC
      // (e.g. canvas.captureStream). A paused video staying silent is normal.
      if (this.video.paused || this.video.ended) return;
      this.startFallback();
    }, this.fallbackAfterMs);
  }

  private startFallback(): void {
    if (this.usingFallback || !this.running || this.sawCallback) return;
    this.usingFallback = true;
    const tick = (now: number): void => {
      if (!this.running || !this.usingFallback) return;
      this.rafHandle = requestAnimationFrame(tick);
      if (this.video.paused && !this.video.seeking) return;
      if (this.shouldEmit(now)) this.emit(now);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  /** Diagnostics: why has no frame been produced yet? */
  get idleReason(): string {
    if (!this.running) return 'stopped';
    if (this.sawCallback) return 'running(rvfc)';
    if (this.usingFallback) return 'running(raf)';
    if (this.video.paused) return 'paused';
    return `waiting for rvfc (${Math.round(performance.now() - this.startedAt)}ms)`;
  }
}
