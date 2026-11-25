import { describe, expect, it } from 'vitest';
import { shouldUpload } from '../src/gpu/signal-texture';

describe('shouldUpload', () => {
  it('refuses before the video has current data', () => {
    expect(shouldUpload(1, 1.0, -1)).toBe(false);
    expect(shouldUpload(0, 0, -1)).toBe(false);
  });

  it('accepts the first frame once ready', () => {
    expect(shouldUpload(2, 0.0, -1)).toBe(true);
    expect(shouldUpload(4, 1.5, -1)).toBe(true);
  });

  it('skips a frame that has already been uploaded', () => {
    expect(shouldUpload(4, 1.5, 1.5)).toBe(false);
  });

  it('skips sub-frame jitter by default', () => {
    expect(shouldUpload(4, 1.5001, 1.5)).toBe(false);
  });

  it('accepts a genuinely new frame', () => {
    expect(shouldUpload(4, 1.5417, 1.5)).toBe(true);
  });

  it('honours a custom minimum delta', () => {
    expect(shouldUpload(4, 1.62, 1.5, 0.2)).toBe(false);
    expect(shouldUpload(4, 1.72, 1.5, 0.2)).toBe(true);
  });

  it('still accepts frames that went backwards (seek)', () => {
    expect(shouldUpload(4, 0.2, 8.0)).toBe(true);
  });
});
