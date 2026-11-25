/**
 * Document Picture-in-Picture: move the whole HUD into an always-on-top window
 * so the scopes can live on a second monitor without covering the video.
 *
 * Requires Chrome 116+. When unavailable we report it rather than silently
 * doing nothing, because a dead button is worse than a disabled one.
 */
export interface PipWindow extends Window {
  documentPictureInPicture?: unknown;
}

export function pipSupported(): boolean {
  return typeof (window as unknown as { documentPictureInPicture?: unknown })
    .documentPictureInPicture === 'object';
}

export async function openPipWindow(host: HTMLElement): Promise<Window> {
  const dpip = (
    window as unknown as {
      documentPictureInPicture?: {
        requestWindow(opts: { width: number; height: number; disallowReturnToOpener?: boolean }): Promise<Window>;
      };
    }
  ).documentPictureInPicture;

  if (!dpip) throw new Error('documentPictureInPicture unavailable (needs Chrome 116+)');

  const win = await dpip.requestWindow({ width: 820, height: 560 });
  win.document.body.style.margin = '0';
  win.document.body.style.background = '#0b0f12';
  // The host keeps its own shadow DOM and inline styles, so it needs no CSS here.
  win.document.body.appendChild(host);
  return win;
}

/** Bring the host back to the page when the PiP window closes. */
export function onPipClosed(win: Window, host: HTMLElement, back: HTMLElement): void {
  win.addEventListener('pagehide', () => {
    if (host.parentElement !== back) back.appendChild(host);
  });
}
