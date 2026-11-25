/**
 * Picks the "main" video on the page and follows SPA navigation.
 *
 * Heuristic: the largest visible video wins, because player UIs often keep
 * hidden preview/thumbnail videos in the DOM. Videos without decoded frames
 * (videoWidth === 0) are ignored until metadata arrives.
 */
function visibleArea(v: HTMLVideoElement): number {
  const r = v.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return 0;
  const style = getComputedStyle(v);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return 0;
  }
  return r.width * r.height;
}

export function pickMainVideo(root: ParentNode = document): HTMLVideoElement | null {
  const videos = Array.from(root.querySelectorAll('video')).filter(
    (v) => v.videoWidth > 0 && v.videoHeight > 0,
  );
  if (videos.length === 0) return null;

  let best: HTMLVideoElement | null = null;
  let bestScore = -1;
  for (const v of videos) {
    // Prefer visible, playing, larger videos.
    const area = visibleArea(v);
    const playing = v.paused ? 0.5 : 1;
    const score = area * playing;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

export class VideoDetector {
  private current: HTMLVideoElement | null = null;
  private observer: MutationObserver | null = null;
  private readonly pendingMeta = new WeakSet<HTMLVideoElement>();
  private started = false;

  constructor(private readonly onChange: (v: HTMLVideoElement | null) => void) {}

  get video(): HTMLVideoElement | null {
    return this.current;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.scan();

    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'style', 'hidden'],
    });

    document.addEventListener('fullscreenchange', this.scan);
    // A video that just got its dimensions should become eligible immediately.
    document.addEventListener('loadedmetadata', this.scan, true);
    window.addEventListener('resize', this.scan);
    this.rescanTimer = setInterval(this.scan, 2000);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener('fullscreenchange', this.scan);
    document.removeEventListener('loadedmetadata', this.scan, true);
    window.removeEventListener('resize', this.scan);
    if (this.rescanTimer !== undefined) clearInterval(this.rescanTimer);
    this.current = null;
  }

  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  private scan = (): void => {
    if (!this.started) return;
    const best = pickMainVideo();
    if (best === this.current) return;

    if (best && best.videoWidth === 0 && !this.pendingMeta.has(best)) {
      // Metadata not ready yet; retry once it is.
      this.pendingMeta.add(best);
      best.addEventListener(
        'loadedmetadata',
        () => {
          this.pendingMeta.delete(best);
          this.scan();
        },
        { once: true },
      );
    }

    this.current = best;
    this.onChange(best);
  };
}
