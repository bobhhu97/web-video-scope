/**
 * Hosts the HUD in its own always-on-top OS window.
 *
 * Why this is the primary presentation: every in-page strategy was defeated by
 * the host page. YouTube rebuilds documentElement (removing the element),
 * stacking contexts can bury a fixed overlay, and there is no reliable way to
 * stay above a video player's own controls. A Document Picture-in-Picture window
 * is a separate OS window that stays above other windows, keeps full DOM and
 * canvas access, and cannot be touched by the page at all.
 *
 * Chrome 116+. When unavailable the caller falls back to the in-page overlay.
 */

interface DocumentPiP {
  requestWindow(opts: { width: number; height: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  window: Window | null;
}

function getApi(): DocumentPiP | null {
  const dpip = (window as unknown as { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture;
  return dpip && typeof dpip.requestWindow === 'function' ? dpip : null;
}

export function pipSupported(): boolean {
  // `?vsInline=1` keeps the panel in the page. The test suites rely on this to
  // measure page-level geometry without a second window in the way, and it is
  // also a way for a user to force the overlay if their OS window manager makes
  // the floating window awkward.
  try {
    if (new URLSearchParams(location.search).get('vsInline') === '1') return false;
  } catch {
    // Non-standard location (e.g. a test harness): fall through.
  }
  return getApi() !== null;
}

export interface PiPHost {
  /** The window the host lives in. */
  readonly window: Window;
  /** True while the window is still open. */
  isOpen(): boolean;
  /** Move the host back to the page and close the window. */
  close(): void;
  /** Resize the floating window. */
  resize(width: number, height: number): void;
}

/**
 * Move `host` into a new always-on-top window.
 *
 * The host keeps its shadow root and inline styles, so no CSS is needed here —
 * that also means the panel looks identical in both presentations.
 */
export async function openFloatingWindow(
  host: HTMLElement,
  options: { width?: number; height?: number; onClosed?: () => void } = {},
): Promise<PiPHost> {
  const api = getApi();
  if (!api) throw new Error('Document Picture-in-Picture needs Chrome 116+');

  const width = options.width ?? 860;
  const height = options.height ?? 620;
  const win = await api.requestWindow({ width, height });

  // A transparent body with no margin, so the panel's own rounded chrome shows
  // against the desktop rather than a white rectangle.
  const doc = win.document;
  doc.documentElement.style.cssText = 'background:#0b0f12;margin:0;padding:0;height:100%';
  doc.body.style.cssText = 'margin:0;padding:0;height:100%;background:#0b0f12;overflow:hidden';
  doc.body.appendChild(host);

  // The host was authored for a page overlay with fixed insets. In a window it
  // must fill the viewport, otherwise the canvas cells get a zero content box
  // and the scopes render into nothing.
  host.style.cssText =
    'all:initial;position:absolute;top:0;left:0;right:0;bottom:0;' +
    'width:100%;height:100%;z-index:1;';

  // Re-assert the panel's own sizing: it is the direct child of the shadow root
  // and must stretch, not keep the 760px overlay width.
  const style = doc.createElement('style');
  style.textContent = `
    .panel {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      resize: none !important;
      box-sizing: border-box;
    }
  `;
  host.shadowRoot?.appendChild(style);

  let open = true;
  const handleClosed = (): void => {
    if (!open) return;
    open = false;
    options.onClosed?.();
  };
  win.addEventListener('pagehide', handleClosed);
  win.addEventListener('unload', handleClosed);

  return {
    window: win,
    isOpen: () => open && !win.closed,
    close(): void {
      try {
        win.close();
      } catch {
        // Already gone.
      }
      handleClosed();
    },
    resize(w: number, h: number): void {
      try {
        win.resizeTo(w, h);
      } catch {
        // Some platforms refuse programmatic resize; the user can drag instead.
      }
    },
  };
}

/** Restore the host to an in-page presentation after the window closes. */
export function returnToPage(host: HTMLElement, parent: Element): void {
  host.style.cssText = host.style.cssText.replace(/position:\s*absolute;?/, 'position:fixed;');
  if (host.parentElement !== parent) parent.appendChild(host);
}
