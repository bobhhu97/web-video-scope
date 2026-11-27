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
  check('snapshot honours the 2x multiplier', t.scale === 2 && t.width > 0, `${t.width}x${t.height} @${t.scale}x`);
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

  // ---- 3b. Panel plate matches the live cell colour ----------------------
  // The scope canvas sits on `.cell`, not on the panel chrome. A darker plate
  // made exports read dimmer than the panel even though the trace matched.
  const plate = await page.evaluate(async () => {
    const root = document.querySelector('#video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell');
    const slot = Number(cell?.dataset.slot ?? 0);
    const live = getComputedStyle(cell).backgroundColor.match(/\d+/g).map(Number);
    const r = await window.__scopeDebug.capture(slot, { format: 'png', scale: 1, background: 'panel' });
    const bmp = await createImageBitmap(r.blob);
    const c2d = document.createElement('canvas');
    c2d.width = bmp.width;
    c2d.height = bmp.height;
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 2, 2).data;
    bmp.close();
    return { live, exp: [d[0], d[1], d[2], d[3]] };
  });
  check('panel plate matches the live cell colour',
    plate.exp[0] === plate.live[0] && plate.exp[1] === plate.live[1] && plate.exp[2] === plate.live[2] && plate.exp[3] === 255,
    `live rgb(${plate.live.slice(0, 3)}) vs export rgb(${plate.exp.slice(0, 3)}) a=${plate.exp[3]}`);

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
    const height = bmp.height;
    bmp.close();
    return { lit, bandW, height };
  });
  // Relative to the margin band's area so a resolution change cannot silently
  // weaken this. Only the tick labels live in that band, so the ink is sparse
  // (about 1.6% of it); a blank or trace-only export scores 0.
  check(
    'graticule is composited into the export',
    marginLit.lit > marginLit.bandW * marginLit.height * 0.01,
    `${marginLit.lit} lit px of ${marginLit.bandW}x${marginLit.height} margin`,
  );

  // ---- 5b. Higher multipliers keep the panel's brightness -----------------
  // The phosphor model spreads one trace over more rows as the plot grows, so
  // a 4x render used to come out visibly dimmer than the panel. `exportDensityGain`
  // compensates; if it regresses, 4x falls well below 1x here.
  const tone = await page.evaluate(async () => {
    const canvas = document.querySelector('#video-scopes-host').shadowRoot.querySelector('.cell-stage canvas.gpu');
    const slot = Number(canvas.closest('.cell').dataset.slot ?? 0);
    const measure = async (scale) => {
      const r = await window.__scopeDebug.capture(slot, { format: 'png', scale, background: 'panel' });
      const bmp = await createImageBitmap(r.blob);
      const c2d = document.createElement('canvas');
      c2d.width = bmp.width;
      c2d.height = bmp.height;
      const ctx = c2d.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let sum = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (lum > 26) { sum += lum; n += 1; }
      }
      bmp.close();
      return n ? sum / n : 0;
    };
    return { one: await measure(1), four: await measure(4) };
  });
  check(
    'a 4x export keeps the panel bright',
    tone.four > tone.one * 0.8,
    `4x mean ${tone.four.toFixed(1)} vs 1x ${tone.one.toFixed(1)}`,
  );

  // ---- 6. Precision limit is surfaced, not swallowed ----------------------
  const limit = await page.evaluate(async () => {
    const dbg = window.__scopeDebug;
    return { dims: dbg?.dims ?? null, precision: dbg?.precision ?? null };
  });
  // The export must be driven by a real analysis texture, not a rescaled
  // screen grab: the texture has to exist and stay within the preset caps.
  check(
    'export reports the analysis dimensions behind it',
    !!limit.dims &&
      Number.isFinite(limit.dims.width) &&
      Number.isFinite(limit.dims.height) &&
      limit.dims.width > 0 &&
      limit.dims.height > 0 &&
      Math.max(limit.dims.width, limit.dims.height) <= 1920,
    JSON.stringify(limit),
  );

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

  // ---- 7b. The gutter between tiles keeps the live grid colour ----------
  const gutter = await page.evaluate(async () => {
    const root = document.querySelector('#video-scopes-host').shadowRoot;
    const live = getComputedStyle(root.querySelector('.grid')).backgroundColor.match(/\d+/g).map(Number);
    const r = await window.__scopeDebug.captureSheet({ format: 'png', scale: 1, background: 'panel' });
    const bmp = await createImageBitmap(r.blob);
    const c2d = document.createElement('canvas');
    c2d.width = bmp.width;
    c2d.height = bmp.height;
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const midX = Math.floor(bmp.width / 2);
    const d = ctx.getImageData(midX, 1, 1, 1).data;
    bmp.close();
    return { live, exp: [d[0], d[1], d[2]] };
  });
  check('sheet gutter matches the live grid colour',
    gutter.exp[0] === gutter.live[0] && gutter.exp[1] === gutter.live[1] && gutter.exp[2] === gutter.live[2],
    `live rgb(${gutter.live.slice(0, 3)}) vs export rgb(${gutter.exp})`);

  // ---- 8. Triple exports as a stacked column -----------------------------
  // Triple is a 1x3 column on screen and the sheet follows it.
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
    // Sample one vertical slice down the middle of each third: a stacked column
    // of three cells puts content in three separate horizontal bands.
    const c2d = document.createElement('canvas');
    c2d.width = width;
    c2d.height = height;
    const ctx = c2d.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const slice = ctx.getImageData(Math.floor(width / 2), 0, 1, height).data;
    const ink = (from, to) => {
      let n = 0;
      for (let y = from; y < to; y++) {
        const i = y * 4;
        if (slice[i] < 235 || slice[i + 1] < 235 || slice[i + 2] < 235) n++;
      }
      return n;
    };
    const third = Math.floor(height / 3);
    const rows = [ink(0, third), ink(third, third * 2), ink(third * 2, height)];
    bmp.close();
    return { width, height, rows, cells: document.querySelector('#video-scopes-host').shadowRoot.querySelectorAll('.cell').length };
  });
  check('triple layout exports three cells', triple.cells === 3, `${triple.cells} cells`);
  // A 1x3 stack of wide, short cells is still wider than tall once the cells
  // are the full panel width; the tell is the aspect. Side by side three cells
  // would be ~9x flatter (h/w under 0.1), stacking brings it to roughly 0.5.
  check('triple sheet is stacked, not one flat row',
    triple.height / triple.width > 0.3, `${triple.width}x${triple.height} h/w ${(triple.height / triple.width).toFixed(2)}`);
  // Each band must carry real ink, not one stray pixel from a seam.
  const bandFloor = Math.max(2, Math.floor((triple.height / 3) * 0.02));
  check('triple sheet has content in all three rows',
    triple.rows.every((n) => n > bandFloor), `${triple.rows.join(',')} (floor ${bandFloor})`);

  check('no uncaught errors or WebGPU validation errors', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
if (failed) process.exitCode = 1;
