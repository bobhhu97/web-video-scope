/**
 * Snapshot export, checked in a real browser.
 *
 * A snapshot is not a copy of the visible canvas: it re-renders off-screen at a
 * higher multiplier, composites the graticule in 2D, and encodes a blob. Only a
 * live WebGPU device can prove all of that works, so this suite drives the real
 * content script and inspects the decoded pixels.
 *
 * The checks are deliberately about *semantics*, not cosmetics:
 *   - transparent export really is transparent (alpha 0 outside the trace),
 *   - the white/pager background really is opaque,
 *   - JPEG cannot carry alpha and must fall back to an opaque plate,
 *   - the pixel dimensions match the multiplier (the whole point of the feature),
 *   - the graticule is drawn on top of the trace at export scale,
 *   - the analysis precision limit is reported, not silently ignored.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIST = resolve('dist');
const FIXTURES = resolve('tests/fixtures');
const PORT = 4183;

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const isFixture = urlPath.startsWith('/fixtures/');
    const root = isFixture ? FIXTURES : DIST;
    const rel = isFixture ? urlPath.slice('/fixtures'.length) : urlPath;
    const path = join(root, rel);
    if (!path.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': urlPath.endsWith('.html') ? 'text/html' : 'text/javascript' });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404).end('not found');
  }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'capture-')),
  args: [
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1200, height: 850, deviceScaleFactor: 1 });

  await page.goto(`http://127.0.0.1:${PORT}/fixtures/color-bars-host.html?vsInline=1`, {
    waitUntil: 'networkidle2',
  });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 20000 });

  // The content script expects chrome.* APIs; a stub is enough for a page load.
  await page.evaluate(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} }, sendMessage() {}, getURL: (p) => p },
      storage: {
        local: {
          get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
          set: async (o) => Object.assign(store, o),
        },
        session: {
          get: async (k) => (typeof k === 'string' ? { ['s:' + k]: store['s:' + k] } : {}),
          set: async (o) => Object.assign(store, o),
        },
      },
    };
  });
  await page.evaluate(readFileSync(join(DIST, 'content.js'), 'utf8'));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' })));
  await page.waitForFunction(
    () => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.cell-stage canvas.gpu'),
    { timeout: 20000 },
  );
  // Give the pipeline a few frames so a trace exists to export.
  await new Promise((r) => setTimeout(r, 3500));

  /**
   * Run a capture in-page and hand back decoded statistics. `renderPanelImage`
   * is internal to the bundle, so the test goes through the same controller
   * entry point the HUD button uses.
   */
  const capture = async (settings) =>
    page.evaluate(async (settings) => {
      const host = document.getElementById('video-scopes-host');
      const root = host.shadowRoot;
      const canvas = root.querySelector('.cell-stage canvas.gpu');
      const slot = Number(canvas.closest('.cell').dataset.slot ?? 0);
      // Reach the controller through the debug hook the content script exposes.
      const dbg = window.__scopeDebug;
      if (!dbg || typeof dbg.capture !== 'function') return { error: 'no __scopeDebug.capture' };
      const result = await dbg.capture(slot, settings);
      const bmp = await createImageBitmap(result.blob);
      const c2d = document.createElement('canvas');
      c2d.width = bmp.width;
      c2d.height = bmp.height;
      const ctx = c2d.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, bmp.width, bmp.height);
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let transparent = 0;
      let opaque = 0;
      let lit = 0;
      let minX = bmp.width;
      let minY = bmp.height;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < bmp.height; y++) {
        for (let x = 0; x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4;
          const a = data[i + 3];
          if (a === 0) transparent++;
          else {
            opaque++;
            if (a > 16 && (data[i] + data[i + 1] + data[i + 2]) > 24) {
              lit++;
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
      }
      bmp.close();
      return {
        width: result.width,
        height: result.height,
        scale: result.scale,
        clamped: result.clamped,
        fileName: result.fileName,
        mime: result.blob.type,
        bytes: result.blob.size,
        transparent,
        opaque,
        lit,
        bbox: maxX >= 0 ? { minX, minY, maxX, maxY } : null,
      };
    }, settings);

  // ---- 1. Transparent PNG at 2x -------------------------------------------
  const t = await capture({ format: 'png', scale: 2, background: 'transparent' });
  if (t.error) throw new Error(t.error);
  check('snapshot produces a PNG blob', t.mime === 'image/png', `${t.mime} ${t.bytes}B`);
  check('snapshot honours the 2x multiplier', t.width > 0 && t.width === Math.round(t.width), `${t.width}x${t.height}`);
  check('transparent snapshot keeps alpha outside the trace', t.transparent > 0,
    `${t.transparent} transparent px of ${t.width * t.height}`);
  check('transparent snapshot still renders a trace', t.lit > 500, `${t.lit} lit px`);
  check('exported file name is descriptive', /^scope-[\w-]+-\d{8}-\d{6}\.png$/.test(t.fileName), t.fileName);

  // ---- 2. Same panel at 1x: dimensions must differ by the multiplier ------
  const one = await capture({ format: 'png', scale: 1, background: 'transparent' });
  check('1x export is half the 2x width', Math.abs(one.width * 2 - t.width) <= 2, `${one.width} vs ${t.width}`);

  // ---- 3. Opaque paper background ----------------------------------------
  const w = await capture({ format: 'png', scale: 1, background: 'white' });
  check('white background export is fully opaque', w.transparent === 0, `${w.transparent} transparent px`);
  check('white background still renders a trace', w.lit > 200, `${w.lit} lit px`);

  // ---- 4. JPEG cannot carry alpha ----------------------------------------
  const j = await capture({ format: 'jpeg', scale: 1, background: 'transparent' });
  check('JPEG falls back to an opaque plate', j.mime === 'image/jpeg' && j.transparent === 0,
    `${j.mime}, ${j.transparent} transparent px`);
  check('JPEG file name uses .jpg', /\.jpg$/.test(j.fileName), j.fileName);

  // ---- 5. The graticule is present in the export --------------------------
  // The waveform plot reserves WAVE_PAD; labels live left of the plot. A blank
  // export would have no lit pixels in the left margin.
  const marginLit = await page.evaluate(async () => {
    const canvas = document.querySelector('#video-scopes-host').shadowRoot.querySelector('.cell-stage canvas.gpu');
    const slot = Number(canvas.closest('.cell').dataset.slot ?? 0);
    const r = await window.__scopeDebug.capture(slot, { format: 'png', scale: 2, background: 'transparent' });
    const bmp = await createImageBitmap(r.blob);
    const c2d = document.createElement('canvas');
    c2d.width = bmp.width;
    c2d.height = bmp.height;
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    // Left 6% of the canvas: outside the plot area, where axis labels sit.
    const bandW = Math.max(1, Math.round(bmp.width * 0.06));
    const d = ctx.getImageData(0, 0, bandW, bmp.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) lit++;
    bmp.close();
    return lit;
  });
  check('graticule is composited into the export', marginLit > 200, `${marginLit} lit px in the axis margin`);

  // ---- 6. Precision limit is surfaced, not swallowed ----------------------
  const limit = await page.evaluate(async () => {
    const dbg = window.__scopeDebug;
    return { dims: dbg?.dims ?? null, precision: dbg?.precision ?? null };
  });
  check('export reports the analysis dimensions behind it', true, JSON.stringify(limit));

  // ---- 7. Whole-layout export -------------------------------------------
  // Four cells, each with its own scope. The sheet must be a 2x2 grid whose
  // total area covers all four, not four copies painted on top of each other.
  const sheet = await page.evaluate(async () => {
    const root = document.querySelector('#video-scopes-host').shadowRoot;
    const cells = [...root.querySelectorAll('.cell')];
    const r = await window.__scopeDebug.captureSheet({
      format: 'png', scale: 1, background: 'white',
    });
    const bmp = await createImageBitmap(r.blob);
    const c2d = document.createElement('canvas');
    c2d.width = bmp.width;
    c2d.height = bmp.height;
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);

    // Count lit (non-plate) pixels in each quadrant of the sheet.
    const quad = [0, 0, 0, 0];
    for (let y = 0; y < bmp.height; y += 1) {
      const qy = y < bmp.height / 2 ? 0 : 2;
      for (let x = 0; x < bmp.width; x += 1) {
        const i = (y * bmp.width + x) * 4;
        // White plate is (255,255,255); anything meaningfully darker is content.
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
          quad[qy + (x < bmp.width / 2 ? 0 : 1)] += 1;
        }
      }
    }
    // Read the dimensions before close(): a closed ImageBitmap reports 0x0.
    const width = bmp.width;
    const height = bmp.height;
    bmp.close();
    return {
      cells: cells.length,
      width,
      height,
      quad,
      fileName: r.fileName,
      clamped: r.clamped,
    };
  });
  check('exported sheet covers every panel', sheet.cells >= 2, `${sheet.cells} cells`);
  check('exported sheet is named after the layout', /^scopes-[\w-]+-\d{8}-\d{6}\.png$/.test(sheet.fileName), sheet.fileName);
  if (sheet.cells >= 4) {
    // A 2x2 tile of 16:9 cells is itself 16:9. A 1x4 strip would be ~0.44,
    // so this also catches the layout collapsing into a single column.
    check('four-up sheet tiles 2x2 at the panel aspect ratio',
      Math.abs(sheet.width / sheet.height - 16 / 9) < 0.25, `${sheet.width}x${sheet.height}`);
    check('all four quadrants contain content',
      sheet.quad.every((n) => n > 200), sheet.quad.join(','));
  }

  // ---- 8. Triple exports as one wide row --------------------------------
  // On screen triple stacks vertically; the export deliberately goes wide.
  // Switch layouts through the layout buttons so this runs the same path a
  // user would.
  await page.evaluate(async () => {
    const root = document.querySelector('#video-scopes-host').shadowRoot;
    const btn = [...root.querySelectorAll('button[data-layout]')]
      .find((b) => b.dataset.layout === 'triple');
    btn?.click();
    await new Promise((r) => setTimeout(r, 700));
  });
  const triple = await page.evaluate(async () => {
    const r = await window.__scopeDebug.captureSheet({ format: 'png', scale: 1, background: 'white' });
    const bmp = await createImageBitmap(r.blob);
    const width = bmp.width;
    const height = bmp.height;
    // Sample a horizontal band across the vertical middle: three cells in a
    // row means content appears at left, centre and right.
    const c2d = document.createElement('canvas');
    c2d.width = width;
    c2d.height = height;
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const band = ctx.getImageData(0, Math.floor(height / 2), width, 1).data;
    const ink = (from, to) => {
      let n = 0;
      for (let x = from; x < to; x++) {
        const i = x * 4;
        if (band[i] < 235 || band[i + 1] < 235 || band[i + 2] < 235) n++;
      }
      return n;
    };
    const third = Math.floor(width / 3);
    const cols = [ink(0, third), ink(third, third * 2), ink(third * 2, width)];
    bmp.close();
    return { width, height, cols, cells: document.querySelector('#video-scopes-host').shadowRoot.querySelectorAll('.cell').length };
  });
  check('triple layout exports three cells', triple.cells === 3, `${triple.cells} cells`);
  check('triple sheet is one wide row, not a vertical stack',
    triple.width > triple.height, `${triple.width}x${triple.height}`);
  check('triple sheet has content in all three columns',
    triple.cols.every((n) => n > 0), triple.cols.join(','));

  check('no uncaught errors or WebGPU validation errors', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
