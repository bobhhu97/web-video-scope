/**
 * Verifies the three things reported against the CIE panel and the layout UI:
 *  1. the diagram is not distorted (1:1 axis scale, measured from pixels)
 *  2. the CIE panel responds to zoom / coordinate changes
 *  3. each cell in a multi-panel layout can be reassigned
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const FIX = resolve('tests/fixtures');
const server = createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(FIX, 'gradient-host.html')));
  } catch { res.writeHead(404).end(); }
});
await new Promise((k) => server.listen(4363, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'cieui-')),
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=2'],
});
try {
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  await page.setViewport({ width: 1400, height: 950, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4363/x?vsInline=1', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });
  await page.evaluate(() => {
    const s = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        local: { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o) },
        session: { get: async (k) => ({ [k]: s['s:' + k] }),
          set: async (o) => { for (const [k, v] of Object.entries(o)) s['s:' + k] = v; } },
      },
    };
  });
  await page.evaluate(readFileSync(join(DIST, 'content.js'), 'utf8'));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' })));
  await page.waitForFunction(() => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.cell'), { timeout: 15000 });
  await page.evaluate(() => { const h = document.getElementById('video-scopes-host'); h.style.width = '760px'; h.style.height = '600px'; });
  await new Promise((r) => setTimeout(r, 1500));

  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    Array.from(root.querySelectorAll('#layouts button')).find((b) => b.textContent === '1').click();
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    Array.from(root.querySelectorAll('#modes button')).find((b) => b.textContent === 'CIE').click();
  });
  await new Promise((r) => setTimeout(r, 3500));

  /**
   * Measure axis anisotropy from the Rec.709 triangle.
   *
   * An earlier version of this check took the bounding box of "saturated" pixels
   * and compared it to the locus span. That measured nothing useful: the coloured
   * header text and axis labels are also saturated, so the box grew to include
   * them and the ratio was meaningless (it reported 1.28 on a diagram that was
   * actually correct). The triangle is reliable — its stroke colour appears
   * nowhere else, and its blue and red vertices are the leftmost and rightmost
   * points of the shape, so an x-extreme scan cannot confuse them with the label.
   */
  const measureTriangle = () => page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const grat = root.querySelector('.cell canvas.grat');
    let a = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = await createImageBitmap(grat);
      const oc = new OffscreenCanvas(b.width, b.height);
      const x = oc.getContext('2d');
      x.drawImage(b, 0, 0);
      a = { w: b.width, h: b.height, d: x.getImageData(0, 0, b.width, b.height).data };
      let any = 0;
      for (let k = 3; k < a.d.length; k += 4) if (a.d[k] > 0) any++;
      if (any > 100) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const isTri = (i) => {
      const r = a.d[i], g = a.d[i + 1], bl = a.d[i + 2];
      return Math.abs(r - 0x7f) < 26 && Math.abs(g - 0xa8) < 26 && Math.abs(bl - 0xd8) < 26;
    };
    let leftX = a.w, leftY = 0, rightX = -1, rightY = 0, topY = a.h;
    for (let cy = 0; cy < a.h; cy++) {
      for (let cx = 0; cx < a.w; cx++) {
        if (!isTri((cy * a.w + cx) * 4)) continue;
        if (cx < leftX) { leftX = cx; leftY = cy; }
        if (cx > rightX) { rightX = cx; rightY = cy; }
        if (cy < topY) topY = cy;
      }
    }
    return { w: a.w, h: a.h, leftX, leftY, rightX, rightY, topY };
  });

  const tri = await measureTriangle();
  // Rec.709: blue (0.15, 0.06) leftmost, red (0.64, 0.33) rightmost.
  const scaleX = (tri.rightX - tri.leftX) / (0.64 - 0.15);
  const scaleY = (tri.leftY - tri.rightY) / (0.33 - 0.06);
  const anisotropy = scaleX / scaleY;
  check('CIE axes have equal scale (diagram not stretched)', Math.abs(anisotropy - 1) < 0.05,
    `x ${scaleX.toFixed(0)} px/unit vs y ${scaleY.toFixed(0)} px/unit, anisotropy ${anisotropy.toFixed(3)}`);

  /**
   * The clearest test of "not distorted": the drawn grid squares must be square.
   * Gridline spacing in x and y is measured directly from pixels, at two panel
   * shapes. This is what a user sees, and it needs no knowledge of the code.
   */
  const measureGrid = () => page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const grat = root.querySelector('.cell canvas.grat');
    let a = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bm = await createImageBitmap(grat);
      const oc = new OffscreenCanvas(bm.width, bm.height);
      const x = oc.getContext('2d');
      x.drawImage(bm, 0, 0);
      a = { w: bm.width, h: bm.height, d: x.getImageData(0, 0, bm.width, bm.height).data };
      let any = 0;
      for (let k = 3; k < a.d.length; k += 4) if (a.d[k] > 0) any++;
      if (any > 100) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // GRID is #1b232b. Sample near the top of the plot for verticals (few other
    // features there) and near the left for horizontals (before the triangles).
    const isGrid = (i) => {
      const r = a.d[i], g = a.d[i + 1], b = a.d[i + 2];
      return Math.abs(r - 0x1b) < 12 && Math.abs(g - 0x23) < 12 && Math.abs(b - 0x2b) < 12;
    };
    // The plot is letterboxed, so scan many lines and keep the one that actually
    // crosses the grid. Sampling one fixed fraction of the canvas landed in the
    // empty margin on a wide panel and reported "no gridlines".
    const gapsAlong = (vals) => {
      const hits = [];
      for (let k = 1; k < vals.length; k++) {
        if (vals[k] && !vals[k - 1]) hits.push(k);
      }
      return hits.slice(1).map((v, i) => v - hits[i]).filter((g) => g > 20);
    };
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

    let bestV = [];
    for (let fy = 0.04; fy <= 0.96; fy += 0.04) {
      const row = Math.floor(a.h * fy);
      const vals = Array.from({ length: a.w }, (_, cx) => isGrid((row * a.w + cx) * 4));
      const g = gapsAlong(vals);
      if (g.length > bestV.length) bestV = g;
      if (bestV.length >= 4) break;
    }
    let bestH = [];
    for (let fx = 0.04; fx <= 0.96; fx += 0.04) {
      const col = Math.floor(a.w * fx);
      const vals = Array.from({ length: a.h }, (_, cy) => isGrid((cy * a.w + col) * 4));
      const g = gapsAlong(vals);
      if (g.length > bestH.length) bestH = g;
      if (bestH.length >= 4) break;
    }
    return { v: avg(bestV), h: avg(bestH), vn: bestV.length, hn: bestH.length };
  });

  const gridWide = await measureGrid();
  check('the drawn grid is square in a wide panel',
    gridWide.vn >= 3 && gridWide.hn >= 3 && Math.abs(gridWide.v / gridWide.h - 1) < 0.05,
    `x gap ${gridWide.v.toFixed(1)}px vs y gap ${gridWide.h.toFixed(1)}px, ratio ` +
      `${(gridWide.v / gridWide.h).toFixed(3)}`);

  // Same at a tall panel shape: the letterbox must switch axes, not stretch.
  await page.evaluate(() => { const h = document.getElementById('video-scopes-host'); h.style.width = '460px'; h.style.height = '740px'; });
  await new Promise((r) => setTimeout(r, 3000));
  const gridTall = await measureGrid();
  check('the drawn grid is square in a tall panel',
    gridTall.vn >= 3 && gridTall.hn >= 3 && Math.abs(gridTall.v / gridTall.h - 1) < 0.05,
    `x gap ${gridTall.v.toFixed(1)}px vs y gap ${gridTall.h.toFixed(1)}px, ratio ` +
      `${(gridTall.v / gridTall.h).toFixed(3)}`);
  await page.evaluate(() => { const h = document.getElementById('video-scopes-host'); h.style.width = '760px'; h.style.height = '600px'; });
  await new Promise((r) => setTimeout(r, 2500));

  // Zoom must change the drawn diagram.
  const setZoom = async (v) => {
    await page.evaluate((val) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const el = root.getElementById('zoom');
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, v);
    await new Promise((r) => setTimeout(r, 3000));
  };
  const z1 = await measureTriangle();
  const z1Scale = (z1.rightX - z1.leftX) / 0.49;
  await setZoom('4');
  const z4 = await measureTriangle();
  const z4Scale = (z4.rightX - z4.leftX) / 0.49;
  // At zoom 4 the triangle's vertices are clipped by the canvas, so the measured
  // span understates the true 4x magnification (it read 2.45x). Any factor well
  // above 1 still distinguishes "zoomed" from "did nothing", which is the point.
  check('CIE zoom actually zooms the diagram', z4Scale > z1Scale * 2,
    `scale ${z1Scale.toFixed(0)} -> ${z4Scale.toFixed(0)} px/unit ` +
      `(${(z4Scale / z1Scale).toFixed(2)}x measured, clipped by the canvas)`);
  await setZoom('1');

  // Coordinate system switch must change the diagram.
  const before = await measureTriangle();
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const el = root.getElementById('coord');
    el.value = 'uv';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 3000));
  const afterUv = await measureTriangle();
  const moved =
    Math.abs(afterUv.leftX - before.leftX) > 2 ||
    Math.abs(afterUv.leftY - before.leftY) > 2 ||
    Math.abs(afterUv.rightX - before.rightX) > 2;
  check("switching xy to u'v' redraws the diagram", moved,
    `blue vertex ${before.leftX},${before.leftY} -> ${afterUv.leftX},${afterUv.leftY}`);
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const el = root.getElementById('coord');
    el.value = 'xy';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 2000));

  // Axes: the graticule must now carry tick labels.
  const axisInfo = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const grat = root.querySelector('.cell canvas.grat');
    const b = await createImageBitmap(grat);
    const oc = new OffscreenCanvas(b.width, b.height);
    const x = oc.getContext('2d');
    x.drawImage(b, 0, 0);
    const d = x.getImageData(0, 0, b.width, b.height).data;
    // Count text-ish pixels in the bottom strip and the left strip.
    let bottom = 0, left = 0;
    const bottomStart = Math.floor(b.height * 0.90);
    for (let cy = bottomStart; cy < b.height; cy++) {
      for (let cx = 0; cx < b.width; cx++) {
        const i = (cy * b.width + cx) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 150) bottom++;
      }
    }
    for (let cy = 0; cy < b.height; cy++) {
      for (let cx = 0; cx < 26; cx++) {
        const i = (cy * b.width + cx) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 150) left++;
      }
    }
    return { bottom, left };
  });
  check('CIE draws numeric tick labels along the bottom', axisInfo.bottom > 120, `${axisInfo.bottom} px`);
  check('CIE draws numeric tick labels down the left', axisInfo.left > 80, `${axisInfo.left} px`);

  // Per-cell reassignment in the four-up layout.
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    Array.from(root.querySelectorAll('#layouts button')).find((b) => b.textContent === '4').click();
  });
  await new Promise((r) => setTimeout(r, 3000));
  const cellState = () => page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    return Array.from(root.querySelectorAll('.cell')).map((c) => ({
      mode: c.dataset.mode,
      picker: c.querySelector('select.tag')?.value,
      options: (c.querySelector('select.tag')?.options.length) ?? 0,
    }));
  });
  const before4 = await cellState();
  check('every cell has its own scope picker', before4.length === 4 && before4.every((c) => c.options === 5),
    before4.map((c) => `${c.mode}(${c.options})`).join(' '));

  // Put CIE in slot 0, which currently holds something else.
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const sel = root.querySelectorAll('select.tag')[0];
    sel.value = 'cie';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 3500));
  const after4 = await cellState();
  check('reassigning a cell changes that cell\'s scope', after4[0].mode === 'cie',
    `slot0 ${before4[0].mode} -> ${after4[0].mode}`);
  check('the displaced scope moves to the old slot instead of duplicating',
    new Set(after4.map((c) => c.mode)).size === 4,
    after4.map((c) => c.mode).join(', '));
  check('the picker reflects the new assignment', after4[0].picker === 'cie', after4[0].picker);

  await page.screenshot({ path: resolve('docs/screenshots/layout-cell-pickers.png') });
  check('no errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
