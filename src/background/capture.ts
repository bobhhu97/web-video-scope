/**
 * Cross-origin capture.
 *
 * A `<video>` from another origin taints any canvas and makes
 * `importExternalTexture` throw, so its pixels are simply not readable. There
 * is no way around this in a content script — but Chrome can capture the tab
 * itself, and since Chrome 121 can restrict that capture to a single element.
 *
 * Everything here is best-effort by design. Each step can legitimately fail
 * depending on the site and Chrome version, and the caller is expected to fall
 * back to reporting "cannot analyse" rather than showing wrong numbers.
 */

export interface CaptureHandle {
  track: MediaStreamTrack;
  stop(): void;
}

async function getStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? 'no stream id'));
      else resolve(id);
    });
  });
}

/**
 * Start a tab capture and, when supported, restrict it to the given element so
 * the stream contains only the video (not the surrounding UI).
 */
export async function startElementCapture(video: HTMLVideoElement): Promise<CaptureHandle> {
  const tabId = await getTabId();
  const streamId = await getStreamId(tabId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // Chrome-specific constraint; not in the standard MediaTrackConstraints.
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    } as unknown as MediaTrackConstraints,
  });

  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('tab capture produced no video track');

  await restrictToElement(track, video);

  return {
    track,
    stop(): void {
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

async function restrictToElement(track: MediaStreamTrack, video: HTMLVideoElement): Promise<void> {
  const withRestrict = track as MediaStreamTrack & {
    restrictTo?: (target: unknown) => Promise<void>;
    cropTo?: (target: unknown) => Promise<void>;
  };
  const RestrictionTarget = (
    window as unknown as { RestrictionTarget?: { fromElement(el: Element): Promise<unknown> } }
  ).RestrictionTarget;
  const CropTarget = (window as unknown as { CropTarget?: { fromElement(el: Element): Promise<unknown> } })
    .CropTarget;

  // Element Restriction gives a clean stream at the element's own dimensions.
  if (withRestrict.restrictTo && RestrictionTarget) {
    try {
      await withRestrict.restrictTo(await RestrictionTarget.fromElement(video));
      return;
    } catch {
      /* fall through to region capture */
    }
  }
  // Region Capture crops to the element's rectangle but keeps tab resolution.
  if (withRestrict.cropTo && CropTarget) {
    try {
      await withRestrict.cropTo(await CropTarget.fromElement(video));
    } catch {
      /* full-tab capture is still usable, just slower and lower quality */
    }
  }
}

async function getTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error('no active tab');
  return tab.id;
}

/**
 * Read frames from a captured track via MediaStreamTrackProcessor.
 * Each VideoFrame must be closed by the consumer after use.
 */
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}

declare const MediaStreamTrackProcessor: {
  new (init: { track: MediaStreamTrack }): TrackProcessor;
};

export function createFrameReader(track: MediaStreamTrack): {
  read(): Promise<VideoFrame | null>;
  close(): void;
} {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let closed = false;
  return {
    async read(): Promise<VideoFrame | null> {
      if (closed) return null;
      const { value, done } = await reader.read();
      if (done || !value) return null;
      return value;
    },
    close(): void {
      if (closed) return;
      closed = true;
      reader.cancel().catch(() => {});
    },
  };
}

/**
 * Optional CORS repair via declarativeNetRequest. This only helps when the
 * origin already permits cross-origin reads in principle; signed URLs that
 * reject the real Origin will still fail. UI must label it as a network change.
 */
export async function installCorsRules(): Promise<void> {
  const RULE_ID = 9001;
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    throw new Error('declarativeNetRequest unavailable');
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          responseHeaders: [
            {
              header: 'access-control-allow-origin',
              operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
              value: '*',
            },
          ],
        },
        condition: { resourceTypes: ['media' as chrome.declarativeNetRequest.ResourceType] },
      },
    ],
  });
}

export async function removeCorsRules(): Promise<void> {
  await chrome.declarativeNetRequest?.updateDynamicRules({ removeRuleIds: [9001] });
}
