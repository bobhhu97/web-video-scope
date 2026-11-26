/**
 * Floating window support.
 *
 * Two facts drove this design:
 *
 * 1. A WebGPU canvas context is bound to the document that configured it. Moving
 *    a <canvas> into another document (which Document PiP requires) silently
 *    invalidates that context: submit() keeps running, getCurrentTexture returns
 *    a dead texture, and the window shows an empty panel with a correctly drawn
 *    graticule — exactly the symptom reported.
 *
 *    So canvas elements must be CREATED in the target document, never adopted
 *    into it.
 *
 * 2. The HUD therefore cannot simply be reparented. The caller keeps one
 *    controller per document: tear down the in-page one, build a new HUD and
 *    controller against the window's fresh canvases.
 *
 * This module owns only the window lifecycle.
 */

interface DocumentPiP {
  requestWindow(opts: {
    width: number;
    height: number;
    disallowReturnToOpener?: boolean;
  }): Promise<Window>;
  window: Window | null;
}

function getApi(): DocumentPiP | null {
  if (typeof window === 'undefined') return null;
  const dpip = (window as unknown as { documentPictureInPicture?: DocumentPiP })
    .documentPictureInPicture;
  return dpip && typeof dpip.requestWindow === 'function' ? dpip : null;
}

export function pipSupported(): boolean {
  try {
    if (new URLSearchParams(location.search).get('vsInline') === '1') return false;
  } catch {
    // Non-standard location (test harness): fall through.
  }
  return getApi() !== null;
}

export interface FloatingWindow {
  readonly window: Window;
  readonly document: Document;
  isOpen(): boolean;
  close(): void;
}

/**
 * Open an always-on-top window and prepare its document.
 *
 * The document starts empty apart from base styling; the caller builds the HUD
 * inside it, which is what keeps each canvas and its GPU context in the same
 * document for their whole lifetime.
 */
export async function openFloatingWindow(
  options: { width?: number; height?: number; onClosed?: () => void } = {},
): Promise<FloatingWindow> {
  const api = getApi();
  if (!api) throw new Error('Document Picture-in-Picture needs Chrome 116+');

  const win = await api.requestWindow({
    width: options.width ?? 880,
    height: options.height ?? 620,
  });

  const doc = win.document;
  doc.documentElement.style.cssText =
    'background:#0b0f12;margin:0;padding:0;height:100%;overflow:hidden';
  doc.body.style.cssText = 'margin:0;padding:0;height:100%;background:#0b0f12;overflow:hidden';

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
    document: doc,
    isOpen: () => open && !win.closed,
    close(): void {
      try {
        win.close();
      } catch {
        // Already gone.
      }
      handleClosed();
    },
  };
}
