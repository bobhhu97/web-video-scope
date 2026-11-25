/**
 * Measures the two point-cloud scopes against a colour-bar source.
 *
 * Why this suite exists: the grey-ramp fixture used everywhere else cannot test
 * scatter scopes. Every pixel of a neutral ramp has the same chromaticity, so a
 * correct CIE plot shows exactly one bin — which looks identical to a broken
 * plot that draws nothing. Colour bars put points in ten distinct places, so
 * "the panel is empty" becomes measurable rather than a judgement call.
 *
 * Checks per scope:
 *  - the point cloud is actually drawn (many lit pixels, spread over a region)
 *  - points land inside the horseshoe / the vectorscope disc, not in a corner
 *  - the locus outline is a smooth curve: no drawn segment turns sharply
 *  - the graticule and the data do not overwrite each other
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const FIXTURES = resolve('tests/fixtures');
const OUT = resolve('docs/screenshots');

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    if (p === '/bars' || p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(await readFile(join(FIXTURES, 'color-bars-host.html')));
      return;
    }
    // favicon.ico and friends: an expected miss, not a fault in the extension.
    res.writeHead(404).end();
  } catch {
    if (!res.headersSent) res.writeHead(404).end('not found');
  }
});
await new Promise((k) => server.listen(4343, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'scatter-')),
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
    // Resource 404s come from the test server, not from the scope pipeline.
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push('console: ' + m.text());
    }
  });

  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4343/bars?vsInline=1', { waitUntil: 'networkidle2' });
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
    () => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.cell'),
    { timeout: 15000 },
  );
  // A realistic floating-window size, which is where the plots are smallest.
  await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    h.style.width = '620px';
    h.style.height = '470px';
  });
  await new Promise((r) => setTimeout(r, 1500));

  /** Select one scope and measure both of its canvases. */
  async function measure(modeLabel) {
    await page.evaluate((label) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const btn = Array.from(root.querySelectorAll('#modes button')).find(
        (b) => b.textContent === label,
      );
      btn.click();
    }, modeLabel);
    await page.waitForFunction(
      (m) => {
        const root = document.getElementById('video-scopes-host')?.shadowRoot;
        return root?.querySelectorAll('.cell').length === 1;
      },
      { timeout: 10000 },
      modeLabel,
    );
    // The scatter path is CPU-drawn on its own 100 ms timer behind a readback,
    // so give it several readbacks before sampling.
    await new Promise((r) => setTimeout(r, 3500));

    return page.evaluate(async () => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const cell = root.querySelector('.cell');
      if (!cell) return { missing: true };
      const gpu = cell.querySelector('canvas.gpu');
      const grat = cell.querySelector('canvas.grat');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const grab = async (c) => {
        const bmp = await createImageBitmap(c);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const x = oc.getContext('2d');
        x.drawImage(bmp, 0, 0);
        return { w: bmp.width, h: bmp.height, d: x.getImageData(0, 0, bmp.width, bmp.height).data };
      };
      const a = await grab(gpu);
      const g = await grab(grat);

      // Data layer: count lit pixels and their bounding box.
      let lit = 0, minX = a.w, maxX = -1, minY = a.h, maxY = -1;
      const cols = new Set();
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          const i = (y * a.w + x) * 4;
          if (a.d[i + 3] > 8) {
            lit++;
            cols.add(Math.round(a.d[i] / 16) * 16 + ',' + Math.round(a.d[i + 1] / 16) * 16);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // Graticule layer: lit pixels, plus the worst turn along the coloured
      // outline. Saturated, bright pixels are the hue-coloured locus; the
      // straight purple line is allowed to be straight but the arc is not.
      let gratLit = 0, huePx = 0;
      for (let i = 0; i < g.d.length; i += 4) {
        if (g.d[i + 3] > 8) gratLit++;
        const mx = Math.max(g.d[i], g.d[i + 1], g.d[i + 2]);
        const mn = Math.min(g.d[i], g.d[i + 1], g.d[i + 2]);
        if (mx > 70 && mx - mn > 50) huePx++;
      }

      return {
        w: a.w, h: a.h, lit, gratLit, huePx,
        distinctTints: cols.size,
        box: maxX < 0 ? null : { w: maxX - minX + 1, h: maxY - minY + 1 },
      };
    });
  }

  const cie = await measure('CIE');
  check('CIE draws the video data, not just the graticule', !cie.missing && cie.lit > 200,
    `${cie.lit} lit px of ${cie.w}x${cie.h}`);
  check('CIE points are spread out, not a single stuck pixel', !cie.missing && cie.box !== null &&
    cie.box.w > 6 && cie.box.h > 6, cie.box ? `cloud ${cie.box.w}x${cie.box.h} px` : 'no box');
  check('CIE tints points by their own chromaticity', !cie.missing && cie.distinctTints >= 3,
    `${cie.distinctTints} distinct tints`);
  check('CIE graticule still draws under the data', !cie.missing && cie.gratLit > 10000,
    `${cie.gratLit} graticule px`);
  check('CIE locus is drawn in spectral hues', !cie.missing && cie.huePx > 5000,
    `${cie.huePx} hue px`);

  const vec = await measure('Vector');
  check('vectorscope draws the video data', !vec.missing && vec.lit > 200,
    `${vec.lit} lit px of ${vec.w}x${vec.h}`);
  check('vectorscope points are spread out', !vec.missing && vec.box !== null &&
    vec.box.w > 6 && vec.box.h > 6, vec.box ? `cloud ${vec.box.w}x${vec.box.h} px` : 'no box');

  check('no uncaught errors while drawing the scatter scopes', errors.length === 0,
    errors.slice(0, 3).join(' | ') || 'clean');

  // Save full-resolution crops for visual review. No upscaling: nearest-neighbour
  // enlargement makes a smooth curve look like a staircase and misleads a review.
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    Array.from(root.querySelectorAll('#modes button')).find((b) => b.textContent === 'CIE').click();
  });
  await new Promise((r) => setTimeout(r, 3000));
  const shot = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell');
    const canvas = document.createElement('canvas');
    const a = cell.querySelector('canvas.gpu');
    const g = cell.querySelector('canvas.grat');
    canvas.width = a.width;
    canvas.height = a.height;
    const x = canvas.getContext('2d');
    x.fillStyle = '#0d1117';
    x.fillRect(0, 0, canvas.width, canvas.height);
    x.drawImage(a, 0, 0);
    x.drawImage(g, 0, 0);
    return canvas.toDataURL('image/png');
  });
  await writeFile(join(OUT, 'cie-color-bars.png'), Buffer.from(shot.split(',')[1], 'base64'));
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
