/**
 * Generates the extension icons as real PNG files.
 *
 * The chrome-extensions skill is explicit: referencing icon files that do not
 * exist makes the extension fail to load. Generating them from one source of
 * truth avoids the "all three sizes point at one image" mistake.
 *
 * The mark is a scope graticule: a rounded square, an IRE-style grid, and a
 * waveform trace rising left to right.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('public/icons');
mkdirSync(OUT, { recursive: true });

/** Minimal PNG encoder: 8-bit RGBA, one IDAT. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/** Draw the mark at an arbitrary size, using supersampling for clean edges. */
function drawIcon(size) {
  const SS = 4; // supersample factor
  const S = size * SS;
  const rgba = Buffer.alloc(S * S * 4);

  const put = (x, y, r, g, b, a) => {
    const i = (y * S + x) * 4;
    // Premultiplied source-over onto opaque background handled by caller.
    const src = a / 255;
    rgba[i] = Math.round(rgba[i] * (1 - src) + r * src);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - src) + g * src);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - src) + b * src);
    rgba[i + 3] = Math.round(rgba[i + 3] * (1 - src) + 255 * src);
  };

  // Rounded panel background.
  const radius = S * 0.22;
  const inset = S * 0.02;
  const insideRounded = (x, y) => {
    const x0 = inset, y0 = inset, x1 = S - inset, y1 = S - inset;
    if (x < x0 || y < y0 || x >= x1 || y >= y1) return false;
    const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
    const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!insideRounded(x, y)) continue;
      const i = (y * S + x) * 4;
      rgba[i] = 13;
      rgba[i + 1] = 17;
      rgba[i + 2] = 23;
      rgba[i + 3] = 255;
    }
  }

  // Graticule: 5 horizontal rules, the 0 and 100 lines brighter.
  const padX = S * 0.16;
  const padY = S * 0.18;
  const plotH = S - padY * 2;
  for (let k = 0; k <= 4; k++) {
    const gy = Math.round(padY + (plotH * k) / 4);
    const bright = k === 0 || k === 4;
    for (let x = Math.round(padX); x < S - padX; x++) {
      for (let t = 0; t < Math.max(1, Math.round(S * 0.006)); t++) {
        put(x, gy + t, bright ? 90 : 38, bright ? 116 : 50, bright ? 140 : 62, 255);
      }
    }
  }

  // Waveform trace: a rising staircase, 4 steps.
  const step = Math.round(S * 0.014);
  const levels = [0.78, 0.6, 0.42, 0.22];
  const segW = (S - padX * 2) / levels.length;
  levels.forEach((lvl, idx) => {
    const y0 = Math.round(padY + plotH * lvl);
    const x0 = Math.round(padX + segW * idx);
    const x1 = Math.round(padX + segW * (idx + 1));
    for (let x = x0; x < x1; x++) {
      for (let t = 0; t < step; t++) put(x, y0 + t, 124, 255, 155, 255);
    }
    // Vertical join.
    if (idx < levels.length - 1) {
      const yNext = Math.round(padY + plotH * levels[idx + 1]);
      for (let y = Math.min(y0, yNext); y <= Math.max(y0, yNext); y++) {
        for (let t = 0; t < step; t++) put(x1 - 1 - t, y, 124, 255, 155, 255);
      }
    }
  });

  // Downsample.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePng(size, size, drawIcon(size));
  const path = resolve(OUT, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${size}x${size}, ${png.length} bytes)`);
}
