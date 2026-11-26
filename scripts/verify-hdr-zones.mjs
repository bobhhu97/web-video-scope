#!/usr/bin/env node
/**
 * Real Chrome + Metal WebGPU verification for 3-to-4 Zone HDR Nit Coloring:
 *   - 4-Zone (`100 / 203 / 1000 nits`):
 *       <100n Sky Blue/Cyan · 100–203n Green · 203–1000n Bright Yellow · >1000n Vivid Red
 *   - 3-Zone (`203 / 1000 nits` via `203/1k` preset):
 *       ≤203n Green · 203–1000n Bright Yellow · >1000n Vivid Red
 *   - Verifies multi-channel RGB/YRGB Waveform & Histogram never blow out highlights to white!
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

const HDR_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>HDR 3–4 Zone Nit Coloring Studio</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px 24px;
      background: #0a0e13;
      color: #dce6ef;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; color: #eef4fa; }
    p { margin: 0 0 12px; font-size: 12px; color: #8b9cac; max-width: 530px; }
    .player {
      width: 532px;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid #24303c;
      background: #000;
      box-shadow: 0 16px 38px rgba(0,0,0,0.55);
    }
    video { display: block; width: 532px; height: 300px; background: #000; }
    .strip-labels {
      margin-top: 10px;
      width: 532px;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 6px;
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #9fb0bf;
    }
    .strip-labels div {
      background: #111820;
      border: 1px solid #1f2b36;
      border-radius: 6px;
      padding: 6px 8px;
      text-align: center;
    }
  </style>
</head>
<body>
  <h1>HDR PQ 测试源 (BT.2020 / ST.2084 PQ)</h1>
  <p>四段亮度色块 (35n · 150n · 550n · 2200n) + 5–4000 nits 连续对数灰阶斜坡 + HDR 彩条</p>
  <div class="player">
    <video id="video" muted playsinline loop></video>
  </div>
  <div class="strip-labels">
    <div>Patch 1: 35 nits<br/>(&lt;100n 暗部)</div>
    <div>Patch 2: 150 nits<br/>(100–203n SDR)</div>
    <div>Patch 3: 550 nits<br/>(203–1000n 高光黄)</div>
    <div>Patch 4: 2200 nits<br/>(&gt;1000n 峰值红)</div>
  </div>
  <script>
    const M1 = 0.1593017578125, M2 = 78.84375;
    const C1 = 0.8359375, C2 = 18.8515625, C3 = 18.6875;
    function nitsToPqCode(nits) {
      const y = Math.max(0, Math.min(1, nits / 10000));
      const ym = Math.pow(y, M1);
      const pq = Math.pow((C1 + C2 * ym) / (1 + C3 * ym), M2);
      return Math.round(Math.max(0, Math.min(255, pq * 255)));
    }

    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 540;
    const ctx = c.getContext('2d');

    const bars = [
      [nitsToPqCode(195), nitsToPqCode(195), nitsToPqCode(195)],
      [nitsToPqCode(550), nitsToPqCode(550), nitsToPqCode(30)],
      [nitsToPqCode(30),  nitsToPqCode(550), nitsToPqCode(550)],
      [nitsToPqCode(30),  nitsToPqCode(180), nitsToPqCode(30)],
      [nitsToPqCode(2200), nitsToPqCode(40), nitsToPqCode(40)],
      [nitsToPqCode(30),  nitsToPqCode(30),  nitsToPqCode(180)],
    ];

    function paint() {
      // Top band: HDR bars
      const bw = c.width / bars.length;
      for (let i = 0; i < bars.length; i++) {
        const [r, g, b] = bars[i];
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), 170);
      }

      // Middle band: smooth continuous 5 nits -> 4000 nits PQ ramp (pure neutral white R=G=B!)
      for (let x = 0; x < c.width; x += 2) {
        const t = x / (c.width - 1);
        const nits = 5 * Math.pow(800, t);
        const v = nitsToPqCode(nits);
        ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
        ctx.fillRect(x, 170, 2, 175);
      }

      // Bottom band: 4 explicit neutral white HDR zones: 35n, 150n, 550n, 2200n!
      const patches = [35, 150, 550, 2200];
      const pw = c.width / patches.length;
      for (let i = 0; i < patches.length; i++) {
        const v = nitsToPqCode(patches[i]);
        ctx.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
        ctx.fillRect(Math.round(i * pw), 345, Math.ceil(pw), 195);
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
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HDR_PAGE_HTML);
});
await new Promise((k) => server.listen(4379, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'hdr-zones-')),
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
  await page.goto('http://127.0.0.1:4379/?vsInline=1', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 10000 });

  await page.evaluate(() => {
    const mem = {};
    globalThis.chrome = {
      storage: {
        local: {
          get: (k, cb) => {
            const r = typeof k === 'string' ? { [k]: mem[k] } : { ...mem };
            if (cb) cb(r);
            return Promise.resolve(r);
          },
          set: (o, cb) => {
            Object.assign(mem, o);
            if (cb) cb();
            return Promise.resolve();
          },
        },
        session: {
          get: (_k, cb) => {
            if (cb) cb({});
            return Promise.resolve({});
          },
          set: (_o, cb) => {
            if (cb) cb();
            return Promise.resolve();
          },
        },
      },
      runtime: { onMessage: { addListener: () => {} }, sendMessage: () => Promise.resolve() },
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

  // Position scopes cleanly on right side so source video + False Color overlay (left) and 4 scopes (right) are both visible
  await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    h.style.top = '18px';
    h.style.left = '584px';
    h.style.right = 'auto';
    h.style.width = '836px';
    h.style.height = '864px';

    const root = h.shadowRoot;
    const setSelect = (el, val) => {
      el.value = val;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Switch UI language to Chinese
    root.getElementById('lang-btn').click();

    // Open Signal & HDR Nit Zones drawer
    root.querySelector('details.options').open = true;
    setSelect(root.getElementById('matrix'), 'bt2020');
    setSelect(root.getElementById('hdr-mode'), 'pq');
    setSelect(root.getElementById('fc-preset'), 'hdr-nits');

    // Slot 0: Multi-channel YRGB Waveform (previously suffered additive whiteout!)
    const c0 = root.querySelector('.cell[data-slot="0"]');
    c0.querySelector('.pill[data-wave="YRGB"]').click();

    // Slot 1: RGB Parade
    // Slot 2: Histogram YRGB
    const c2 = root.querySelector('.cell[data-slot="2"]');
    setSelect(c2.querySelector('select.tag'), 'histogram');

    // Slot 3: Waveform Y
    const c3 = root.querySelector('.cell[data-slot="3"]');
    setSelect(c3.querySelector('select.tag'), 'waveform-luma');

    // Enable HDR Nit Zone coloring on all scopes (`fc-preset` change above already auto-enabled False Color!)
    root.getElementById('zone-all-btn').click();
  });
  await new Promise((r) => setTimeout(r, 950));

  async function classifyZonePixels(selectorFn) {
    return page.evaluate(async (fnBody) => {
      const getCanvas = new Function('return (' + fnBody + ')();');
      const canvas = getCanvas();
      let out = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => requestAnimationFrame(r));
        const bmp = await createImageBitmap(canvas);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const x = oc.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
        let lit = 0, whiteout = 0, blueCyan = 0, green = 0, yellow = 0, red = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
          if (a < 30 || r + g + b < 60) continue;
          lit++;
          const spread = Math.max(r, g, b) - Math.min(r, g, b);
          if (r > 200 && g > 200 && b > 200 && spread < 20) whiteout++;
          if (b > g + 15 && b > r + 45) blueCyan++;
          if (g > b + 25 && g > r + 45) green++;
          if (r > 120 && g > 100 && b < 55 && Math.abs(r - g) < 55) yellow++;
          if (r > 125 && r > g * 2.3 && r > b * 2.1) red++;
        }
        out = { lit, whiteout, blueCyan, green, yellow, red };
        if (lit > 300) break;
      }
      return out;
    }, selectorFn.toString());
  }

  // --- Test A: 4-Zone Mode (100 / 203 / 1000 nits) ---
  const wave4 = await classifyZonePixels(
    () => document.getElementById('video-scopes-host').shadowRoot.querySelector('.cell[data-slot="0"] canvas.gpu'),
  );
  const parade4 = await classifyZonePixels(
    () => document.getElementById('video-scopes-host').shadowRoot.querySelector('.cell[data-slot="1"] canvas.gpu'),
  );
  const hist4 = await classifyZonePixels(
    () => document.getElementById('video-scopes-host').shadowRoot.querySelector('.cell[data-slot="2"] canvas.gpu'),
  );
  const fc4 = await classifyZonePixels(
    () => document.getElementById('video-scopes-false-color').shadowRoot.querySelector('canvas'),
  );
  const legend4 = await page.evaluate(() =>
    document.getElementById('video-scopes-false-color')?.shadowRoot?.querySelector('.legend')?.textContent?.trim() ?? '',
  );

  check(
    '4-Zone YRGB Waveform renders ZERO whiteout and distinct Blue(<100n), Green(100–203n), Yellow(203–1000n), Red(>1000n)',
    wave4.whiteout === 0 && wave4.blueCyan > 300 && wave4.green > 300 && wave4.yellow > 300 && wave4.red > 300,
    JSON.stringify(wave4),
  );
  check(
    '4-Zone RGB Parade renders all 4 distinct HDR zones (Blue, Green, Yellow, Red)',
    parade4.blueCyan > 200 && parade4.green > 200 && parade4.yellow > 200 && parade4.red > 200,
    JSON.stringify(parade4),
  );
  check(
    '4-Zone YRGB Histogram renders ZERO whiteout and all 4 distinct HDR zones (Blue, Green, Yellow, Red)',
    hist4.whiteout === 0 && hist4.blueCyan > 150 && hist4.green > 150 && hist4.yellow > 150 && hist4.red > 150,
    JSON.stringify(hist4),
  );
  check(
    '4-Zone Video False Color overlay paints Blue(<100n), Green(100–203n), Yellow(203–1000n), Red(>1000n) + 4-zone legend',
    fc4.blueCyan > 5000 &&
      fc4.green > 5000 &&
      fc4.yellow > 5000 &&
      fc4.red > 5000 &&
      legend4.includes('100–203n') &&
      legend4.includes('203–1000n') &&
      legend4.includes('>1000n'),
    `${JSON.stringify(fc4)} legend="${legend4}"`,
  );

  await page.screenshot({ path: join(OUT, 'hdr-4zone-100-203-1000.png') });

  // --- Test B: Click `203/1k` preset -> 3-Zone Mode (≤203n Green · 203–1000n Yellow · >1000n Red) ---
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.getElementById('preset-203-1000').click();
  });
  await new Promise((r) => setTimeout(r, 700));

  const wave3 = await classifyZonePixels(
    () => document.getElementById('video-scopes-host').shadowRoot.querySelector('.cell[data-slot="0"] canvas.gpu'),
  );
  const fc3 = await classifyZonePixels(
    () => document.getElementById('video-scopes-false-color').shadowRoot.querySelector('canvas'),
  );
  const legend3 = await page.evaluate(() =>
    document.getElementById('video-scopes-false-color')?.shadowRoot?.querySelector('.legend')?.textContent?.trim() ?? '',
  );

  check(
    '3-Zone (203/1k preset) YRGB Waveform paints Green(≤203n), Yellow(203–1000n), Red(>1000n) with zero whiteout',
    wave3.whiteout === 0 && wave3.blueCyan === 0 && wave3.green > 600 && wave3.yellow > 300 && wave3.red > 300,
    JSON.stringify(wave3),
  );
  check(
    '3-Zone (203/1k preset) Video False Color paints Green(≤203n), Yellow(203–1000n), Red(>1000n) + 3-zone legend',
    fc3.green > 10000 &&
      fc3.yellow > 5000 &&
      fc3.red > 5000 &&
      legend3.includes('≤203n') &&
      legend3.includes('203–1000n') &&
      legend3.includes('>1000n'),
    `${JSON.stringify(fc3)} legend="${legend3}"`,
  );

  await page.screenshot({ path: join(OUT, 'hdr-3zone-203-1000.png') });

  check('Zero uncaught page or WebGPU errors', errors.length === 0, errors.join(' | ') || 'clean');
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
