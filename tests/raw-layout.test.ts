import { describe, expect, it } from 'vitest';
import { i420Layout, nv12Layout, splitI420, splitNv12 } from '../src/gpu/raw-planes';

describe('nv12Layout', () => {
  it('is 1.5 bytes per pixel for 1280x720', () => {
    const l = nv12Layout(1280, 720);
    expect(l.ySize).toBe(1280 * 720);
    expect(l.uvOffset).toBe(1280 * 720);
    expect(l.uvStride).toBe(1280);
    expect(l.uvHeight).toBe(360);
    // Chromium reported exactly 1382400 bytes for this frame.
    expect(l.uvOffset + l.uvStride * l.uvHeight).toBe(1_382_400);
  });

  it('rejects odd dimensions', () => {
    expect(() => nv12Layout(1281, 720)).toThrow(/even/);
    expect(() => nv12Layout(1280, 721)).toThrow(/even/);
  });
});

describe('splitNv12', () => {
  it('returns luma and interleaved chroma as contiguous slices', () => {
    const w = 4;
    const h = 4;
    const buf = new Uint8Array(w * h * 1.5);
    for (let i = 0; i < w * h; i++) buf[i] = 16 + i;
    // Interleaved UV at half height: 2 rows of 4 bytes.
    buf[w * h + 0] = 100;
    buf[w * h + 1] = 200;

    const { y, uv } = splitNv12(buf, w, h);
    expect(y.length).toBe(w * h);
    expect(uv.length).toBe(w * h * 0.5);
    expect(y[0]).toBe(16);
    expect(y[w * h - 1]).toBe(16 + w * h - 1);
    expect(uv[0]).toBe(100); // U
    expect(uv[1]).toBe(200); // V
  });

  it('does not copy: slices alias the source buffer', () => {
    const buf = new Uint8Array(4 * 4 * 1.5);
    const { y } = splitNv12(buf, 4, 4);
    y[0] = 42;
    expect(buf[0]).toBe(42);
  });
});

describe('i420Layout', () => {
  it('places Y, then U, then V', () => {
    const l = i420Layout(1920, 1080);
    expect(l.uOffset).toBe(1920 * 1080);
    expect(l.vOffset).toBe(1920 * 1080 + 960 * 540);
    expect(l.chromaStride).toBe(960);
    expect(l.chromaHeight).toBe(540);
  });

  it('total size equals Y + 2 chroma planes', () => {
    const w = 640;
    const h = 360;
    const l = i420Layout(w, h);
    expect(l.vOffset + l.chromaStride * l.chromaHeight).toBe(w * h + 2 * (w / 2) * (h / 2));
  });

  it('rejects odd dimensions', () => {
    expect(() => i420Layout(1919, 1080)).toThrow(/even/);
  });
});

describe('splitI420', () => {
  it('returns three non-overlapping planes', () => {
    const w = 4;
    const h = 4;
    const buf = new Uint8Array(w * h + 2 * (w / 2) * (h / 2));
    for (let i = 0; i < w * h; i++) buf[i] = 1;
    buf[w * h] = 2;
    buf[w * h + 4] = 3;

    const { y, u, v } = splitI420(buf, w, h);
    expect(y.length).toBe(w * h);
    expect(u.length).toBe(4);
    expect(v.length).toBe(4);
    expect(y[0]).toBe(1);
    expect(u[0]).toBe(2);
    expect(v[0]).toBe(3);
  });
});
