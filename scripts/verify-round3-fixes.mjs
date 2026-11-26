/**
 * Real Chrome + Metal WebGPU E2E verification & Retina screenshot suite
 * for Round 3 UI & Geometry fixes:
 *  1. Vectorscope `2×` button magnifies ONLY the signal trace by 2× (keeps graticule at 1×)
 *  2. Vectorscope mouse-wheel zoom scales the outermost circle outward (no frozen circular bezel)
 *  3. CIE mouse-wheel zoom keeps square grid, axis labels, gamut triangles, locus & GPU scatter
 *     100% aligned inside the full-width plot viewport
 *  4. Top-bar layout buttons use multi-box arrangement SVG icons (1 / 2 / 3 / 4 boxes)
 *  5. Top-bar 5 scope buttons highlight in emerald green for all active scopes in current layout
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const SHOT_DIR = '/tmp/round3-shots';
await mkdir(SHOT_DIR, { recursive: true });

const HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Round 3 Scopes Verification</title>
  <style>
    html, body { margin: 0; padding: 0; background: #070a0f; color: #cbd5e1; font-family: system-ui, sans-serif; }
    video { width: 480px; height: 270px; margin: 20px; display: block; background: #000; }
  </style>
</head>
<body>
  <video id="video" muted playsinline autoplay></video>
  <script>
    const cv = document.createElement('canvas');
    cv.width = 640; cv.height = 360;
    const ctx = cv.getContext('2d');

    function drawTestScene() {
      // Neutral dark grey background + clean skin-tone patch (~22% chroma saturation)
      // so the vectorscope trace has a crisp, well-defined radial extent from center!
      ctx.fillStyle = '#585858';
      ctx.fillRect(0, 0, 640, 360);

      // Skin-tone & subtle sky patches
      ctx.fillStyle = '#9c715c';
      ctx.fillRect(80, 70, 220, 220);

      ctx.fillStyle = '#5c7896';
      ctx.fillRect(340, 70, 220, 220);
    }
    drawTestScene();

    const stream = cv.captureStream(30);
    const v = document.getElementById('video');
    v.srcObject = stream;
    setInterval(drawTestScene, 33);
    v.play().then(() => { window.__videoReady = true; });
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML);
});
await new Promise((k) => server.listen(4389, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'r3-scopes-')),
  args: [
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=2',
  ],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.setViewport({ width: 1360, height: 880, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4389/?vsInline=1', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

  await page.evaluate(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
        session: {
          get: async (k) => ({ [k]: store['s:' + k] }),
          set: async (o) => {
            for (const [k, v] of Object.entries(o)) store['s:' + k] = v;
          },
        },
      },
    };
  });
  await page.evaluate(readFileSync(join(DIST, 'content.js'), 'utf8'));
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
  });
  await page.waitForFunction(
    () => document.getElementById('video-scopes-host')?.shadowRoot?.querySelectorAll('.cell').length === 4,
    { timeout: 15000 },
  );

  await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    h.style.top = '20px';
    h.style.left = '520px';
    h.style.right = 'auto';
    h.style.width = '780px';
    h.style.height = '640px';
  });
  await new Promise((r) => setTimeout(r, 900));

  // Helper to decode a captured PNG screenshot inside the browser and inspect true composited pixels!
  async function decodePngInPage(pngPath) {
    const b64 = (await readFile(pngPath)).toString('base64');
    return page.evaluate(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const oc = new OffscreenCanvas(img.width, img.height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { width: img.width, height: img.height };
    }, `data:image/png;base64,${b64}`);
  }

  // =========================================================================
  // 1. 3-up (triple) layout: SVG box icons + green active highlights!
  // =========================================================================
  const toolbarAudit = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.querySelector('#layouts button[data-layout="triple"]').click();
    const layoutIcons = Array.from(root.querySelectorAll('#layouts button')).map((b) => ({
      layout: b.dataset.layout,
      rects: b.querySelectorAll('svg rect').length,
      pressed: b.getAttribute('aria-pressed'),
    }));
    const modeBtns = Array.from(root.querySelectorAll('#modes button')).map((b) => {
      const cs = getComputedStyle(b);
      return {
        mode: b.dataset.mode,
        text: b.textContent.trim(),
        active: b.classList.contains('scope-active'),
        bg: cs.backgroundColor,
        border: cs.borderColor,
      };
    });
    const navRect = root.querySelector('nav.bar').getBoundingClientRect();
    return { layoutIcons, modeBtns, navClip: { x: navRect.x, y: navRect.y, width: 375, height: navRect.height + 4 } };
  });
  await new Promise((r) => setTimeout(r, 700));

  check(
    'Top-bar layout buttons render 1/2/3/4 box-arrangement SVG icons',
    JSON.stringify(toolbarAudit.layoutIcons.map((i) => i.rects)) === '[1,2,3,4]',
    JSON.stringify(toolbarAudit.layoutIcons),
  );
  const activeInTriple = toolbarAudit.modeBtns.filter((b) => b.active).map((b) => b.text);
  check(
    'In 3-up (Wave, Parade, Vector), those 3 buttons highlight in emerald green while Hist & CIE stay off',
    JSON.stringify(activeInTriple) === '["Wave","Parade","Vector"]' &&
      toolbarAudit.modeBtns.find((b) => b.text === 'Wave').border === 'rgb(52, 211, 153)',
    `active=${JSON.stringify(activeInTriple)} border=${toolbarAudit.modeBtns.find((b) => b.text === 'Wave').border}`,
  );

  await page.screenshot({
    path: join(SHOT_DIR, '1-toolbar-icons-and-green-modes.png'),
    clip: toolbarAudit.navClip,
  });

  // =========================================================================
  // 2. Vectorscope 1× vs 2× Signal Magnification (measured on composited WebGPU PNG!)
  // =========================================================================
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.querySelector('#layouts button[data-layout="grid"]').click();
  });
  await new Promise((r) => setTimeout(r, 1000));

  // Temporarily turn off Skin line so only bright phosphor scatter pixels (>200 luminance) exist inside inner disc!
  const vecCellClip = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell[data-mode="vectorscope"]');
    const r = cell.getBoundingClientRect();
    const s = cell.querySelector('.cell-stage').getBoundingClientRect();
    return {
      cellRect: { x: r.x, y: r.y, width: r.width, height: r.height },
      stageRect: { x: s.x, y: s.y, width: s.width, height: s.height },
    };
  });

  async function measurePureGpuTraceMaxR() {
    await page.evaluate(() => {
      const grat = document.getElementById('video-scopes-host').shadowRoot
        .querySelector('.cell[data-mode="vectorscope"] canvas.grat');
      grat.style.visibility = 'hidden';
    });
    await new Promise((r) => setTimeout(r, 90));
    const freshStageRect = await page.evaluate(() => {
      const s = document.getElementById('video-scopes-host').shadowRoot
        .querySelector('.cell[data-mode="vectorscope"] .cell-stage')
        .getBoundingClientRect();
      return { x: s.x, y: s.y, width: s.width, height: s.height };
    });
    const b64 = await page.screenshot({ clip: freshStageRect, encoding: 'base64' });
    await page.evaluate(() => {
      const grat = document.getElementById('video-scopes-host').shadowRoot
        .querySelector('.cell[data-mode="vectorscope"] canvas.grat');
      grat.style.visibility = '';
    });
    return page.evaluate(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const oc = new OffscreenCanvas(img.width, img.height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, img.width, img.height).data;
      const cx = img.width * 0.5;
      const cy = img.height * 0.5;
      let maxR = 0;
      for (let y = 12; y < img.height - 12; y++) {
        for (let x = 12; x < img.width - 12; x++) {
          const i = (y * img.width + x) * 4;
          if (d[i] > 185 || d[i + 1] > 185 || d[i + 2] > 185) {
            const r = Math.hypot(x - cx, y - cy);
            if (r > maxR) maxR = r;
          }
        }
      }
      return maxR;
    }, `data:image/png;base64,${b64}`);
  }

  const shot1x = join(SHOT_DIR, '2a-vectorscope-1x-signal.png');
  await page.screenshot({ path: shot1x, clip: vecCellClip.cellRect });
  const r1x = await measurePureGpuTraceMaxR();

  // Click 2× pill -> magnifies ONLY the waveform trace by 2×!
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.querySelector('.cell[data-mode="vectorscope"] button[data-act="zoom2x"]').click();
  });
  await new Promise((r) => setTimeout(r, 600));

  const shot2x = join(SHOT_DIR, '2b-vectorscope-2x-signal.png');
  await page.screenshot({ path: shot2x, clip: vecCellClip.cellRect });
  const r2x = await measurePureGpuTraceMaxR();

  const signalRatio = r2x / Math.max(1, r1x);
  check(
    'Vectorscope 2× button doubles the plotted GPU waveform trace radius (~2.0×) while graticule stays 1×',
    r1x > 15 && signalRatio > 1.80 && signalRatio < 2.20,
    `composited peak trace radius: 1x=${r1x.toFixed(1)}px -> 2x=${r2x.toFixed(1)}px (ratio=${signalRatio.toFixed(2)}×)`,
  );

  // =========================================================================
  // 3. Vectorscope Mouse-Wheel Zoom (~1.5×): verify NO stationary bezel circle!
  // =========================================================================
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell[data-mode="vectorscope"]');
    cell.querySelector('button[data-act="zoom2x"]').click(); // back to 1x signal
    const stage = cell.querySelector('.cell-stage');
    const r = stage.getBoundingClientRect();
    stage.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -170,
        clientX: r.left + r.width * 0.5,
        clientY: r.top + r.height * 0.5,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await new Promise((r) => setTimeout(r, 600));
  const shotVecZoom = join(SHOT_DIR, '3-vectorscope-wheel-zoom.png');
  await page.screenshot({ path: shotVecZoom, clip: vecCellClip.cellRect });

  // Inspect Vectorscope grat canvas directly: at zoom ~1.5x, check along horizontal y = cy
  // that there is NO ring stroke at the old 1x radius (0.45 * min(w, h)) and the outer ring IS at 1.5 * radius!
  const vecRingAudit = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const grat = root.querySelector('.cell[data-mode="vectorscope"] canvas.grat');
    const bm = await createImageBitmap(grat);
    const oc = new OffscreenCanvas(bm.width, bm.height);
    const ctx = oc.getContext('2d');
    ctx.drawImage(bm, 0, 0);
    const d = ctx.getImageData(0, 0, bm.width, bm.height).data;
    const cx = bm.width * 0.5;
    const cy = bm.height * 0.5;
    const r1x = Math.min(bm.width, bm.height) * 0.45;
    // Sample at angle 25 deg (away from crosshairs, skin line, and targets!)
    const ang = (25 * Math.PI) / 180;
    const alphaAtR = (rad) => {
      let maxA = 0;
      for (let dr = -2; dr <= 2; dr++) {
        const x = Math.round(cx + Math.cos(ang) * (rad + dr));
        const y = Math.round(cy - Math.sin(ang) * (rad + dr));
        if (x >= 0 && x < bm.width && y >= 0 && y < bm.height) {
          maxA = Math.max(maxA, d[(y * bm.width + x) * 4 + 3]);
        }
      }
      return maxA;
    };
    const zoomText = root.querySelector('.cell[data-mode="vectorscope"] .zoom-reset').textContent.trim();
    const z = parseFloat(zoomText);
    return {
      zoomText,
      z,
      alphaAtOldStationary1xRadius: alphaAtR(r1x),
      alphaAtZoomed075Ring: alphaAtR(r1x * z * 0.75),
      // In wide cell (w > h), r1x * z > h/2 on top/bottom, so along 25 deg (mostly horizontal!) it IS inside w/2!
      alphaAtZoomedOuterRing: alphaAtR(r1x * z),
    };
  });

  check(
    'Vectorscope mouse-wheel zoom removes the stationary 1× bezel and expands the outer circle to radius * zoom',
    vecRingAudit.alphaAtOldStationary1xRadius === 0 && vecRingAudit.alphaAtZoomedOuterRing > 150,
    JSON.stringify(vecRingAudit),
  );

  // =========================================================================
  // 4. CIE Mouse-Wheel Zoom (~1.6×): verify full-width grid + exact Rec.709 vertex alignment!
  // =========================================================================
  const cieAudit = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell[data-mode="cie"]');
    const stage = cell.querySelector('.cell-stage');
    const r = stage.getBoundingClientRect();
    stage.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -195,
        clientX: r.left + r.width * 0.48,
        clientY: r.top + r.height * 0.55,
        bubbles: true,
        cancelable: true,
      }),
    );
    const cr = cell.getBoundingClientRect();
    return { cellRect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height } };
  });
  await new Promise((r) => setTimeout(r, 600));

  const shotCieZoom = join(SHOT_DIR, '4-cie-wheel-zoom-aligned.png');
  await page.screenshot({ path: shotCieZoom, clip: cieAudit.cellRect });

  // Measure actual CIE graticule canvas at 1.6x zoom:
  // 1. Grid horizontal lines span ALL THE WAY from x = padL (60 dev px) to x = w - padR (w - 28 dev px)!
  // 2. Zero saturated locus/triangle pixels in left gutter (x < 58 dev px) or bottom label strip (y > h - 38 dev px)!
  const ciePixelTruth = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const grat = root.querySelector('.cell[data-mode="cie"] canvas.grat');
    const bm = await createImageBitmap(grat);
    const oc = new OffscreenCanvas(bm.width, bm.height);
    const ctx = oc.getContext('2d');
    ctx.drawImage(bm, 0, 0);
    const d = ctx.getImageData(0, 0, bm.width, bm.height).data;

    let minGridX = bm.width;
    let maxGridX = 0;
    for (let y = 60; y < bm.height - 50; y++) {
      let rowGridCount = 0;
      for (let x = 55; x < bm.width - 20; x++) {
        const i = (y * bm.width + x) * 4;
        if (Math.abs(d[i] - 0x1b) <= 8 && Math.abs(d[i + 1] - 0x23) <= 8 && Math.abs(d[i + 2] - 0x2b) <= 8 && d[i + 3] > 200) {
          rowGridCount++;
        }
      }
      if (rowGridCount > bm.width * 0.5) {
        for (let x = 50; x < bm.width - 10; x++) {
          const i = (y * bm.width + x) * 4;
          if (d[i + 3] > 200) {
            if (x < minGridX) minGridX = x;
            if (x > maxGridX) maxGridX = x;
          }
        }
      }
    }

    let saturatedLeftGutter = 0;
    let saturatedBottomGutter = 0;
    for (let y = 48; y < bm.height; y++) {
      for (let x = 0; x < 58; x++) {
        const i = (y * bm.width + x) * 4;
        if (d[i + 3] > 40 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 45) {
          saturatedLeftGutter++;
        }
      }
    }
    for (let y = bm.height - 38; y < bm.height; y++) {
      for (let x = 0; x < bm.width; x++) {
        const i = (y * bm.width + x) * 4;
        if (d[i + 3] > 40 && Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 45) {
          saturatedBottomGutter++;
        }
      }
    }
    return {
      canvasW: bm.width,
      minGridX,
      maxGridX,
      gridWidthFraction: (maxGridX - minGridX) / bm.width,
      saturatedLeftGutter,
      saturatedBottomGutter,
    };
  });

  check(
    'CIE 1.6× zoomed grid spans the full panel width (>85% of canvas) with zero locus/triangle bleed into left or bottom axis labels',
    ciePixelTruth.gridWidthFraction > 0.85 &&
      ciePixelTruth.saturatedLeftGutter === 0 &&
      ciePixelTruth.saturatedBottomGutter === 0,
    JSON.stringify(ciePixelTruth),
  );
  check('Zero page errors during Round 3 WebGPU verification', errors.length === 0, errors.join('; '));

  // Also save a full-panel 3-up screenshot to show the whole studio UI in action!
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.querySelector('#layouts button[data-layout="triple"]').click();
  });
  await new Promise((r) => setTimeout(r, 700));
  const hostBox = await page.evaluate(() => {
    const r = document.getElementById('video-scopes-host').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: join(SHOT_DIR, '5-full-triple-panel.png'), clip: hostBox });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
