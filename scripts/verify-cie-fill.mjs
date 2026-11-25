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
    const grab = async (c) => {
      const b = await createImageBitmap(c);
      const oc = new OffscreenCanvas(b.width, b.height);
      const x = oc.getContext('2d');
      x.drawImage(b, 0, 0);
      return { w: b.width, h: b.height, d: x.getImageData(0, 0, b.width, b.height).data };
    };
    const a = await grab(cell.querySelector('canvas.gpu'));
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
    // Coverage: fraction of 32x32 blocks that contain any lit pixel.
    const B = 32;
    const cols = Math.ceil(a.w / B);
    const rows = Math.ceil(a.h / B);
    const blocks = new Set();
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        if (a.d[(y * a.w + x) * 4 + 3] > 20) blocks.add(Math.floor(x / B) + ',' + Math.floor(y / B));
      }
    }
    const gratHue = [];
    for (let i = 0; i < g.d.length; i += 4) {
      const mx = Math.max(g.d[i], g.d[i + 1], g.d[i + 2]);
      const mn = Math.min(g.d[i], g.d[i + 1], g.d[i + 2]);
      if (mx > 70 && mx - mn > 45) gratHue.push(i);
    }
    return {
      w: a.w, h: a.h, lit, tints: tints.size,
      coverage: +(blocks.size / (cols * rows)).toFixed(2),
      gratHuePx: gratHue.length,
    };
  });

  check('the CIE cloud covers a large part of the plot', m.coverage > 0.15,
    `${(m.coverage * 100).toFixed(0)}% of the panel has data (${m.lit} px)`);
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
