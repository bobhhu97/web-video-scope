/**
 * Keeps the HUD mounted inside whatever element is currently fullscreen.
 * Without this the overlay becomes invisible the moment the user presses `f`
 * on a player, because a fullscreen element renders only its own subtree.
 */
export function followFullscreen(host: HTMLElement): () => void {
  const place = (): void => {
    const fs = document.fullscreenElement;
    const parent: Element = fs ?? document.documentElement;
    if (host.parentElement !== parent) parent.appendChild(host);
  };
  document.addEventListener('fullscreenchange', place);
  place();
  return () => document.removeEventListener('fullscreenchange', place);
}
