/**
 * Picks the "main" video on the page and follows SPA navigation.
 *
 * Heuristic:
 *  1. Videos currently visible inside the viewport strictly beat off-screen
 *     videos (e.g. Bilibili header banners or feed previews scrolled away),
 *     ensuring `renderedVideoBox` and `FalseColorOverlay` always align with the
 *     exact video being analysed by `ScopeController`.
 *  2. Primary player containers (`.bpx-player-video-wrap`, `.html5-main-video`,
 *     fullscreen video) and active playback receive a score boost.
 *  3. Videos without decoded frames (`videoWidth === 0`) are ignored until
 *     metadata arrives.
 */
function videoScore(v: HTMLVideoElement): number {
  const r = v.getBoundingClientRect();
  if (r.width <= 2 || r.height <= 2) return 0;
  const style = getComputedStyle(v);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return 0;
  }

  const rawArea = r.width * r.height;
  const win = v.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const vw = win?.innerWidth ?? 0;
  const vh = win?.innerHeight ?? 0;

  let areaScore = rawArea;
  if (vw > 0 && vh > 0) {
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const viewportArea = ix * iy;
    // In-viewport videos strictly dominate off-screen videos; off-screen videos
    // keep a tiny positive fallback only when NO video is inside the viewport.
    areaScore = viewportArea > 16 ? viewportArea : rawArea * 0.0001;
  }

  const playing = v.paused ? 0.65 : 1;
  let mainBonus = 1;
  try {
    if (
      v.ownerDocument?.fullscreenElement === v ||
      v.closest('.bpx-player-video-wrap, .bpx-player-primary-area, .html5-video-player') ||
      v.classList.contains('html5-main-video')
    ) {
      mainBonus = 1.4;
    }
  } catch {
    // Ignore selector edge cases in non-standard DOM hosts
  }
  return areaScore * playing * mainBonus;
}

export function collectVideos(root: ParentNode = document, depth = 0): HTMLVideoElement[] {
  const out = Array.from(root.querySelectorAll('video'));
  if (depth >= 5) return out;
  const all = root.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    if (el.id && el.id.startsWith('video-scopes-')) continue;
    if (el.shadowRoot) {
      const nested = collectVideos(el.shadowRoot, depth + 1);
      for (let j = 0; j < nested.length; j++) out.push(nested[j]!);
    }
  }
  return out;
}

export function pickMainVideo(root: ParentNode = document): HTMLVideoElement | null {
  const videos = collectVideos(root).filter(
    (v) => v.videoWidth > 0 && v.videoHeight > 0,
  );
  if (videos.length === 0) return null;

  let best: HTMLVideoElement | null = null;
  let bestScore = -1;
  for (const v of videos) {
    const score = videoScore(v);
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
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onChange: (v: HTMLVideoElement | null) => void) {}

  get video(): HTMLVideoElement | null {
    return this.current;
  }

  private readonly handleScroll = (): void => {
    if (this.scrollTimer !== null) return;
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      this.scan();
    }, 150);
  };

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
    window.addEventListener('scroll', this.handleScroll, { capture: true, passive: true });
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
    window.removeEventListener('scroll', this.handleScroll, true);
    if (this.scrollTimer !== null) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.rescanTimer !== undefined) clearInterval(this.rescanTimer);
    this.current = null;
  }

  private rescanTimer: ReturnType<typeof setInterval> | undefined;

  private scan = (): void => {
    if (!this.started) return;
    for (const v of collectVideos()) {
      if (v.videoWidth === 0 && !this.pendingMeta.has(v)) {
        this.pendingMeta.add(v);
        v.addEventListener(
          'loadedmetadata',
          () => {
            this.pendingMeta.delete(v);
            this.scan();
          },
          { once: true },
        );
      }
    }
    const best = pickMainVideo();
    if (best === this.current) return;

    this.current = best;
    this.onChange(best);
  };
}
