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

const TOGGLE = { type: 'toggle-scopes' } as const;

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void toggleInTab(tab.id);
});

async function toggleInTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, TOGGLE);
  } catch {
    // No content script yet (tab predates the extension). Inject, then toggle.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tabId, TOGGLE).catch(() => {
      // The listener may still be registering; Alt+S also opens the panel.
    });
  }
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
