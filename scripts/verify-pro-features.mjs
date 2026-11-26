/**
 * End-to-end verification in real Chrome + Metal WebGPU for the expanded
 * DaVinci Resolve-style scope capabilities:
 *  1. Per-cell independent options (simultaneous Monochrome Luma Waveform +
 *     True-Colorize YRGB Waveform + YUV Parade + Histogram in 4-up grid)
 *  2. Per-cell gear popover (`⚙`) with scope-specific professional controls
 *  3. Direct mouse wheel cursor-anchored zoom, drag pan, and double-click reset
 *  4. Multi-tier precision selector (`low` / `default` / `high` / `ultra` / `native`)
 *  5. BT.2020 + HDR PQ (ST.2084) / HLG auto-scale, HDR reference ticks (`203 nits`),
 *     Dual-Nit zone coloring (`100 nits` / `1000 nits`), and `Max / >1000n%` telemetry
 *  6. Live WebGPU Video False Color overlay directly on top of the `<video>` element
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const OUT = resolve('docs/screenshots');
await mkdir(OUT, { recursive: true });

/**
 * Rich synthetic HDR PQ + colour-bar test studio:
 * - Top half: 8 SMPTE/HDR colour + saturation bars (BT.2020 / Rec.709 hues)
 * - Lower band: calibrated PQ ST.2084 luminance zones:
 *     Zone A: 15..80 nits   (< 100 nits shadow zone)
 *     Zone B: 120..850 nits (100..1000 nits midtone & 203-nit diffuse white zone)
 *     Zone C: 1400..4000 nits (> 1000 nits specular peak zone!)
 */
