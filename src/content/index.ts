const HOST_ID = 'video-scopes-host';

/**
 * `all: initial` must come FIRST. It resets every property, so writing it after
 * `position: fixed` would silently reset position and drop the host back into
 * normal document flow.
 */
const HOST_STYLE =
  'all:initial;position:fixed;top:16px;right:16px;z-index:2147483646;' +
  'font:12px/1.4 ui-monospace,monospace;color:#9fe8b0;background:#101413cc;' +
  'padding:8px 12px;border-radius:6px;border:1px solid #9fe8b033';

function toggle(): void {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.remove();
    return;
  }
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = HOST_STYLE;
  host.textContent = 'Video Scopes ready';
  document.documentElement.appendChild(host);
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'toggle-scopes') toggle();
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') toggle();
});
