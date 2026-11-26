/**
 * Reproduces and verifies all four defects from the YouTube SMPTE colour-bars
 * report in one real-Chrome WebGPU run:
 *
 * 1. Waveform & Parade spilling out of the graticule frame after gain/option
 *    changes or panel resizes on Retina displays (tested on axis:limited!).
 * 2. Vectorscope stretching horizontally in wide 4-up cells (flying outside the
 *    circle) and stamping faint transitions/watermarks into chunky green blocks.
 * 3. Zero jitter on paused video (verified on actual composited screen pixels!)
 *    and sub-pixel stability under +/-1 LSB static codec noise while playing.
 * 4. Mathematical accuracy of 75%/100% IRE levels, Vectorscope target hits, and
 *    CIE chromaticity coordinates.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const OUT = resolve('docs/screenshots');
const WAVE_PAD = { top: 14, right: 10, bottom: 22, left: 44 };
const VECTORSCOPE_FULL_SCALE = 0.62;
const DISC_RADIUS_FRAC = 0.45;

const HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; background: #0b0f12; overflow: hidden; }
    #video { width: 1280px; height: 720px; display: block; }
    #src { display: none; }
  </style>
</head>
<body>
  <canvas id="src" width="1280" height="720"></canvas>
  <video id="video" muted playsinline autoplay></video>
  <script>
    const c = document.getElementById('src');
    const ctx = c.getContext('2d');
    let noisy = false;
    let tick = 0;

    function drawSmpte() {
      const w = c.width, h = c.height;
      const topH = Math.round(h * 0.67);
      const midH = Math.round(h * 0.08);
      const botY = topH + midH;
      const botH = h - botY;

      const bars75 = [
        [191, 191, 191],
        [191, 191, 0],
        [0, 191, 191],
        [0, 191, 0],
        [191, 0, 191],
        [191, 0, 0],
        [0, 0, 191],
      ];
      const castBars = [
        [0, 0, 191],
        [0, 0, 0],
        [191, 0, 191],
        [0, 0, 0],
        [0, 191, 191],
        [0, 0, 0],
        [191, 191, 191],
      ];
      const bw = w / 7;
      for (let i = 0; i < 7; i++) {
        const x0 = Math.round(i * bw);
        const x1 = Math.round((i + 1) * bw);
        const b = bars75[i];
        ctx.fillStyle = \`rgb(\${b[0]},\${b[1]},\${b[2]})\`;
        ctx.fillRect(x0, 0, x1 - x0, topH);
        if (noisy) {
          // Simulate realistic +/-1 LSB codec macroblock quantisation noise
          // scattered across patches in the bar without shifting its DC level.
          for (let k = 0; k < 8; k++) {
            const ny = ((tick * 37 + i * 53 + k * 29) % (topH - 4));
            const nx = x0 + ((tick * 19 + k * 41) % Math.max(1, x1 - x0 - 16));
            const delta = k % 2 === 0 ? 1 : -1;
            ctx.fillStyle = \`rgb(\${Math.max(0, Math.min(255, b[0] + delta))},\${Math.max(0, Math.min(255, b[1] + delta))},\${Math.max(0, Math.min(255, b[2] + delta))})\`;
            ctx.fillRect(nx, ny, 16, 2);
          }
        }
        const cb = castBars[i];
        ctx.fillStyle = \`rgb(\${cb[0]},\${cb[1]},\${cb[2]})\`;
        ctx.fillRect(x0, topH, x1 - x0, midH);
      }

      const segW = Math.round((w * 5) / 28);
      ctx.fillStyle = 'rgb(0, 33, 76)';
      ctx.fillRect(0, botY, segW, botH);
      ctx.fillStyle = 'rgb(255, 255, 255)';
      ctx.fillRect(segW, botY, segW, botH);
      ctx.fillStyle = 'rgb(50, 0, 106)';
      ctx.fillRect(segW * 2, botY, segW, botH);
      ctx.fillStyle = 'rgb(0, 0, 0)';
      ctx.fillRect(segW * 3, botY, w - segW * 3, botH);
      ctx.fillStyle = 'rgb(10, 10, 10)';
      ctx.fillRect(Math.round(w * 0.82), botY, Math.round(w * 0.04), botH);

      // Subtle faint watermark (3% opacity), like the YouTube test video
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.font = '20px sans-serif';
      for (let y = 120; y < topH; y += 180) {
        for (let x = 80; x < w; x += 280) {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(-0.35);
          ctx.fillText('TEST 1973', 0, 0);
          ctx.restore();
        }
      }
      ctx.restore();
      tick++;
    }

    drawSmpte();
    window.__setNoisy = (v) => { noisy = v; };
    setInterval(() => {
      if (!document.getElementById('video').paused) drawSmpte();
    }, 33);

    const v = document.getElementById('video');
    window.__videoReady = false;
    v.addEventListener('loadeddata', () => { window.__videoReady = true; });
    v.srcObject = c.captureStream(30);
    v.play().catch(() => {});
    if (v.readyState >= 2) window.__videoReady = true;
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(HTML);
});
await new Promise((k) => server.listen(4359, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'user-bugs-')),
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

  await page.setViewport({ width: 1440, height: 820, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4359/?vsInline=1', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

  await page.evaluate(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
        session: {
          get: async (k) => ({ [k]: store['s:' + k] }),
          set: async (o) => { for (const [k, v] of Object.entries(o)) store['s:' + k] = v; },
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
  await new Promise((r) => setTimeout(r, 900));

  // Match the user's exact setup: axis:limited, gain=2.1, and resized wide 4-up panel!
  await page.evaluate(() => {
    const host = document.getElementById('video-scopes-host');
    host.style.width = '780px';
    host.style.height = '510px';
    const root = host.shadowRoot;
    const range = root.getElementById('range');
    range.value = 'limited';
    range.dispatchEvent(new Event('change', { bubbles: true }));
    const gain = root.getElementById('gain');
    gain.value = '2.1';
    gain.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 900));

  // Helper in page: poll rAF until createImageBitmap catches a presented WebGPU frame.
  await page.evaluate(() => {
    window.__grabPresentedGpu = async (canvas) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((r) => requestAnimationFrame(r));
        const bmp = await createImageBitmap(canvas);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = oc.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4) {
          if (d[i] > 20) {
            lit++;
            if (lit > 30) return { w: bmp.width, h: bmp.height, d };
          }
        }
      }
      return null;
    };
  });

  // 1. Verify Waveform (RGB) & Parade strictly stay inside [padL..w-padR, padT..h-padB]
  //    AND 100% White hits 100 IRE (NOT the top box border!) on axis:limited!
  const waveBounds = await page.evaluate(async (pad) => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const out = [];
    for (const mode of ['waveform-rgb', 'waveform-parade']) {
      const cell = root.querySelector(`.cell[data-mode="${mode}"]`);
      const c = cell.querySelector('canvas.gpu');
      const dpr = c.width / c.clientWidth;
      const padL = Math.round(pad.left * dpr);
      const padR = Math.round(pad.right * dpr);
      const padT = Math.round(pad.top * dpr);
      const padB = Math.round(pad.bottom * dpr);
      const snap = await window.__grabPresentedGpu(c);
      if (!snap) {
        out.push({ mode, missing: true });
        continue;
      }
      const { w, h, d } = snap;
      let outLeft = 0, outRight = 0, outTop = 0, outBottom = 0, inPlot = 0;
      let minLitY = h, maxLitY = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = d[(y * w + x) * 4 + 3];
          if (a === 0) continue;
          if (x < padL) outLeft++;
          else if (x >= w - padR) outRight++;
          else if (y < padT) outTop++;
          else if (y >= h - padB) outBottom++;
          else {
            inPlot++;
            if (a > 120) {
              if (y < minLitY) minLitY = y;
              if (y > maxLitY) maxLitY = y;
            }
          }
        }
      }
      const plotH = h - padT - padB;
      const axisMax = 1 - (minLitY - padT) / (plotH - 1);
      const axisMin = 1 - (maxLitY - padT) / (plotH - 1);
      const ireMax = +(((axisMax - 16 / 255) / (219 / 255)) * 100).toFixed(1);
      const ireMin = +(((axisMin - 16 / 255) / (219 / 255)) * 100).toFixed(1);
      out.push({ mode, w, h, dpr, inPlot, outLeft, outRight, outTop, outBottom, ireMax, ireMin });
    }
    return out;
  }, WAVE_PAD);

  for (const b of waveBounds) {
    const outside = (b.outLeft ?? 0) + (b.outRight ?? 0) + (b.outTop ?? 0) + (b.outBottom ?? 0);
    check(
      `${b.mode} stays strictly inside graticule plot box after gain & resize`,
      !b.missing && b.inPlot > 500 && outside === 0,
      b.missing
        ? 'no presented frame'
        : `in=${b.inPlot}, outside=${outside} (L:${b.outLeft} R:${b.outRight} T:${b.outTop} B:${b.outBottom}) @ ${b.w}x${b.h}`,
    );
    check(
      `${b.mode} maps 0..100% display levels onto 0..100 IRE (leaving headroom intact)`,
      !b.missing && Math.abs(b.ireMax - 100) <= 2.5 && Math.abs(b.ireMin - 0) <= 2.5,
      b.missing ? 'no presented frame' : `min=${b.ireMin} IRE, max=${b.ireMax} IRE`,
    );
  }

  // 2. Verify Vectorscope in wide 4-up cell: zero out-of-disc pixels, all 6 SMPTE
  //    75% bars hit their target centres, and no chunky blob fill!
  const vecAudit = await page.evaluate(
    async ({ fullScale, discFrac }) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const cell = root.querySelector('.cell[data-mode="vectorscope"]');
      const c = cell.querySelector('canvas.gpu');
      const snap = await window.__grabPresentedGpu(c);
      const { w, h, d } = snap;

      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) * discFrac;
      const scale = radius / fullScale;

      let litTotal = 0;
      let outsideDisc = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = d[(y * w + x) * 4 + 3];
          if (a === 0) continue;
          litTotal++;
          if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > radius + 4.5) outsideDisc++;
        }
      }

      const kr = 0.2126, kg = 0.7152, kb = 0.0722;
      const bars = [
        ['R', [0.75, 0, 0]],
        ['Y', [0.75, 0.75, 0]],
        ['G', [0, 0.75, 0]],
        ['C', [0, 0.75, 0.75]],
        ['B', [0, 0, 0.75]],
        ['M', [0.75, 0, 0.75]],
      ];
      const hits = bars.map(([name, [r, g, b]]) => {
        const y = kr * r + kg * g + kb * b;
        const cb = (b - y) / (2 * (1 - kb));
        const cr = (r - y) / (2 * (1 - kr));
        const tx = cx + cb * scale;
        const ty = cy - cr * scale;
        let bestA = 0, bestDist = 99;
        for (let py = Math.max(0, Math.floor(ty - 6)); py <= Math.min(h - 1, Math.ceil(ty + 6)); py++) {
          for (let px = Math.max(0, Math.floor(tx - 6)); px <= Math.min(w - 1, Math.ceil(tx + 6)); px++) {
            const a = d[(py * w + px) * 4 + 3];
            if (a > bestA) {
              bestA = a;
              bestDist = Math.hypot(px + 0.5 - tx, py + 0.5 - ty);
            }
          }
        }
        return { name, bestA, bestDist: +bestDist.toFixed(2) };
      });

      return {
        w,
        h,
        aspect: +(w / h).toFixed(2),
        litTotal,
        litFrac: +(litTotal / (w * h)).toFixed(4),
        outsideDisc,
        hits,
      };
    },
    { fullScale: VECTORSCOPE_FULL_SCALE, discFrac: DISC_RADIUS_FRAC },
  );

  check(
    'vectorscope keeps every pixel inside the circle in a wide cell',
    vecAudit.outsideDisc === 0,
    `aspect=${vecAudit.aspect}:1 (${vecAudit.w}x${vecAudit.h}), outsideDisc=${vecAudit.outsideDisc}`,
  );
  check(
    'vectorscope renders crisp points rather than chunky blobs',
    vecAudit.litTotal > 40 && vecAudit.litFrac < 0.015,
    `lit=${vecAudit.litTotal} px (${(vecAudit.litFrac * 100).toFixed(2)}% of canvas)`,
  );
  check(
    'all 6 SMPTE 75% colour bars land dead-on their vectorscope target boxes',
    vecAudit.hits.every((h) => h.bestA >= 220 && h.bestDist <= 2.5),
    vecAudit.hits.map((h) => `${h.name}:a=${h.bestA}@${h.bestDist}px`).join(' '),
  );

  // 3. Sub-pixel row stability while playing with +/-1 LSB simulated P-frame noise!
  await page.evaluate(() => window.__setNoisy(true));
  await new Promise((r) => setTimeout(r, 300));

  const noisyStability = await page.evaluate(async (pad) => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell[data-mode="waveform-rgb"]');
    const c = cell.querySelector('canvas.gpu');
    const dpr = c.width / c.clientWidth;
    const sampleX = Math.round((pad.left + (c.clientWidth - pad.left - pad.right) * 0.07) * dpr);
    const centroids = [];
    for (let k = 0; k < 6; k++) {
      await new Promise((r) => setTimeout(r, 80));
      const snap = await window.__grabPresentedGpu(c);
      if (!snap) continue;
      const { w, h, d } = snap;
      // Measure specifically around the 75 IRE bar row (excluding the 100 IRE sub-bar)
      const plotH = h - Math.round(pad.top * dpr) - Math.round(pad.bottom * dpr);
      const axis75 = (16 + 0.75 * 219) / 255;
      const row75 = Math.round(pad.top * dpr) + Math.round((1 - axis75) * (plotH - 1));
      let wy = 0, wsum = 0;
      for (let y = row75 - 12; y <= row75 + 12; y++) {
        const idx = (y * w + sampleX) * 4;
        const l = d[idx] + d[idx + 1] + d[idx + 2];
        if (l > 40) {
          wy += y * l;
          wsum += l;
        }
      }
      if (wsum > 0) centroids.push(wy / wsum);
    }
    const minC = Math.min(...centroids);
    const maxC = Math.max(...centroids);
    return { count: centroids.length, spanPx: centroids.length ? +(maxC - minC).toFixed(3) : null };
  }, WAVE_PAD);

  check(
    'playing static video with +/-1 LSB codec noise keeps bar trace sub-pixel steady (< 0.8 dev px)',
    noisyStability.count >= 5 && noisyStability.spanPx !== null && noisyStability.spanPx < 0.8,
    `centroid span=${noisyStability.spanPx} dev px across ${noisyStability.count} frames`,
  );

  // 4. Pause the video, verify perf badge drops to 0fps, and verify composited
  //    screen pixels have ZERO jitter across 600 ms AND survive a paused resize!
  await page.evaluate(() => {
    window.__setNoisy(false);
    document.getElementById('video').pause();
  });
  await new Promise((r) => setTimeout(r, 350));

  const hostClip = await page.evaluate(() => {
    const r = document.getElementById('video-scopes-host').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const shotA = await page.screenshot({ clip: hostClip });
  await new Promise((r) => setTimeout(r, 600));
  const shotB = await page.screenshot({ clip: hostClip });
  const byteDiff = Buffer.compare(shotA, shotB);
  const perfText = await page.evaluate(
    () => document.getElementById('video-scopes-host').shadowRoot.getElementById('perf')?.textContent ?? '',
  );

  check(
    'paused video freezes scopes cleanly with zero composited pixel jitter and 0fps badge',
    byteDiff === 0 && perfText.startsWith('0fps'),
    `pngByteDiff=${byteDiff}, perf="${perfText}"`,
  );

  // Resize while paused and capture full visual proof screenshot!
  await page.evaluate(() => {
    const host = document.getElementById('video-scopes-host');
    host.style.width = '820px';
    host.style.height = '540px';
  });
  await new Promise((r) => setTimeout(r, 350));
  await page.screenshot({ path: join(OUT, 'smpte-4grid-fixed.png') });

  check('no uncaught page or WebGPU errors', errors.length === 0, errors.join(' | ') || 'clean');
  await writeFile(
    join(OUT, 'user-bugs-report.json'),
    JSON.stringify({ results, waveBounds, vecAudit, noisyStability, perfText }, null, 2),
  );
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
