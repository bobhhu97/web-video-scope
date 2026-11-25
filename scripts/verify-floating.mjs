/**
 * End-to-end check of the floating window presentation.
 *
 * The panel has to survive real Chrome: the click must open a Document PiP
 * window, the HUD must be inside it, and it must keep rendering there. This is
 * the presentation the user asked for, so it is tested directly rather than
 * inferred from the in-page overlay working.
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
await new Promise((k) => server.listen(4300, '127.0.0.1', k));

const results = [];
const check = (n, ok, d) => {
  results.push({ n, ok, d });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false, // Document PiP needs a real window
  userDataDir: mkdtempSync(join(tmpdir(), 'float-')),
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-first-run',
    '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:4300/x', { waitUntil: 'networkidle2' });
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
  await new Promise((r) => setTimeout(r, 400));

  const offByDefault = await page.evaluate(() => !document.getElementById('video-scopes-host'));
  check('stays closed until asked', offByDefault);

  // Ask for it the way the toolbar icon does.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
  });

  // A Document PiP window appears as an extra about:blank page target. There
  // can be more than one blank target, so probe each for the host element
  // rather than assuming the first new one is ours.
  let pipPage = null;
  for (let i = 0; i < 40 && !pipPage; i++) {
    await new Promise((r) => setTimeout(r, 250));
    for (const t of browser.targets()) {
      if (t.type() !== 'page') continue;
      if (t === page.target()) continue;
      if (!t.url().startsWith('about:blank')) continue;
      try {
        const candidate = await t.page();
        if (await candidate.evaluate(() => !!document.getElementById('video-scopes-host'))) {
          pipPage = candidate;
          break;
        }
      } catch {
        // Target still initialising.
      }
    }
  }

  check('a separate window is created', pipPage !== null);

  if (pipPage) {
    const inside = await pipPage.evaluate(() => {
      const h = document.getElementById('video-scopes-host');
      return {
        hasHost: !!h,
        hasPanel: !!h?.shadowRoot?.querySelector('.panel'),
        cells: h?.shadowRoot?.querySelectorAll('.cell').length ?? 0,
        size: h ? `${Math.round(h.getBoundingClientRect().width)}x${Math.round(h.getBoundingClientRect().height)}` : null,
      };
    });
    check('the HUD is inside the separate window', inside.hasHost && inside.hasPanel, JSON.stringify(inside));
    check('all four scope panels travelled with it', inside.cells === 4, `${inside.cells} cells`);

    // Let the pipeline run inside the new window.
    let lit = 0;
    for (let i = 0; i < 40 && lit <= 100; i++) {
      await new Promise((r) => setTimeout(r, 250));
      lit = await pipPage.evaluate(async () => {
        const root = document.getElementById('video-scopes-host')?.shadowRoot;
        const c = root?.querySelector('canvas.gpu');
        if (!c) return 0;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const bmp = await createImageBitmap(c);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const x = oc.getContext('2d');
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
        let n = 0;
        for (let k = 0; k < d.length; k += 4) if (d[k] + d[k + 1] + d[k + 2] > 40) n++;
        return n;
      });
    }
    check('scopes render inside the separate window', lit > 100, `${lit} lit px`);
    await pipPage.screenshot({ path: resolve('docs/screenshots/floating-window.png') });
  }
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
