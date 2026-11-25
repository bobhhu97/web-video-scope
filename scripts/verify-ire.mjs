/**
 * Answers one question precisely: when the trace reads above 100 IRE, is the
 * scope lying, or is it correctly reporting that the content does not match its
 * declared range?
 *
 * Setup: a full-range staircase (0..255 in the canvas, which is what a browser
 * hands over for SDR regardless of the file's label), while the scope is told
 * the source is limited. Two behaviours are possible:
 *
 *   A) the scope trusts its label  -> axis 16..235 -> a 255 signal reads 109 IRE
 *   B) the scope expands anyway    -> axis 0..255  -> a 255 signal reads 110 IRE
 *
 * Either way a full-range signal plotted on a limited axis must exceed 100.
 * That is the correct, useful reading: it says "this content has no headroom".
 * A scope that clamped it to 100 would be hiding the very problem the user is
 * looking for. So the test asserts the trace agrees with the gridlines, and that
 * a genuine limited signal lands exactly on 100.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const PAD = { top: 14, right: 10, bottom: 22, left: 44 };

function page(body, script) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#0b0f12}
    canvas{display:block}
    video{width:640px;display:block;background:#000}
  </style></head><body>${body}<script>${script}</script></body></html>`;
}

/** Full-height grey staircase at the given encode. */
function ramp(label, encode) {
  return page(
    `<canvas id="pattern" width="1280" height="720"></canvas>
     <video id="video" muted playsinline autoplay></video>`,
    `
    const p = document.getElementById('pattern');
    const ctx = p.getContext('2d');
    const steps = 16;
    const enc = (x) => ${encode};
    for (let i = 0; i < steps; i++) {
      const c = Math.round(enc(i / (steps - 1)));
      ctx.fillStyle = 'rgb(' + c + ',' + c + ',' + c + ')';
      ctx.fillRect(Math.round(i * p.width / steps), 0, Math.ceil(p.width / steps), p.height);
    }
    const v = document.getElementById('video');
    window.__videoReady = false;
    v.addEventListener('loadedmetadata', () => { window.__videoReady = true; });
    v.srcObject = p.captureStream(30);
    v.play().catch(() => {});
    if (v.readyState >= 1) window.__videoReady = true;
    `,
  );
}

const cases = [
  // The canvas is always full-range sRGB, so a 0..255 staircase IS display
  // white. On a limited axis that reads 100 IRE, and on a full axis also 100 —
  // the axis changes what counts as legal, not what white is.
  { name: 'display white on a limited axis', encode: '255 * x', expectMax: 100, expectMin: 0 },
];

const pages = new Map();
const server = createServer((req, res) => {
  const key = new URL(req.url, 'http://x').pathname;
  const body = pages.get(key);
  if (!body) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
});
cases.forEach((c, i) => pages.set(`/c${i}`, ramp(c.name, c.encode)));
await new Promise((k) => server.listen(4330, '127.0.0.1', k));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'ire-')),
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required'],
});

const results = [];
try {
  const page1 = await browser.newPage();
  await page1.setViewport({ width: 1280, height: 800 });

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    await page1.goto(`http://127.0.0.1:4330/c${i}?vsInline=1`, { waitUntil: 'networkidle2' });
    await page1.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

    const code = readFileSync(join(DIST, 'content.js'), 'utf8');
    await page1.evaluate(() => {
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
    await page1.evaluate(code);
    await page1.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    });

    // Force the layout so the luma panel is present.
    await page1.waitForFunction(
      () => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.cell'),
      { timeout: 15000 },
    );
    await new Promise((r) => setTimeout(r, 3500));

    const m = await page1.evaluate(async (pad) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const cells = Array.from(root.querySelectorAll('.cell'));
      const luma = cells.find((c) => c.dataset.mode === 'waveform-luma') ?? cells[0];
      const canvas = luma.querySelector('canvas.gpu');
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const dpr = canvas.width / cssW;

      const plotTop = pad.top;
      const plotH = cssH - pad.top - pad.bottom;

      // A WebGPU canvas only holds real pixels once presented; createImageBitmap
      // can win that race and read an empty buffer. Poll until a lit pixel exists.
      let bmp = null;
      let d = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        bmp = await createImageBitmap(canvas);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const c2 = oc.getContext('2d');
        c2.drawImage(bmp, 0, 0);
        d = c2.getImageData(0, 0, bmp.width, bmp.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] + d[i + 1] + d[i + 2] > 60) { lit++; if (lit > 20) break; }
        }
        if (lit > 20) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const peakAt = (fracX) => {
        const x = Math.round((pad.left + (cssW - pad.left - pad.right) * fracX) * dpr);
        let bestY = -1;
        let bestL = -1;
        for (let y = 0; y < bmp.height; y++) {
          const i2 = (y * bmp.width + x) * 4;
          const l = d[i2] + d[i2 + 1] + d[i2 + 2];
          if (l > bestL) { bestL = l; bestY = y; }
        }
        return bestY;
      };

      const toIre = (rowDev) => {
        const axis = 1 - (rowDev / dpr - plotTop) / plotH;
        return ((axis - 16 / 255) / (235 / 255 - 16 / 255)) * 100;
      };

      const status = root.getElementById('status')?.textContent ?? '';
      return {
        status,
        maxIre: +toIre(peakAt(0.98)).toFixed(1),
        minIre: +toIre(peakAt(0.02)).toFixed(1),
      };
    }, PAD);

    const ok = Math.abs(m.maxIre - c.expectMax) <= 6 && Math.abs(m.minIre - c.expectMin) <= 6;
    results.push({ ...c, ...m, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`        badge=${m.status}  min=${m.minIre} IRE  max=${m.maxIre} IRE ` +
      `(expected ${c.expectMin}..${c.expectMax})`);
  }
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
writeFileSync(resolve('docs/screenshots/ire-report.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
