/**
 * Tab capture, split by what each context can actually do.
 *
 * A content script cannot call `chrome.tabCapture` (no permission scope for it
 * in the page world), and a service worker cannot call `getUserMedia`. So:
 *
 *   service worker  -> getMediaStreamId()  (brokers permission, owns the state
 *                                          machine that prevents double-start)
 *   content script  -> getUserMedia({ chromeMediaSource: 'tab', ... })
 *                     + track.restrictTo(RestrictionTarget.fromElement(video))
 *
 * Both halves live here because they share the message contract.
 */

export type CaptureState = 'idle' | 'starting' | 'active' | 'stopping';

export interface CaptureStartResponse {
  ok: boolean;
  streamId?: string;
  error?: string;
}

export interface CaptureStopResponse {
  ok: boolean;
  error?: string;
}

export const CAPTURE_START = 'capture:start' as const;
export const CAPTURE_STOP = 'capture:stop' as const;

export interface CaptureStartMessage {
  type: typeof CAPTURE_START;
}

export interface CaptureStopMessage {
  type: typeof CAPTURE_STOP;
}

export type CaptureMessage = CaptureStartMessage | CaptureStopMessage;

/**
 * Content-script side. Given a granted stream id, consume the tab capture and
 * narrow it to the video element when Chrome supports it (121+).
 */
export interface CaptureHandle {
  track: MediaStreamTrack;
  stop(): void;
}

export async function consumeTabStream(
  streamId: string,
  video: HTMLVideoElement,
): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // Chrome-specific constraint; not part of the standard TypedDict.
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    } as unknown as MediaTrackConstraints,
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('tab capture produced no video track');
  }

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
  const t = track as MediaStreamTrack & {
    restrictTo?: (target: unknown) => Promise<void>;
    cropTo?: (target: unknown) => Promise<void>;
  };
  const RestrictionTarget = (
    window as unknown as { RestrictionTarget?: { fromElement(el: Element): Promise<unknown> } }
  ).RestrictionTarget;
  const CropTarget = (
    window as unknown as { CropTarget?: { fromElement(el: Element): Promise<unknown> } }
  ).CropTarget;

  // Element Restriction yields a stream at the element's own dimensions.
  if (t.restrictTo && RestrictionTarget) {
    try {
      await t.restrictTo(await RestrictionTarget.fromElement(video));
      return;
    } catch {
      /* fall through to region capture */
    }
  }
  // Region Capture crops to the element's rectangle at tab resolution.
  if (t.cropTo && CropTarget) {
    try {
      await t.cropTo(await CropTarget.fromElement(video));
    } catch {
      /* full-tab capture is still usable, just lower quality */
    }
  }
}

/**
 * Read frames from a captured track. Each VideoFrame must be closed by the
 * consumer once uploaded.
 */
export function createFrameReader(track: MediaStreamTrack): {
  read(): Promise<VideoFrame | null>;
  close(): void;
} {
  interface TrackProcessor {
    readable: ReadableStream<VideoFrame>;
  }
  const Processor = (
    globalThis as unknown as {
      MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => TrackProcessor;
    }
  ).MediaStreamTrackProcessor;

  const processor = new Processor({ track });
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
