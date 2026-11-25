/**
 * Service worker.
 *
 * Responsibilities:
 *  1. Turn an action click into a content-script toggle.
 *  2. Broker tab capture: `getMediaStreamId` must run here, because a content
 *     script cannot call `chrome.tabCapture`. The stream itself is consumed in
 *     the content script, which is the only context with `getUserMedia`.
 *
 * No state lives in module variables — MV3 workers terminate after ~30 s idle.
 * Capture state lives in storage.session, which survives a worker restart and
 * is cleared when the browser closes.
 */
import {
  CAPTURE_START,
  CAPTURE_STOP,
  type CaptureMessage,
  type CaptureStartResponse,
  type CaptureState,
  type CaptureStopResponse,
} from '../shared/tab-capture';

// `show`, not `toggle`: the toolbar icon means "show me the scopes". A toggle
// would close an already-open panel, which reads as a dead button.
const SHOW = { type: 'show-scopes' } as const;

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void toggleInTab(tab.id);
});

async function toggleInTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, SHOW);
    console.info('[video-scopes] told existing content script to show', tabId);
    return;
  } catch (e) {
    // Most common cause: the tab was open before the extension was installed,
    // so no content script is running in it yet.
    console.info('[video-scopes] no content script in tab, injecting:', String(e));
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    // This is the failure the user sees as "clicking does nothing". It happens
    // on protected pages (chrome://, the Web Store, PDF viewer) and on pages
    // where the extension lacks host access.
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[video-scopes] injection failed:', msg);
    await chrome.action.setBadgeText({ tabId, text: '!' }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d87f7f' }).catch(() => {});

    // Also write the reason into the page: a silent failure is what makes this
    // feel like "the extension does nothing".
    await chrome.scripting
      .executeScript({
        target: { tabId },
        func: (reason: string) => {
          const id = 'video-scopes-diag';
          document.getElementById(id)?.remove();
          const el = document.createElement('div');
          el.id = id;
          el.style.cssText =
            'all:initial;position:fixed;top:8px;left:8px;z-index:2147483647;' +
            'font:12px/1.5 ui-monospace,monospace;padding:8px 12px;border-radius:6px;' +
            'max-width:460px;white-space:pre-wrap;background:#3a1414;color:#ffb4b4;' +
            'border:1px solid #ff6b6b';
          el.textContent = 'Video Scopes: cannot start on this page.\n' + reason;
          document.documentElement.appendChild(el);
          setTimeout(() => el.remove(), 15000);
        },
        args: [msg],
      })
      .catch(() => {});
    return;
  }

  // The listener registers synchronously at script start, but injection and
  // message delivery race; retry briefly rather than losing the click.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await chrome.tabs.sendMessage(tabId, SHOW);
      console.info('[video-scopes] injected and showed panel in tab', tabId);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  console.error('[video-scopes] injected but the panel never answered');
}

// `return true` keeps the message channel open for the async reply — required
// for every listener that responds after an await.
chrome.runtime.onMessage.addListener(
  (message: CaptureMessage, _sender, sendResponse: (r: CaptureStartResponse | CaptureStopResponse) => void) => {
    if (message?.type === CAPTURE_START) {
      void (async () => {
        sendResponse(await startCapture());
      })();
      return true;
    }
    if (message?.type === CAPTURE_STOP) {
      void (async () => {
        sendResponse(await stopCapture());
      })();
      return true;
    }
    return undefined;
  },
);

async function readState(): Promise<CaptureState> {
  const got = await chrome.storage.session.get('captureState');
  return (got.captureState as CaptureState | undefined) ?? 'idle';
}

async function writeState(state: CaptureState): Promise<void> {
  await chrome.storage.session.set({ captureState: state });
}

/**
 * Grant a tab-capture stream id.
 *
 * Chrome throws "Cannot capture a tab with an active stream" if a capture is
 * already live, so transitions are locked: starting/active/stopping all reject
 * a new start rather than racing.
 */
async function startCapture(): Promise<CaptureStartResponse> {
  const state = await readState();
  if (state !== 'idle') {
    return { ok: false, error: `capture already ${state}` };
  }

  await writeState('starting');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error('no active tab');

    const streamId = await getStreamId(tab.id);
    await chrome.storage.session.set({ captureTabId: tab.id });
    await writeState('active');
    return { ok: true, streamId };
  } catch (e) {
    await writeState('idle');
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function stopCapture(): Promise<CaptureStopResponse> {
  const state = await readState();
  if (state !== 'idle') await writeState('stopping');
  try {
    await chrome.storage.session.remove(['captureTabId']);
    return { ok: true };
  } finally {
    // Reset in `finally` so an error above cannot wedge the state machine.
    await writeState('idle');
  }
}

/** Promise wrapper around the callback-only tabCapture API. */
function getStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? 'no stream id granted'));
      else resolve(id);
    });
  });
}
