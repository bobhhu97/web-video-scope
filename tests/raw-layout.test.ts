import { describe, expect, it } from 'vitest';
import { i420Layout } from '../src/gpu/raw-planes';

describe('i420Layout', () => {
  it('places Y first, then U, then V for 1920x1080', () => {
    const l = i420Layout(1920, 1080);
    expect(l.yOffset).toBe(0);
    expect(l.yStride).toBe(1920);
    expect(l.chromaStride).toBe(960);
    expect(l.chromaWidth).toBe(960);
    expect(l.chromaHeight).toBe(540);
    expect(l.uvOffset).toBe(1920 * 1080);
    expect(l.vOffset).toBe(1920 * 1080 + 960 * 540);
  });

  it('total size matches frame.allocationSize for I420', () => {
    const w = 640;
    const h = 360;
    const l = i420Layout(w, h);
    const total = l.vOffset + l.chromaStride * l.chromaHeight;
    expect(total).toBe(w * h + 2 * (w / 2) * (h / 2));
  });

  it('rejects odd dimensions, which I420 cannot represent without padding', () => {
    expect(() => i420Layout(1919, 1080)).toThrow(/even/);
    expect(() => i420Layout(1920, 1081)).toThrow(/even/);
  });

  it('handles the smallest legal plane', () => {
    const l = i420Layout(2, 2);
    expect(l.chromaWidth).toBe(1);
    expect(l.chromaHeight).toBe(1);
    expect(l.vOffset).toBe(4 + 1);
  });

  it('chroma planes never overlap the luma plane', () => {
    const l = i420Layout(1280, 720);
    expect(l.uvOffset).toBeGreaterThanOrEqual(l.yStride * 720);
    expect(l.vOffset).toBeGreaterThanOrEqual(l.uvOffset + l.chromaStride * l.chromaHeight);
  });
});