const HDR_STUDIO_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Pro Scopes HDR Studio</title>
  <style>
    html, body {
      margin: 0; padding: 0; background: #07090d; color: #cbd5e1;
      font: 12px/1.4 ui-sans-serif, system-ui, sans-serif; overflow: hidden;
    }
    .stage {
      display: flex; align-items: center; justify-content: flex-start;
      height: 100vh; padding-left: 28px; box-sizing: border-box;
    }
    .player-card {
      width: 520px; background: #0f141b; border: 1px solid #1e293b;
      border-radius: 10px; padding: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.6);
    }
    .player-title {
      display: flex; justify-content: space-between; margin-bottom: 8px;
      color: #94a3b8; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase;
    }
    video {
      display: block; width: 100%; aspect-ratio: 16 / 9;
      background: #000; border-radius: 6px;
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="player-card">
      <div class="player-title">
        <span>HDR10 PQ · BT.2020 Reference Plate</span>
        <span>Peak 4000 cd/m²</span>
      </div>
      <video id="video" muted playsinline autoplay></video>
    </div>
  </div>
  <script>
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 540;
    const ctx = c.getContext('2d');

    function nitsToPqCode(nits) {
      const m1 = 0.1593017578125, m2 = 78.84375;
      const c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
      const y = Math.max(0, Math.min(1, nits / 10000));
      const ym = Math.pow(y, m1);
      const pq = Math.pow((c1 + c2 * ym) / (1 + c3 * ym), m2);
      return Math.round(pq * 255);
    }

    const bars = [
      [nitsToPqCode(203), nitsToPqCode(203), nitsToPqCode(203)], // 203 nit ref white
      [nitsToPqCode(203), nitsToPqCode(203), nitsToPqCode(18)],  // Yellow
      [nitsToPqCode(18),  nitsToPqCode(203), nitsToPqCode(203)], // Cyan
      [nitsToPqCode(18),  nitsToPqCode(203), nitsToPqCode(18)],  // Green
      [nitsToPqCode(203), nitsToPqCode(18),  nitsToPqCode(203)], // Magenta
      [nitsToPqCode(203), nitsToPqCode(18),  nitsToPqCode(18)],  // Red
      [nitsToPqCode(18),  nitsToPqCode(18),  nitsToPqCode(203)], // Blue
    ];

    let tick = 0;
    function paint() {
      tick++;
      const bw = c.width / bars.length;
      for (let i = 0; i < bars.length; i++) {
        const [r, g, b] = bars[i];
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), 270);
      }

      // Middle band: smooth continuous PQ ramp from 5 nits -> 4000 nits
      const rampY = 270, rampH = 150;
      for (let x = 0; x < c.width; x += 2) {
        const t = x / (c.width - 1);
        const nits = 5 * Math.pow(800, t); // 5 nits .. 4000 nits log ramp!
        const code = nitsToPqCode(nits);
        // Subtle warm highlight tint above 1000 nits
        const r = Math.min(255, code + (nits > 1000 ? 6 : 0));
        const b = Math.max(0, code - (nits < 80 ? -6 : 0));
        ctx.fillStyle = 'rgb(' + r + ',' + code + ',' + b + ')';
        ctx.fillRect(x, rampY, 2, rampH);
      }

      // Bottom band: 3 explicit stepped HDR test patches:
      // Left 1/3: 35 nits (Shadows < 100 nits)
      // Mid  1/3: 203 nits (SDR Diffuse White / Midtones 100..1000 nits)
      // Right 1/3: 2200 nits (Specular Highlight > 1000 nits!)
      const patches = [35, 203, 2200];
      const pw = c.width / 3;
      for (let i = 0; i < 3; i++) {
        const v = nitsToPqCode(patches[i]);
        ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
        ctx.fillRect(Math.round(i * pw), 420, Math.ceil(pw), 120);
      }
    }
    paint();
    setInterval(paint, 33);

    const v = document.getElementById('video');
    v.srcObject = c.captureStream(30);
    v.addEventListener('loadedmetadata', async () => {
      await v.play();
      window.__videoReady = true;
    }, { once: true });
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  if (p === '/' || p === '/hdr') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HDR_STUDIO_HTML);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((k) => server.listen(4368, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'pro-scopes-')),
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
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push(m.text());
    }
  });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4368/hdr?vsInline=1', { waitUntil: 'networkidle2' });
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

  // Position the scopes panel nicely on the right side of the 1440x900 viewport so both
  // the source player (left) and the 4-up scopes dock (right) are cleanly visible!
  await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    h.style.top = '20px';
    h.style.left = '580px';
    h.style.right = 'auto';
    h.style.width = '836px';
    h.style.height = '860px';
  });
  await new Promise((r) => setTimeout(r, 800));

  // Helper to read WebGPU canvas pixels reliably across swapchain ticks.
  async function sampleCellGpu(slot) {
    return page.evaluate(async (s) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const cell = root.querySelector(`.cell[data-slot="${s}"]`);
      const gpu = cell.querySelector('canvas.gpu');
      let best = null;
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((r) => requestAnimationFrame(r));
        const bmp = await createImageBitmap(gpu);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const x = oc.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
        let lit = 0, neutral = 0, chromatic = 0;
        let shadowHue = 0, midHue = 0, peakHue = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 20 && d[i] + d[i + 1] + d[i + 2] > 45) {
            lit++;
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const spread = Math.max(r, g, b) - Math.min(r, g, b);
            if (spread <= 14) neutral++;
            if (spread >= 35) chromatic++;
            if (b > r + 35 && g > r + 15) shadowHue++;
            if (g > r + 25 && g > b + 12) midHue++;
            if (r > g + 25 && r > 120) peakHue++;
          }
        }
        best = { w: bmp.width, h: bmp.height, lit, neutral, chromatic, shadowHue, midHue, peakHue };
        if (lit > 100) break;
      }
      return best;
    }, slot);
  }

  // -------------------------------------------------------------------------
  // 1. Per-cell independent configuration + Histogram + YUV Parade + Monochrome
  // -------------------------------------------------------------------------
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const setSelect = (el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Slot 0: Waveform -> Y + Monochrome (B&W) via cell ⚙ Settings popover
    const cell0 = root.querySelector('.cell[data-slot="0"]');
    cell0.querySelector('.pill[data-wave="Y"]').click();
    cell0.querySelector('.cell-gear').click();
    setSelect(cell0.querySelector('select[data-pop="traceMode"]'), 'monochrome');
    cell0.querySelector('.cell-gear').click();

    // Slot 1: Parade -> YUV mode
    const cell1 = root.querySelector('.cell[data-slot="1"]');
    cell1.querySelector('.pill[data-parade="YUV"]').click();

    // Slot 2: Switch to Histogram -> YRGB mode
    const cell2 = root.querySelector('.cell[data-slot="2"]');
    setSelect(cell2.querySelector('select.tag'), 'histogram');
    const cell2After = root.querySelector('.cell[data-slot="2"]');
    if (!cell2After.querySelector('.pill[data-hist="YRGB"]').classList.contains('on')) {
      cell2After.querySelector('.pill[data-hist="YRGB"]').click();
    }

    // Slot 3: Vectorscope
    const cell3 = root.querySelector('.cell[data-slot="3"]');
    setSelect(cell3.querySelector('select.tag'), 'vectorscope');
  });
  await new Promise((r) => setTimeout(r, 700));

  const slot0Mono = await sampleCellGpu(0);
  const slot1ParadeYuv = await sampleCellGpu(1);
  const slot2Hist = await sampleCellGpu(2);

  check(
    'slot 0 Monochrome Luma Waveform renders strictly uncolored (B&W) pixels',
    slot0Mono.lit > 400 && slot0Mono.chromatic === 0 && slot0Mono.neutral === slot0Mono.lit,
    `lit=${slot0Mono.lit}, neutral=${slot0Mono.neutral}, chromatic=${slot0Mono.chromatic}`,
  );
  check(
    'slot 1 YUV Parade renders multi-channel Y/U/V slices independently of slot 0',
    slot1ParadeYuv.lit > 400 && slot1ParadeYuv.chromatic > 150,
    `lit=${slot1ParadeYuv.lit}, chromatic=${slot1ParadeYuv.chromatic}`,
  );
  check(
    'slot 2 new GPU Histogram renders smooth multi-channel YRGB curves & fills',
    slot2Hist.lit > 2000 && slot2Hist.chromatic > 500,
    `lit=${slot2Hist.lit}, chromatic=${slot2Hist.chromatic}`,
  );

  // Open slot 1's per-cell ⚙ popover for the Resolve-grid showcase screenshot!
  const popoverInfo = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const gear = root.querySelector('.cell[data-slot="1"] .cell-gear');
    gear.click();
    const pop = root.querySelector('.cell[data-slot="1"] .cell-popover');
    return {
      open: !!pop && !pop.hidden,
      fields: pop ? Array.from(pop.querySelectorAll('[data-pop]')).map((e) => e.getAttribute('data-pop')) : [],
    };
  });
  check(
    'clicking cell ⚙ opens per-cell professional settings popover',
    popoverInfo.open && popoverInfo.fields.includes('paradeMode') && popoverInfo.fields.includes('lowPass'),
    `fields=${popoverInfo.fields.join(',')}`,
  );

  await page.screenshot({ path: join(OUT, 'pro-resolve-grid.png') });

  // Close popover before testing gestures
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.querySelector('.cell[data-slot="1"] .cell-gear').click();
  });

  // -------------------------------------------------------------------------
  // 2. Direct mouse wheel cursor-anchored zoom + drag pan + dblclick reset
  // -------------------------------------------------------------------------
  const stageBox = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const stage = root.querySelector('.cell[data-slot="0"] .cell-stage');
    const r = stage.getBoundingClientRect();
    return { x: Math.round(r.left + r.width * 0.6), y: Math.round(r.top + r.height * 0.35) };
  });

  await page.mouse.move(stageBox.x, stageBox.y);
  await page.mouse.wheel({ deltaY: -360 });
  await new Promise((r) => setTimeout(r, 250));
  await page.mouse.down();
  await page.mouse.move(stageBox.x - 45, stageBox.y + 35, { steps: 5 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 350));

  const zoomState = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const badge = root.querySelector('.cell[data-slot="0"] .zoom-reset');
    return {
      visible: !!badge && !badge.hidden,
      text: badge?.textContent ?? '',
    };
  });
  check(
    'mouse wheel zooms cell around cursor and shows reset badge',
    zoomState.visible && parseFloat(zoomState.text) > 1.3,
    `badge="${zoomState.text}"`,
  );

  await page.screenshot({ path: join(OUT, 'pro-zoom-inspect.png') });

  // Double-click inside stage resets zoom to 1x
  await page.mouse.click(stageBox.x, stageBox.y, { count: 2 });
  await new Promise((r) => setTimeout(r, 250));
  const afterReset = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const badge = root.querySelector('.cell[data-slot="0"] .zoom-reset');
    return !!badge && !badge.hidden;
  });
  check('double-clicking cell stage resets zoom & pan back to 1x', afterReset === false);

  // -------------------------------------------------------------------------
  // 3. Multi-tier precision selector (`low` -> `ultra`)
  // -------------------------------------------------------------------------
  const precReadouts = {};
  for (const preset of ['low', 'ultra', 'auto']) {
    await page.evaluate((val) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const sel = root.querySelector('#precision');
      sel.value = val;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, preset);
    await new Promise((r) => setTimeout(r, 450));
    precReadouts[preset] = await page.evaluate(() =>
      document.getElementById('video-scopes-host').shadowRoot.getElementById('perf')?.textContent ?? '',
    );
  }
  check(
    'precision selector dynamically switches GPU analysis resolution (180p vs 540p)',
    precReadouts.low.includes('180p') && precReadouts.ultra.includes('540p'),
    `low="${precReadouts.low}" | ultra="${precReadouts.ultra}"`,
  );

  // -------------------------------------------------------------------------
  // 4. BT.2020 + HDR PQ mode + Dual-Nit Zone Coloring (100 / 1000 nits) + Video False Color
  // -------------------------------------------------------------------------
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const setSelect = (el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    // Open Global Signal & HDR Thresholds drawer so user can see the controls in the screenshot!
    root.querySelector('details.options').open = true;

    // Set BT.2020 matrix + HDR10 PQ transfer
    setSelect(root.getElementById('matrix'), 'bt2020');
    setSelect(root.getElementById('hdr-mode'), 'pq');

    // Set Dual-Nit thresholds: 100 nits (shadows/midtones) and 1000 nits (monitor peak!)
    const lowIn = root.getElementById('nit-low');
    const highIn = root.getElementById('nit-high');
    lowIn.value = '100';
    lowIn.dispatchEvent(new Event('change', { bubbles: true }));
    highIn.value = '1000';
    highIn.dispatchEvent(new Event('change', { bubbles: true }));

    // Put slot 0 on Waveform YRGB, slot 3 on CIE (showing Rec.709 + P3 + Rec.2020!),
    // and click "Zone Color All" + "False Color" on the source <video>!
    const c0 = root.querySelector('.cell[data-slot="0"]');
    c0.querySelector('.pill[data-wave="Y"]').click();
    const c3 = root.querySelector('.cell[data-slot="3"]');
    setSelect(c3.querySelector('select.tag'), 'cie');
    const c3After = root.querySelector('.cell[data-slot="3"]');
    const g2020 = c3After.querySelector('.pill[data-gamut="rec2020"]');
    if (g2020 && !g2020.classList.contains('on')) g2020.click();

    root.getElementById('zone-all-btn').click();
    root.getElementById('false-color-btn').click();
  });
  await new Promise((r) => setTimeout(r, 900));

  const hdrWave = await sampleCellGpu(0);
  const hdrUi = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const status = root.getElementById('status')?.textContent ?? '';
    const hdrStat = root.getElementById('hdr-stat')?.textContent ?? '';
    const fcHost = document.getElementById('video-scopes-false-color');
    const fcCanvas = fcHost?.shadowRoot?.querySelector('canvas');
    const fcLegend = fcHost?.shadowRoot?.querySelector('.legend')?.textContent ?? '';
    let fcLit = 0;
    if (fcCanvas && fcCanvas.width > 0) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => requestAnimationFrame(r));
        const bmp = await createImageBitmap(fcCanvas);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const x = oc.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
        fcLit = 0;
        for (let i = 0; i < d.length; i += 16) {
          if (d[i + 3] > 20 && d[i] + d[i + 1] + d[i + 2] > 40) fcLit++;
        }
        if (fcLit > 100) break;
      }
    }
    return { status, hdrStat, hasFcHost: !!fcHost, fcLit, fcLegend: fcLegend.trim() };
  });

  check(
    'HDR PQ mode switches scale axis to PQ nits automatically',
    hdrUi.status.includes('PQ nits'),
    `status="${hdrUi.status}"`,
  );
  check(
    'Dual-Nit zone coloring paints distinct <100n shadow, 100-1000n midtone, and >1000n peak traces',
    hdrWave.shadowHue > 50 && hdrWave.midHue > 100 && hdrWave.peakHue > 80,
    `shadowPx=${hdrWave.shadowHue}, midPx=${hdrWave.midHue}, peakPx=${hdrWave.peakHue}`,
  );
  check(
    'HDR telemetry badge reports live MaxCLL > 1000 nits and >1000n percentage',
    hdrUi.hdrStat.includes('>1000n') && /Max\s+[234]\d{3}n/.test(hdrUi.hdrStat),
    `hdrStat="${hdrUi.hdrStat}"`,
  );
  check(
    'Video False Color WebGPU overlay renders live Nit zones & legend over source <video>',
    hdrUi.hasFcHost && hdrUi.fcLit > 500 && hdrUi.fcLegend.includes('1000n'),
    `fcLit=${hdrUi.fcLit}, legend="${hdrUi.fcLegend.replace(/\s+/g, ' ')}"`,
  );

  await page.screenshot({ path: join(OUT, 'pro-hdr-zones.png') });

  check('zero uncaught page or WebGPU errors across all pro features', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
