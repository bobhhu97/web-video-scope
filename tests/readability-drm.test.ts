import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { videoReadability } from '../src/content/readability';

/**
 * These tests exist because the first DRM check was wrong in a way that broke
 * every ordinary video: `mediaKeys` is present on all HTMLMediaElements and is
 * simply `null` when no EME session is attached.
 */
const dom = new JSDOM('<!doctype html><html><body><video id="v"></video></body></html>');
const doc = dom.window.document;

function fakeVideo(props: Record<string, unknown>): HTMLVideoElement {
  const v = doc.getElementById('v') as HTMLVideoElement;
  Object.assign(v as unknown as Record<string, unknown>, props);
  return v;
}

describe('videoReadability DRM detection', () => {
  it('treats a normal video with null mediaKeys as readable', () => {
    const v = fakeVideo({ mediaKeys: null });
    expect(videoReadability(v).kind).not.toBe('drm');
  });

  it('treats a video with an active EME session as DRM', () => {
    const v = fakeVideo({ mediaKeys: {} as MediaKeys });
    expect(videoReadability(v).kind).toBe('drm');
  });

  it('never reports DRM merely because the property exists', () => {
    // The regression this guards: `typeof mediaKeys !== 'undefined'` is true on
    // every video, so the original check flagged everything as DRM.
    const v = fakeVideo({ mediaKeys: undefined });
    expect(videoReadability(v).kind).not.toBe('drm');
  });
});
