/**
 * Reproduces the graticule/waveform misalignment seen on a Retina display.
 *
 * All prior automated checks ran at deviceScaleFactor 1, where the mismatch is
 * invisible. This runs the same measurement at 1x and 2x and compares the
 * observed position of a known signal against where the graticule says it
 * should be.
 *
 * Expected geometry, in CSS pixels:
 *   plot box = [WAVE_PAD.left, WAVE_PAD.top] .. canvas - [right, bottom]
 *   100 IRE  = plotTop + plotH * (1 - 235/255)
 *    0 IRE   = plotTop + plotH * (1 -  16/255)
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const FIX = resolve('tests/fixtures');
const server = createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(FIX, 'content-host.html')));
  } catch { res.writeHead(404).end(); }
});
await new Promise((k) => server.listen(4320, '127.0.0.1', k));

// Must match src/ui/graticule.ts
const PAD = { top: 8, right: 8, bottom: 16, left: 40 };

async function measure(dpr) {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), `dpr${dpr}-`)),
    args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      `--force-device-scale-factor=${dpr}`],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: dpr });
    await page.goto(`http://127.0.0.1:4320/x?vsInline=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

    const code = readFileSync(join(DIST, 'content.js'), 'utf8');
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
    await page.evaluate(code);
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    });

    // Wait for the scope to render.
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const ready = await page.evaluate(() => {
        const root = document.getElementById('video-scopes-host')?.shadowRoot;
        return !!root?.querySelector('canvas.gpu');
      });
      if (ready) break;
    }
    await new Promise((r) => setTimeout(r, 3000));

    return await page.evaluate((pad) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const canvas = root.querySelector('canvas.gpu');
      const wfCell = canvas.closest('.cell');
      const mode = wfCell?.dataset.mode;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const devW = canvas.width;
      const devH = canvas.height;

      // Where the graticule expects 0 and 100 IRE, in CSS px.
      const plotTop = pad.top;
      const plotH = cssH - pad.top - pad.bottom;
      const y100 = plotTop + plotH * (1 - 235 / 255);
      const y0 = plotTop + plotH * (1 - 16 / 255);

      // Find the brightest row in the middle of the plot, in device px.
      const oc = new OffscreenCanvas(devW, devH);
      const ctx = oc.getContext('2d');
      return createImageBitmap(canvas).then((bmp) => {
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, devW, devH).data;
        const xDev = Math.round(devW * 0.5);
        let bestY = -1;
        let bestLum = -1;
        for (let y = 0; y < devH; y++) {
          const i = (y * devW + xDev) * 4;
          const lum = d[i] + d[i + 1] + d[i + 2];
          if (lum > bestLum) { bestLum = lum; bestY = y; }
        }
        return {
          mode,
          dpr: devW / cssW,
          cssW, cssH, devW, devH,
          y100Css: +y100.toFixed(1),
          y0Css: +y0.toFixed(1),
          peakRowDev: bestY,
          peakRowCss: +(bestY / (devW / cssW)).toFixed(1),
        };
      });
    }, PAD);
  } finally {
    await browser.close();
  }
}

for (const dpr of [1, 2]) {
  const m = await measure(dpr);
  console.log(`\n=== deviceScaleFactor ${dpr}  (mode=${m.mode})`);
  console.log(`  canvas: css ${m.cssW}x${m.cssH}  device ${m.devW}x${m.devH}  (effective dpr ${m.dpr})`);
  console.log(`  graticule expects 100 IRE at y=${m.y100Css} css, 0 IRE at y=${m.y0Css} css`);
  console.log(`  waveform peak at y=${m.peakRowCss} css (row ${m.peakRowDev} device)`);
  const drift = +(m.peakRowCss - m.y100Css).toFixed(1);
  console.log(`  DRIFT from 100 IRE: ${drift} css px ${Math.abs(drift) > 3 ? '  <-- MISALIGNED' : '  ok'}`);
}

await new Promise((k) => server.close(k));
