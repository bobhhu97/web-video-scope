
import { describe, expect, it } from 'vitest';
import { LUMA } from '../src/core/color/matrices';
import { axisMapping } from '../src/core/scale/quantize';
import {
  FULL_AXIS,
  computeCie,
  computeVectorscope,
  computeWaveform,
} from '../src/core/scopes/reference';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };

function rgba(...px: [number, number, number][]): Uint8Array {
  const out = new Uint8Array(px.length * 4);
  px.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

describe('computeWaveform on a full-range axis', () => {
  it('puts mid-gray in the middle bin of every column', () => {
    const img = rgba([128, 128, 128], [128, 128, 128]);
    const r = computeWaveform(img, 2, 1, 2, 256, LUMA.bt709, 0, FULL_AXIS);
    const bin = Math.floor((128 / 255) * 256);
    expect(bin).toBe(128);
    expect(r.density[bin * 2 + 0]).toBe(1);
    expect(r.density[bin * 2 + 1]).toBe(1);
  });

  it('black and white land in the first and last bin', () => {
    const img = rgba([0, 0, 0], [255, 255, 255]);
    const r = computeWaveform(img, 2, 1, 2, 256, LUMA.bt709, 0, FULL_AXIS);
    expect(r.density[0]).toBe(1);
    expect(r.density[255 * 2 + 1]).toBe(1);
  });

  it('column index follows the horizontal position', () => {
    const img = rgba([10, 10, 10], [10, 10, 10], [10, 10, 10], [10, 10, 10]);
    const r = computeWaveform(img, 4, 1, 2, 64, LUMA.bt709, 0, FULL_AXIS);
    const bin = Math.floor((10 / 255) * 64);
    expect(r.density[bin * 2 + 0]).toBe(2);
    expect(r.density[bin * 2 + 1]).toBe(2);
  });
});

describe('computeWaveform on a limited-range axis', () => {
  const limitedAxis = () => axisMapping(L8);

  it('display mid-gray maps below the axis midpoint (legal compression)', () => {
    const img = rgba([128, 128, 128]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    const axis = (16 + 219 * (128 / 255)) / 255;
    const bin = Math.floor(axis * 256);
    expect(bin).toBe(126);
    expect(r.density[bin]).toBe(1);
  });

  it('display black sits at bin 16, not bin 0 (footroom is visible)', () => {
    const img = rgba([0, 0, 0]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    expect(r.density[0]).toBe(0);
    expect(r.density[16]).toBe(1);
  });

  it('display white sits at bin 235, not bin 255 (headroom is visible)', () => {
    const img = rgba([255, 255, 255]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    expect(r.density[255]).toBe(0);
    expect(r.density[235]).toBe(1);
  });

  it('limited and full axes never produce the same bin for white', () => {
    const img = rgba([255, 255, 255]);
    const a = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    const b = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, axisMapping(F8));
    const binOf = (d: Uint32Array): number => d.findIndex((n) => n > 0);
    expect(binOf(a.density)).toBe(235);
    expect(binOf(b.density)).toBe(255);
  });
});

describe('computeWaveform channels and planes', () => {
  it('a single selected channel writes plane 0 only', () => {
    const img = rgba([255, 0, 0], [255, 0, 0]);
    const r = computeWaveform(img, 2, 1, 2, 256, LUMA.bt709, 1, FULL_AXIS);
    expect(r.planes).toBe(1);
    expect(r.density.length).toBe(2 * 256);
    expect(r.density[255 * 2 + 0]).toBe(1);
    expect(r.density[0]).toBe(0);
  });

  it('channel 4 writes all three planes in one pass', () => {
    const img = rgba([255, 0, 0]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 4, FULL_AXIS);
    const stride = 1 * 256;
    expect(r.planes).toBe(3);
    expect(r.density[0 * stride + 255]).toBe(1); // R
    expect(r.density[1 * stride + 0]).toBe(1); // G
    expect(r.density[2 * stride + 0]).toBe(1); // B
  });

  it('luma uses the matrix coefficients, not a fixed 0.299/0.587', () => {
    const img = rgba([0, 255, 0]);
    const bt709 = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, FULL_AXIS);
    const bt601 = computeWaveform(img, 1, 1, 1, 256, LUMA.bt601, 0, FULL_AXIS);
    const binOf = (d: Uint32Array): number => d.findIndex((n) => n > 0);
    expect(binOf(bt709.density)).toBe(Math.floor(0.7152 * 256));
    expect(binOf(bt601.density)).toBe(Math.floor(0.587 * 256));
    expect(binOf(bt709.density)).not.toBe(binOf(bt601.density));
  });

  it('clamps out-of-range values instead of writing out of bounds', () => {
    const img = rgba([255, 255, 255]);
    const r = computeWaveform(img, 1, 1, 1, 16, LUMA.bt709, 0, { black: 0, span: 4 });
    expect(r.density[15]).toBe(1);
    expect(r.density.length).toBe(16);
  });
});

describe('computeVectorscope', () => {
  it('neutral gray sits at the exact center', () => {
    const size = 64;
    const r = computeVectorscope(rgba([128, 128, 128]), 1, 1, size, LUMA.bt709);
    expect(r[Math.floor(size / 2) * size + Math.floor(size / 2)]).toBe(1);
  });

  it('red lands up and left of center (Cr > 0, Cb < 0)', () => {
    const size = 128;
    const r = computeVectorscope(rgba([255, 0, 0]), 1, 1, size, LUMA.bt709);
    let found = -1;
    for (let i = 0; i < r.length; i++) if (r[i]! > 0) found = i;
    expect(found).toBeGreaterThanOrEqual(0);
    const x = found % size;
    const y = Math.floor(found / size);
    expect(x).toBeLessThan(size / 2);
    expect(y).toBeLessThan(size / 2);
  });

  it('zoom moves the same colour further from centre', () => {
    const size = 256;
    const img = rgba([200, 120, 90]);
    const one = computeVectorscope(img, 1, 1, size, LUMA.bt709, 1);
    const two = computeVectorscope(img, 1, 1, size, LUMA.bt709, 2);
    const find = (d: Uint32Array): [number, number] => {
      const i = d.findIndex((n) => n > 0);
      return [i % size, Math.floor(i / size)];
    };
    const [x1, y1] = find(one);
    const [x2, y2] = find(two);
    const half = size / 2;
    expect(Math.hypot(x2 - half, y2 - half)).toBeGreaterThan(
      Math.hypot(x1 - half, y1 - half) * 1.5,
    );
  });

  it('BT.709 red sits near 103 degrees from +Cb', () => {
    const size = 512;
    const r = computeVectorscope(rgba([255, 0, 0]), 1, 1, size, LUMA.bt709);
    const i = r.findIndex((n) => n > 0);
    const dx = (i % size) - size / 2;
    const dy = size / 2 - Math.floor(i / size);
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    expect(deg).toBeGreaterThan(100);
    expect(deg).toBeLessThan(106);
  });
});

describe('computeCie', () => {
  it('neutral white lands on D65', () => {
    const size = 512;
    const r = computeCie(rgba([255, 255, 255]), 1, 1, size, 'rec709', 'xy');
    const i = r.findIndex((n) => n > 0);
    const x = ((i % size) / size) * 0.8;
    const y = ((size - Math.floor(i / size)) / size) * 0.9;
    expect(x).toBeCloseTo(0.3127, 2);
    expect(y).toBeCloseTo(0.329, 2);
  });

  it('pure red lands on the Rec.709 red primary', () => {
    const size = 1024;
    const r = computeCie(rgba([255, 0, 0]), 1, 1, size, 'rec709', 'xy');
    const i = r.findIndex((n) => n > 0);
    const x = ((i % size) / size) * 0.8;
    const y = ((size - Math.floor(i / size)) / size) * 0.9;
    expect(x).toBeCloseTo(0.64, 1);
    expect(y).toBeCloseTo(0.33, 1);
  });

  it('black contributes nothing (no chromaticity defined)', () => {
    const r = computeCie(rgba([0, 0, 0]), 1, 1, 64, 'rec709', 'xy');
    expect(r.every((n) => n === 0)).toBe(true);
  });

  it('u-prime v-prime mode uses its own bounds', () => {
    const size = 512;
    const r = computeCie(rgba([255, 255, 255]), 1, 1, size, 'rec709', 'uv');
    const i = r.findIndex((n) => n > 0);
    const u = ((i % size) / size) * 0.62;
    const v = ((size - Math.floor(i / size)) / size) * 0.6;
    expect(u).toBeCloseTo(0.1978, 2);
    expect(v).toBeCloseTo(0.4683, 2);
  });
});
