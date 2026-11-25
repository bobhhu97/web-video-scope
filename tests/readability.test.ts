import { describe, expect, it } from 'vitest';
import { readabilityNotice, type Readability } from '../src/content/readability';

describe('readabilityNotice', () => {
  it('says nothing when the video is readable', () => {
    expect(readabilityNotice({ kind: 'readable' }, true)).toBeNull();
  });

  it('explains DRM instead of showing an empty scope', () => {
    const text = readabilityNotice({ kind: 'drm' }, true);
    expect(text).toMatch(/DRM/);
    expect(text).toMatch(/cannot run/);
  });

  it('explains cross-origin and points at the two remedies', () => {
    const text = readabilityNotice({ kind: 'cross-origin' }, true);
    expect(text).toMatch(/CORS/);
    expect(text).toMatch(/tab capture/);
  });

  it('does not mention remedies that are unavailable', () => {
    const text = readabilityNotice({ kind: 'cross-origin' }, false);
    expect(text).toMatch(/not readable/);
  });

  it('covers the unknown case', () => {
    expect(readabilityNotice({ kind: 'unknown' }, true)).toMatch(/Could not read/);
  });

  it('returns a non-null string for every non-readable kind', () => {
    const kinds: Readability['kind'][] = ['drm', 'cross-origin', 'unknown'];
    for (const kind of kinds) {
      expect(readabilityNotice({ kind } as Readability, true)).toBeTruthy();
    }
  });
});
