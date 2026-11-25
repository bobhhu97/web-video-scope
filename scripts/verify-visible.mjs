/**
 * Proves the panel is inside the viewport, not merely present in the DOM.
 * A tall page is used deliberately: that is where a fixed element without
 * insets ends up thousands of pixels below the fold.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const FIX = resolve('tests/fixtures');
const server = createServer(async (req, res) => {
  try {
    const p = join(FIX, 'content-host.html');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(p));
  } catch { res.writeHead(404).end(); }
});
await new Promise((k) => server.listen(4260, '127.0.0.1', k));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'vis-')),
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required'],
});

const results = [];
const check = (n, ok, d) => { results.push({ n, ok, d }); console.log(`${ok?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Make the page TALL, like YouTube.
  await page.goto('http://127.0.0.1:4260/content-host.html', { waitUntil: 'networkidle2' });
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '8000px';
    document.body.appendChild(spacer);
  });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

  const code = await readFile(join(DIST, 'content.js'), 'utf8');
  await page.evaluate(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
        session: { get: async (k) => ({ [k]: store['s:' + k] }), set: async (o) => { for (const [k, v] of Object.entries(o)) store['s:' + k] = v; } },
      },
    };
  });
  await page.evaluate(code);

  // The panel is opt-in. Confirm it stays off, then ask for it the way the
  // toolbar icon does.
  const beforeClick = await page.evaluate(() => !!document.getElementById('video-scopes-host'));
  check('stays closed until asked', !beforeClick);

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
  });

  await page.waitForFunction(
    () => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.panel'),
    { timeout: 15000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));

  const geo = await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return {
      top: Math.round(r.top), left: Math.round(r.left),
      width: Math.round(r.width), height: Math.round(r.height),
      viewportH: window.innerHeight,
      styleTop: h.style.top, styleRight: h.style.right,
      hasShadow: !!h.shadowRoot?.querySelector('.panel'),
    };
  });

  check('panel exists', !!geo);
  check('panel has a shadow root with the .panel element', !!geo?.hasShadow);
  check('panel is inside the viewport vertically', !!geo && geo.top >= 0 && geo.top < geo.viewportH,
    geo ? `top=${geo.top} of ${geo.viewportH}` : 'n/a');
  check('panel is inside the viewport horizontally', !!geo && geo.left >= 0 && geo.left + geo.width <= 1280 + 1,
    geo ? `left=${geo.left} w=${geo.width}` : 'n/a');
  check('panel has a real size', !!geo && geo.width > 200 && geo.height > 100,
    geo ? `${geo.width}x${geo.height}` : 'n/a');

  await page.screenshot({ path: resolve('docs/screenshots/hud-in-viewport.png') });
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
