/**
 * Detects whether a video's pixels are readable from this page, and explains
 * why not when they are not. This decision drives the HUD's notice bar, so the
 * user is told the truth instead of being given an empty scope.
 */
export type Readability =
  | { kind: 'readable' }
  | { kind: 'drm' }
  | { kind: 'cross-origin' }
  | { kind: 'unknown' };

export function videoReadability(video: HTMLVideoElement): Readability {
  // Encrypted Media Extensions content never exposes pixels to the page.
  // Note: `mediaKeys` exists on every HTMLMediaElement and is simply null when
  // no EME session is attached — checking for the property's presence would
  // flag every ordinary video as DRM.
  const keys = (video as unknown as { mediaKeys?: MediaKeys | null }).mediaKeys;
  if (keys) return { kind: 'drm' };

  try {
    // Drawing a cross-origin video without CORS taints the canvas, which is the
    // exact condition that also breaks importExternalTexture.
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { kind: 'unknown' };
    ctx.drawImage(video, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return { kind: 'readable' };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'SecurityError') return { kind: 'cross-origin' };
    return { kind: 'unknown' };
  }
}

export function readabilityNotice(r: Readability, extensionActiveInPage: boolean): string | null {
  switch (r.kind) {
    case 'readable':
      return null;
    case 'drm':
      return 'DRM-protected video: pixels are not accessible, so scopes cannot run.';
    case 'cross-origin':
      return extensionActiveInPage
        ? 'Cross-origin video without CORS: enable the network rule or use tab capture.'
        : 'Cross-origin video: its pixels are not readable from this page.';
    case 'unknown':
      return 'Could not read this video’s pixels.';
  }
}
