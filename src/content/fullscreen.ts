/**
 * Fullscreen & video content-box geometry helpers shared across:
 *  - Main Scopes HUD (`#video-scopes-host`)
 *  - Live Video False Color Overlay (`#video-scopes-false-color`)
 *  - Eyedropper Cursor Readout Tooltip (`#video-scopes-cursor-probe`)
 */

/**
 * Preferred DOM parent for fixed overlays.
 * - Normal mode: `document.documentElement`
 * - Player wrapper fullscreen (`div.html5-video-player`, etc.): `document.fullscreenElement`
 * - Native `<video>` fullscreen: `<video>` is a replaced element and CANNOT render
 *   child elements, so we keep the overlay on `document.documentElement` and promote
 *   it into the browser's Top Layer via `popover="manual"`.
 */
export function overlayFullscreenParent(doc: Document = document): Element {
  const fs = doc?.fullscreenElement;
  if (fs && fs.tagName.toUpperCase() !== 'VIDEO') {
    return fs;
  }
  return doc.documentElement;
}

export function isPopoverOpen(host: HTMLElement): boolean {
  try {
    return host.matches(':popover-open');
  } catch {
    return false;
  }
}

function setImportant(host: HTMLElement, prop: string, val: string): void {
  host.style.setProperty(prop, val, 'important');
}

export function syncTopLayerForVideoFullscreen(host: HTMLElement, forceRestack = false): void {
  const doc = host.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const fs = doc.fullscreenElement;
  const isNativeVideoFs = !!fs && fs.tagName.toUpperCase() === 'VIDEO';
  const anyHost = host as HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  };

  if (isNativeVideoFs && typeof anyHost.showPopover === 'function') {
    if (host.getAttribute('popover') !== 'manual') {
      host.setAttribute('popover', 'manual');
      // Reset user-agent [popover] centering/border defaults once without clobbering left/top!
      setImportant(host, 'margin', '0');
      setImportant(host, 'padding', '0');
      setImportant(host, 'border', '0');
      setImportant(host, 'background', 'transparent');
    }
    if (forceRestack || !isPopoverOpen(host)) {
      // Re-show after fullscreen entry so this popover sits ABOVE the :fullscreen <video> in Top Layer
      try {
        anyHost.hidePopover?.();
      } catch {
        // Not open yet
      }
      try {
        anyHost.showPopover();
      } catch {
        host.removeAttribute('popover');
        return;
      }
      if (!isPopoverOpen(host)) {
        host.removeAttribute('popover');
      }
    }
  } else if (host.hasAttribute('popover')) {
    try {
      anyHost.hidePopover?.();
    } catch {
      // Ignore
    }
    host.removeAttribute('popover');
  }
}

/**
 * Mount and maintain an in-page overlay (`#video-scopes-false-color`,
 * `#video-scopes-cursor-probe`) permanently inside the browser's Top Layer via
 * `popover="manual"`, with automatic non-popover `position: fixed` fallback if
 * `showPopover()` is rejected by the environment.
 *
 * Returns `true` if the host was re-parented or (re-)opened in the Top Layer.
 */
export function placeTopLayerOverlayHost(host: HTMLElement, forceRestack = false): boolean {
  const doc = host.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.documentElement) return false;

  let changed = false;
  const parent = overlayFullscreenParent(doc);
  if (host.parentElement !== parent) {
    parent.appendChild(host);
    changed = true;
  }

  const anyHost = host as HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  };

  if (typeof anyHost.showPopover === 'function') {
    if (host.getAttribute('popover') !== 'manual') {
      host.setAttribute('popover', 'manual');
      setImportant(host, 'margin', '0');
      setImportant(host, 'padding', '0');
      setImportant(host, 'border', '0');
      setImportant(host, 'background', 'transparent');
      setImportant(host, 'right', 'auto');
      setImportant(host, 'bottom', 'auto');
      setImportant(host, 'max-width', 'none');
      setImportant(host, 'max-height', 'none');
    }

    const alreadyOpen = isPopoverOpen(host);
    if (forceRestack || !alreadyOpen) {
      if (alreadyOpen) {
        try {
          anyHost.hidePopover?.();
        } catch {
          // Ignore
        }
      }
      let opened = false;
      try {
        anyHost.showPopover();
        opened = isPopoverOpen(host);
        if (opened) changed = true;
      } catch {
        opened = false;
      }
      // Critical safety fallback: if showPopover() failed or did not enter :popover-open,
      // remove [popover] immediately so UA `[popover]:not(:popover-open) { display: none }`
      // can NEVER leave the overlay invisible!
      if (!opened) {
        host.removeAttribute('popover');
      }
    }
  }

  return changed;
}

