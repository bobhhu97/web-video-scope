import { describe, expect, it } from 'vitest';
import { LUMA } from '../src/core/color/matrices';
import { renderCie, renderVectorscope, type ScatterPlot } from '../src/gpu/scatter-cpu';

/**
 * The scatter scopes are drawn on the CPU. These tests pin the coordinate
 * mapping and the fact that a plot is non-empty, which is what the GPU path
 * silently failed to produce.
 *
 * Assertions are written against the alpha-weighted centroid rather than a lit
 * pixel count. Each hit is splatted over a small disc so that content collapsing
 * to one bin — a grey ramp on a CIE plot — is still visible, so "exactly one lit
 * pixel" is deliberately not the behaviour anymore.
 */

function frame(px: [number, number, number][]): Uint8Array {
  const out = new Uint8Array(px.length * 4);
  px.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

const litCount = (p: ScatterPlot): number => {
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i]! > 0) n++;
  return n;
};

/** Alpha-weighted centre of all lit pixels. */
function centroid(p: ScatterPlot): { x: number; y: number; total: number } {
  let sx = 0;
  let sy = 0;
  let total = 0;
  for (let i = 3; i < p.data.length; i += 4) {
    const a = p.data[i]!;
    if (a === 0) continue;
    const px = (i - 3) / 4;
    sx += (px % p.width) * a;
    sy += Math.floor(px / p.width) * a;
    total += a;
  }
  return total === 0 ? { x: NaN, y: NaN, total: 0 } : { x: sx / total, y: sy / total, total };
}

/** True when any lit pixel sits within `r` of (x, y). */
function litNear(p: ScatterPlot, x: number, y: number, r = 2): boolean {
  const cx = Math.round(x);
  const cy = Math.round(y);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const qx = cx + dx;
      const qy = cy + dy;
      if (qx < 0 || qx >= p.width || qy < 0 || qy >= p.height) continue;
      if (p.data[(qy * p.width + qx) * 4 + 3]! > 0) return true;
    }
  }
  return false;
}

describe('renderVectorscope', () => {
  it('puts neutral grey at the centre', () => {
    const plot = renderVectorscope(frame([[128, 128, 128]]), 1, 1, 64, 64, LUMA.bt709, 1);
    const c = centroid(plot);
    expect(c.total).toBeGreaterThan(0);
    expect(c.x).toBeCloseTo(32, 0);
    expect(c.y).toBeCloseTo(32, 0);
  });

  it('puts saturated colour away from the centre', () => {
    const plot = renderVectorscope(frame([[255, 0, 0]]), 1, 1, 64, 64, LUMA.bt709, 1);
    const c = centroid(plot);
    expect(c.total).toBeGreaterThan(0);
    expect(Math.hypot(c.x - 32, c.y - 32)).toBeGreaterThan(6);
  });

  it('draws every distinct colour in a colour bar frame', () => {
    const img = frame([
      [255, 255, 255],
      [255, 255, 0],
      [0, 255, 255],
      [0, 255, 0],
      [255, 0, 255],
      [255, 0, 0],
      [0, 0, 255],
      [0, 0, 0],
    ]);
    const plot = renderVectorscope(img, 8, 1, 255, 255, LUMA.bt709, 1);
    // The six chromatic bars must land in at least four separated places at this
    // resolution; white and black collapse to the neutral centre by definition.
    const xs = new Set<number>();
    for (let i = 3; i < plot.data.length; i += 4) {
      if (plot.data[i]! > 0) xs.add(Math.round((((i - 3) / 4) % 255) / 8));
    }
    expect(xs.size).toBeGreaterThanOrEqual(4);
  });

  it('produces a clearly visible alpha for a single hit', () => {
    const plot = renderVectorscope(frame([[200, 100, 50]]), 1, 1, 64, 64, LUMA.bt709, 1);
    let peak = 0;
    for (let i = 3; i < plot.data.length; i += 4) peak = Math.max(peak, plot.data[i]!);
    expect(peak).toBeGreaterThan(200);
    // The hit is splatted into a small disc, so it survives one pixel of scaling.
    expect(litCount(plot)).toBeGreaterThanOrEqual(3);
  });

  it('ignores zoom that would push everything off-canvas', () => {
    const plot = renderVectorscope(frame([[255, 0, 0]]), 1, 1, 64, 64, LUMA.bt709, 40);
    expect(litCount(plot)).toBe(0);
  });
});

describe('renderCie', () => {
  it('draws white at the D65 point, not at a corner', () => {
    const plot = renderCie(frame([[255, 255, 255]]), 1, 1, 200, 200, 'rec709', 'xy');
    const c = centroid(plot);
    expect(c.total).toBeGreaterThan(0);
    // D65 is at (0.3127, 0.329) within bounds 0.8 x 0.9.
    expect(c.x / 200).toBeCloseTo(0.3127 / 0.8, 1);
    expect((200 - c.y) / 200).toBeCloseTo(0.329 / 0.9, 1);
  });

  it('separates the primaries', () => {
    const img = frame([
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
    ]);
    const plot = renderCie(img, 3, 1, 255, 255, 'rec709', 'xy');
    // Rec.709 primaries in xy, mapped through bounds 0..0.8 / 0..0.9.
    expect(litNear(plot, (0.64 / 0.8) * 255, 255 - (0.33 / 0.9) * 255)).toBe(true);
    expect(litNear(plot, (0.3 / 0.8) * 255, 255 - (0.6 / 0.9) * 255)).toBe(true);
    expect(litNear(plot, (0.15 / 0.8) * 255, 255 - (0.06 / 0.9) * 255)).toBe(true);
  });

  it('ignores black, which has no chromaticity', () => {
    const plot = renderCie(frame([[0, 0, 0]]), 1, 1, 64, 64, 'rec709', 'xy');
    expect(litCount(plot)).toBe(0);
  });

  it('keeps RGB and alpha separate, as putImageData expects', () => {
    // The earlier version multiplied RGB by alpha, so a sparse bin with a 0.008
    // alpha landed at 6e-5 and the plot vanished. Non-premultiplied output means
    // RGB depends only on chromaticity, never on how many pixels hit the bin —
    // so every lit pixel in a single-colour frame must share one RGB value even
    // though the disc has a soft alpha edge.
    const plot = renderCie(frame([[255, 255, 255]]), 1, 1, 200, 200, 'rec709', 'xy');
    const colors = new Set<string>();
    let lit = 0;
    for (let i = 0; i < plot.data.length; i += 4) {
      if (plot.data[i + 3] === 0) continue;
      lit++;
      colors.add(`${plot.data[i]},${plot.data[i + 1]},${plot.data[i + 2]}`);
      expect(Math.max(plot.data[i]!, plot.data[i + 1]!, plot.data[i + 2]!)).toBeGreaterThan(100);
    }
    expect(lit).toBeGreaterThan(3);
    expect(colors.size).toBe(1);
  });

  it('honours the u-prime v-prime bounds', () => {
    const plot = renderCie(frame([[255, 255, 255]]), 1, 1, 200, 200, 'rec709', 'uv');
    const c = centroid(plot);
    expect(c.total).toBeGreaterThan(0);
    expect(c.x / 200).toBeCloseTo(0.1978 / 0.62, 1);
    expect((200 - c.y) / 200).toBeCloseTo(0.4683 / 0.6, 1);
  });
});
