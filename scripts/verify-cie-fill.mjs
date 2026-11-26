// Does the CIE plot fill in on content with a wide colour distribution, the way
// real footage would? Colour bars only exercise six fixed points, so they cannot
// answer that. This one uses a hue x saturation sweep.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const FIXTURES = resolve('tests/fixtures');
const server = createServer(async (req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  if (p === '/grad') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(FIXTURES, 'gradient-host.html')));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((k) => server.listen(4352, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'grad-')),
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=2'],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4352/grad?vsInline=1', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });
  await page.evaluate(() => {
    const s = {};
    window.chrome = { runtime: { onMessage: { addListener() {} } },
      storage: { local: { get: async (k) => ({ [k]: s[k] }), set: async (o) => Object.assign(s, o) },
        session: { get: async (k) => ({ [k]: s['s:' + k] }),
          set: async (o) => { for (const [k, v] of Object.entries(o)) s['s:' + k] = v; } } } };
  });
  await page.evaluate(readFileSync(join(DIST, 'content.js'), 'utf8'));
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' })));
  await page.waitForFunction(() => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.cell'), { timeout: 15000 });
  await page.evaluate(() => { const h = document.getElementById('video-scopes-host'); h.style.width = '620px'; h.style.height = '470px'; });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    Array.from(root.querySelectorAll('#modes button')).find((b) => b.textContent === 'CIE').click();
  });
  await new Promise((r) => setTimeout(r, 4000));

  const m = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell');
    // A WebGPU canvas only holds pixels once it has been presented, and
    // createImageBitmap can win that race and read transparent black. Poll
    // until the data layer is actually lit, the same way the other suites do.
    const grab = async (c, requireLit = false) => {
      let last = null;
      for (let attempt = 0; attempt < (requireLit ? 40 : 1); attempt++) {
        await new Promise((r) => requestAnimationFrame(r));
        const b = await createImageBitmap(c);
        const oc = new OffscreenCanvas(b.width, b.height);
        const x = oc.getContext('2d');
        x.drawImage(b, 0, 0);
        const d = x.getImageData(0, 0, b.width, b.height).data;
        last = { w: b.width, h: b.height, d };
        if (!requireLit) break;
        let any = 0;
        for (let i = 3; i < d.length; i += 16) {
          if (d[i] > 8) { any++; if (any > 10) break; }
        }
        if (any > 10) break;
      }
      return last;
    };
    const a = await grab(cell.querySelector('canvas.gpu'), true);
    const g = await grab(cell.querySelector('canvas.grat'));

    // Count data pixels and how much of the plot area they cover.
    let lit = 0;
    const tints = new Set();
    for (let i = 0; i < a.d.length; i += 4) {
      if (a.d[i + 3] > 20) {
        lit++;
        tints.add(`${Math.round(a.d[i] / 24)},${Math.round(a.d[i + 1] / 24)},${Math.round(a.d[i + 2] / 24)}`);
      }
    }
    // Coverage is measured inside the plot box, not the whole canvas: the
    // diagram is letterboxed to keep 1:1 axis scale, so the canvas has empty
    // margins that would otherwise dilute the number.
    const B = 32;
    const blocks = new Set();
    let minX = a.w, maxX = -1, minY = a.h, maxY = -1;
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        if (a.d[(y * a.w + x) * 4 + 3] <= 20) continue;
        blocks.add(Math.floor(x / B) + ',' + Math.floor(y / B));
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    // The plot box: use the graticule's own coloured extent as its proxy, which
    // is the locus and therefore the region of chromaticities on screen.
    let gMinX = g.w, gMaxX = -1, gMinY = g.h, gMaxY = -1;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const i = (y * g.w + x) * 4;
        const mx = Math.max(g.d[i], g.d[i + 1], g.d[i + 2]);
        const mn = Math.min(g.d[i], g.d[i + 1], g.d[i + 2]);
        if (mx > 70 && mx - mn > 45) {
          if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
          if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y;
        }
      }
    }
    const boxCols = Math.ceil((gMaxX - gMinX) / B) + 1;
    const boxRows = Math.ceil((gMaxY - gMinY) / B) + 1;
    const blocksInBox = (() => {
      let n = 0;
      for (const key of blocks) {
        const [bx, by] = key.split(',').map(Number);
        const px = bx * B, py = by * B;
        if (px >= gMinX - B && px <= gMaxX + B && py >= gMinY - B && py <= gMaxY + B) n++;
      }
      return n;
    })();
    const gratHue = [];
    for (let i = 0; i < g.d.length; i += 4) {
      const mx = Math.max(g.d[i], g.d[i + 1], g.d[i + 2]);
      const mn = Math.min(g.d[i], g.d[i + 1], g.d[i + 2]);
      if (mx > 70 && mx - mn > 45) gratHue.push(i);
    }

    // The sRGB triangle in canvas pixels, derived the same way cieFrame() places
    // the plot: CIE_BOUNDS xy is 0.8 x 0.9, fitted with equal axis scale and
    // centred. That is the region the assertion is about, so it is the right
    // denominator -- the locus extent is the whole visible gamut, roughly twice
    // as wide, and measuring against it understates the fill.
    const BW = 0.8, BH = 0.9;
    const scale = Math.min(a.w / BW, a.h / BH);
    const left = (a.w - BW * scale) / 2;
    const top = (a.h - BH * scale) / 2;
    const toPx = ([cx, cy]) => [left + cx * scale, top + (BH - cy) * scale];
    const tri = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]].map(toPx);
    const triXs = tri.map((t) => t[0]);
    const triYs = tri.map((t) => t[1]);
    const gamutBox = {
      w: Math.max(...triXs) - Math.min(...triXs),
      h: Math.max(...triYs) - Math.min(...triYs),
    };

    return {
      w: a.w, h: a.h, lit, tints: tints.size,
      coverage: +(blocksInBox / (boxCols * boxRows)).toFixed(2),
      cloudBox: { w: maxX - minX, h: maxY - minY },
      plotBox: { w: gMaxX - gMinX, h: gMaxY - gMinY },
      gamutBox,
      gratHuePx: gratHue.length,
    };
  });

  // The cloud must span the sRGB triangle, since the fixture sweeps the whole
  // sRGB hue range at fixed lightness. Rec.709 spans 0.49 in x and 0.54 in y,
  // so a correct plot fills most of that triangle; the thresholds sit below
  // 1.0 to allow for the sweep stopping short of the extreme vertices.
  const fillX = m.cloudBox.w / m.gamutBox.w;
  const fillY = m.cloudBox.h / m.gamutBox.h;
  const cloudFillsGamut = fillX > 0.6 && fillY > 0.6;
  check('the CIE cloud spans the sRGB gamut, not a few dots', cloudFillsGamut,
    `cloud ${m.cloudBox.w}x${m.cloudBox.h} of gamut ${Math.round(m.gamutBox.w)}x${Math.round(m.gamutBox.h)} ` +
      `(${(fillX * 100).toFixed(0)}% x, ${(fillY * 100).toFixed(0)}% y, ${m.lit} px)`);
  check('the cloud is genuinely multi-coloured', m.tints > 40, `${m.tints} distinct tints`);
  check('the locus is still visible underneath', m.gratHuePx > 5000, `${m.gratHuePx} hue px`);
  check('no errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');

  const shot = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const a = root.querySelector('.cell canvas.gpu');
    const g = root.querySelector('.cell canvas.grat');
    const c = document.createElement('canvas');
    c.width = a.width; c.height = a.height;
    const x = c.getContext('2d');
    x.fillStyle = '#0d1117';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(a, 0, 0);
    x.drawImage(g, 0, 0);
    return c.toDataURL('image/png');
  });
  await writeFile('docs/screenshots/cie-gradient.png', Buffer.from(shot.split(',')[1], 'base64'));
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
