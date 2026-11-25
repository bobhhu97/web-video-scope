/**
 * Keeps the HUD host attached to the document.
 *
 * Pages that build their DOM after load (YouTube's Polymer hydration, many SPA
 * frameworks) replace documentElement's children wholesale. Because the content
 * script runs at document_start, the host is inserted before that rebuild and is
 * then removed as collateral — the panel mounts, reports itself mounted, and is
 * gone a moment later with nothing visible to the user.
 *
 * A MutationObserver that re-appends on removal is the only reliable defence:
 * there is no event for "my element was detached".
 */
export interface Guardian {
  /** Re-attach now, e.g. after a fullscreen change moved things around. */
  reattach(): void;
  stop(): void;
}

export function keepAttached(
  host: HTMLElement,
  preferredParent: () => Element,
  onReattach?: (count: number) => void,
): Guardian {
  let reattachments = 0;
  let scheduled = false;
  let stopped = false;

  const attach = (): void => {
    if (stopped) return;
    const parent = preferredParent();
    if (!parent) return;
    if (host.parentElement !== parent) {
      parent.appendChild(host);
      reattachments += 1;
      onReattach?.(reattachments);
    } else if (!host.isConnected) {
      // Same parent but detached from the document (e.g. the parent itself was
      // replaced). Appending again moves it to the live tree.
      parent.appendChild(host);
      reattachments += 1;
      onReattach?.(reattachments);
    }
  };

  // Batch re-attachment: a page rebuild can fire hundreds of mutations, and
  // re-appending inside the observer callback would amplify them.
  const scheduleAttach = (): void => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      attach();
    });
  };

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.removedNodes.length > 0) {
        for (const n of rec.removedNodes) {
          if (n === host) {
            scheduleAttach();
            return;
          }
        }
      }
      if (rec.type === 'childList' && !host.isConnected) {
        scheduleAttach();
        return;
      }
    }
    if (!host.isConnected) scheduleAttach();
  });

  observer.observe(document.documentElement, { childList: true, subtree: false });

  // A low-frequency safety net for the cases where the whole documentElement is
  // swapped, which would silently kill the observer above.
  const watchdog = setInterval(() => {
    if (stopped) return;
    if (!host.isConnected) {
      // Re-arm the observer against the current root before re-attaching.
      observer.disconnect();
      observer.observe(document.documentElement, { childList: true, subtree: false });
      attach();
    }
  }, 2000);

  attach();

  return {
    reattach(): void {
      attach();
    },
    stop(): void {
      stopped = true;
      observer.disconnect();
      clearInterval(watchdog);
    },
  };
}
