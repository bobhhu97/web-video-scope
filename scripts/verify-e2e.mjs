/**
 * End-to-end test of the real extension: loads dist/content.js into a page that
 * contains a live <video>, exactly as Chrome would inject it, and verifies the
 * whole pipeline (detect -> capture -> downscale -> scopes -> HUD).
 *
 * This is the closest reproducible substitute for "install the unpacked
 * extension and open a video page". MV3 unpacked installs cannot be automated
 * headlessly, but everything downstream of injection can.
 */
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIST = resolve('dist');
const OUT = resolve('docs/screenshots');
const PORT = 4181;
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const server = createServer(async (req, res) => {
  try {
    const path = join(DIST, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!path.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
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
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--use-angle=metal',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });

  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/404|favicon/.test(t)) errors.push(t);
    if (m.type() === 'warn' && /webgpu|usage|bind group/i.test(t)) errors.push(t);
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // The content script talks to chrome.runtime; provide the storage-backed API
  // it needs so it can run outside an extension context.
  await page.evaluateOnNewDocument(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        local: {
          get: async (k) => ({ [k]: store[k] }),
          set: async (o) => Object.assign(store, o),
        },
      },
    };
  });

  await page.goto(`http://127.0.0.1:${PORT}/content-host.html`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });
  check('host page has a playing video with metadata', true);

  // Inject the built content script, exactly as Chrome does for a content script.
  const contentJs = readFileSync(resolve(DIST, 'content.js'), 'utf8');
  await page.evaluate(contentJs);

  // Toggle via the extension's own keyboard shortcut.
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Alt');

  await page.waitForFunction(
    () => document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.grid') !== null,
    { timeout: 10000 },
  );
  check('HUD mounts in a shadow root on Alt+S', true);

  // Wait for the scopes to actually render something.
  // Wait for the pipeline to be genuinely running: a steady frame rate AND
  // pixels on a scope canvas. The first badge update only covers the startup
  // window, so waiting on it alone would race the first real render.
  async function scopeHasPixels() {
    return page.evaluate(async () => {
      const root = document.getElementById('video-scopes-host')?.shadowRoot;
      const canvas = root?.querySelector('canvas.gpu');
      if (!canvas) return 0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bmp = await createImageBitmap(canvas);
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const c = oc.getContext('2d');
      c.drawImage(bmp, 0, 0);
      const d = c.getImageData(0, 0, bmp.width, bmp.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 40) n++;
      return n;
    });
  }

  let litPixels = 0;
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById('video-scopes-host')?.shadowRoot;
        const perf = root?.getElementById('perf')?.textContent ?? '';
        return /\d+ fps/.test(perf);
      },
      { timeout: 20000 },
    );
    // Give the governor a moment to settle, then confirm real pixels.
    for (let i = 0; i < 40 && litPixels <= 200; i++) {
      await new Promise((r) => setTimeout(r, 250));
      litPixels = await scopeHasPixels();
    }
  } catch {
    const diag = await page.evaluate(() => {
      const root = document.getElementById('video-scopes-host')?.shadowRoot;
      return {
        perf: root?.getElementById('perf')?.textContent,
        status: root?.getElementById('status')?.textContent,
        cs: root?.getElementById('cs')?.textContent,
        notice: root?.getElementById('notice')?.textContent,
        video: (() => {
          const v = document.querySelector('video');
          return v ? { rs: v.readyState, t: v.currentTime, w: v.videoWidth, w2: v.videoWidth } : null;
        })(),
        perfText: root?.getElementById('perf')?.outerHTML,
      };
    });
    console.log('  [diag]', JSON.stringify(diag));
    console.log('  [errors]', JSON.stringify(errors.slice(0, 6)));
    throw new Error('scopes never produced a frame rate');
  }

  const info = await page.evaluate(() => {
    const host = document.getElementById('video-scopes-host');
    const root = host?.shadowRoot;
    const cells = Array.from(root?.querySelectorAll('.cell') ?? []);
    return {
      status: root?.getElementById('status')?.textContent,
      cs: root?.getElementById('cs')?.textContent,
      perf: root?.getElementById('perf')?.textContent,
      panels: cells.map((c) => c.dataset.mode),
      canvases: cells.map((c) => {
        const g = c.querySelector('canvas.gpu');
        return { mode: c.dataset.mode, w: g.width, h: g.height };
      }),
      hostPosition: getComputedStyle(host).position,
      zIndex: host.style.zIndex,
    };
  });

  check('scope panels exist for the default 2x2 layout', info.panels.length === 4, info.panels.join(','));
  check(
    'colour metadata was read from the video',
    /BT709|BT601|BT2020/.test(info.cs ?? ''),
    info.cs,
  );
  check('range diagnosis produced a verdict', /limited|full/.test(info.status ?? ''), info.status);
  check('perf badge shows a live frame rate', /\d+ fps/.test(info.perf ?? ''), info.perf);
  check('host is position:fixed with the documented z-index',
    info.hostPosition === 'fixed' && info.zIndex === '2147483646',
    `${info.hostPosition} / ${info.zIndex}`);
  check('every panel has a sized GPU canvas',
    info.canvases.every((c) => c.w > 0 && c.h > 0),
    JSON.stringify(info.canvases));

  check('a scope canvas contains a rendered trace', litPixels > 200, `${litPixels} lit px`);

  // Saving must persist the visible flag so the panel comes back on reload.
  const persisted = await page.evaluate(async () => {
    const store = await chrome.storage.local.get('video-scopes:state');
    return store['video-scopes:state'];
  });
  // Steady-state frame rate. The source here is a 30 fps captureStream, so the
  // achievable ceiling is ~30 and the pipeline sustains ~29 with four panels
  // open. Measurement waits for the governor to settle: sampling during
  // warm-up reports the startup average and understates the real rate.
  await new Promise((r) => setTimeout(r, 6000));
  const perfNow = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host')?.shadowRoot;
    return root?.getElementById('perf')?.textContent;
  });
  const fps = Number((perfNow ?? '').match(/(\d+) fps/)?.[1] ?? 0);
  check('analysis reaches a steady frame rate near the source ceiling', fps >= 20, perfNow);
  check('state persists visible=true to chrome.storage', persisted?.visible === true,
    JSON.stringify(persisted?.visible));

  // Toggle off with the same shortcut.
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Alt');
  await page.waitForFunction(() => document.getElementById('video-scopes-host') === null, {
    timeout: 8000,
  });
  check('HUD unmounts on the second Alt+S', true);

  const afterOff = await page.evaluate(async () => {
    const store = await chrome.storage.local.get('video-scopes:state');
    return store['video-scopes:state']?.visible;
  });
  check('state persists visible=false after closing', afterOff === false, String(afterOff));

  check('no uncaught errors or WebGPU validation errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}

const failed = results.filter((r) => !r.ok);
writeFileSync(
  resolve(OUT, 'e2e-verification.json'),
  JSON.stringify({ when: new Date().toISOString(), results }, null, 2),
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