export function placeOverlayHost(host: HTMLElement, forceRestack = false): void {
  const doc = host.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc || !doc.documentElement) return;
  const parent = overlayFullscreenParent(doc);
  if (host.parentElement !== parent) {
    parent.appendChild(host);
  }
  syncTopLayerForVideoFullscreen(host, forceRestack);
}

/**
 * Keeps an overlay host visible across entering and exiting both container
 * fullscreen and native `<video>` fullscreen.
 */
export function followFullscreen(host: HTMLElement, onChange?: () => void): () => void {
  const place = (restack: boolean): void => {
    placeOverlayHost(host, restack);
    onChange?.();
  };
  const onFs = (): void => place(true);
  document.addEventListener('fullscreenchange', onFs);
  place(false);
  return () => {
    document.removeEventListener('fullscreenchange', onFs);
  };
}

export interface RenderedVideoBox {
  /** Content box left in viewport CSS pixels (excludes `object-fit` letterbox bars). */
  left: number;
  /** Content box top in viewport CSS pixels (excludes `object-fit` pillarbox/letterbox bars). */
  top: number;
  /** Rendered picture width in CSS pixels. */
  width: number;
  /** Rendered picture height in CSS pixels. */
  height: number;
  /** Source pixel offset X when `object-fit: cover` crops horizontally (0 otherwise). */
  cropX: number;
  /** Source pixel offset Y when `object-fit: cover` crops vertically (0 otherwise). */
  cropY: number;
  /** Visible source pixel width (`videoWidth` unless cropped by `cover`). */
  cropW: number;
  /** Visible source pixel height (`videoHeight` unless cropped by `cover`). */
  cropH: number;
}

/**
 * Compute the exact rendered video picture rectangle in viewport CSS pixels,
 * accounting for `object-fit` (`contain`, `cover`, `fill`, `scale-down`), CSS
 * visibility, and fullscreen layout.
 */
export function renderedVideoBox(video: HTMLVideoElement): RenderedVideoBox | null {
  if (!video.isConnected || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null;
  }
  const style = getComputedStyle(video);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return null;
  }
  const r = video.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  // Off-screen check
  if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) {
    return null;
  }

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const fit = style.objectFit || 'contain';

  if (fit === 'fill') {
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      cropX: 0,
      cropY: 0,
      cropW: vw,
      cropH: vh,
    };
  }

  const vidAspect = vw / vh;
  const boxAspect = r.width / r.height;

  if (fit === 'cover') {
    if (boxAspect > vidAspect) {
      // Cropped top & bottom
      const visH = vw / boxAspect;
      return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        cropX: 0,
        cropY: (vh - visH) / 2,
        cropW: vw,
        cropH: visH,
      };
    }
    const visW = vh * boxAspect;
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      cropX: (vw - visW) / 2,
      cropY: 0,
      cropW: visW,
      cropH: vh,
    };
  }

  // contain / scale-down / default
  if (fit === 'scale-down' && vw <= r.width && vh <= r.height) {
    return {
      left: r.left + (r.width - vw) / 2,
      top: r.top + (r.height - vh) / 2,
      width: vw,
      height: vh,
      cropX: 0,
      cropY: 0,
      cropW: vw,
      cropH: vh,
    };
  }

  if (boxAspect > vidAspect) {
    const w = r.height * vidAspect;
    return {
      left: r.left + (r.width - w) / 2,
      top: r.top,
      width: w,
      height: r.height,
      cropX: 0,
      cropY: 0,
      cropW: vw,
      cropH: vh,
    };
  }
  const h = r.width / vidAspect;
  return {
    left: r.left,
    top: r.top + (r.height - h) / 2,
    width: r.width,
    height: h,
    cropX: 0,
    cropY: 0,
    cropW: vw,
    cropH: vh,
  };
}
