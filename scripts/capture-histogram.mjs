/**
 * One-off capture of the Histogram scope for the README "all five scopes"
 * strip. Mirrors scripts/capture-readme.mjs but with a single histogram cell.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIST = resolve('dist');
const DEMO = resolve('docs/demo');
const OUT = resolve('docs/screenshots');
const PORT = 4392;
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = path === '/' || path === '/index.html' ? join(DEMO, 'index.html') : join(DIST, path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[file.endsWith('.js') ? '.js' : '.html'] });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'readme-hist-')),
  args: [
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const BASE = {
  visible: true, lang: 'en', layout: 'single', activeSlot: 0, mode: 'histogram',
  precision: 'auto', hdrMode: 'auto', primariesMode: 'auto',
  sdrWhiteNits: 203, nitLow: 100, nitHigh: 1000,
  videoFalseColor: false, falseColorPreset: 'auto', falseColorOpacity: 0.88, falseColorLegend: true,
  eyedropperEnabled: false,
  panelOpacity: 0.98, graticuleBrightness: 1.0,
  units: 'ire', gain: 0.9, gamma: 0.9, zoom: 1,
  rangeMode: 'auto', matrixMode: 'auto', barTargets: 0.75, coord: 'xy',
  signalMode: 'display', gamuts: ['rec709', 'p3'],
  panels: { single: ['histogram'] }, analysisFps: 30, lockedTier: null,
  hostPosition: { left: null, top: 16, right: 16 },
};
const HIST = {
  ...BASE,
  cells: {
    single: [{
      mode: 'histogram', waveChannels: 'Y', paradeMode: 'RGB', histMode: 'YRGB',
      traceMode: 'channel', lowPass: false, units: 'ire', gain: 0.9, gamma: 0.9,
      barTargets: 0.75, showSkinLine: true, toneFilter: 'all', coord: 'xy',
      gamuts: ['rec709', 'p3'], zoom: 1, panX: null, panY: null,
    }],
  },
};

const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument((s) => {
  const store = { 'video-scopes:state': s };
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
}, HIST);
await page.goto(`http://127.0.0.1:${PORT}/?pattern=cinematic&vsInline=1`, { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__videoReady === true, { timeout: 20000 });
const code = await readFile(join(DIST, 'content.js'), 'utf8');
await page.evaluate(code);
await page.keyboard.down('Alt');
await page.keyboard.press('KeyS');
await page.keyboard.up('Alt');
await page.waitForFunction(
  () => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.panel'),
  { timeout: 20000 },
);
await page.evaluate(() => {
  const root = document.getElementById('video-scopes-host').shadowRoot;
  root.querySelector('#layouts button[data-layout="single"]')?.click();
});
await page.evaluate(() => {
  const host = document.getElementById('video-scopes-host');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('right', '20px', 'important');
  host.style.setProperty('left', 'auto', 'important');
  host.style.setProperty('top', '20px', 'important');
  host.style.setProperty('width', '760px', 'important');
  host.style.setProperty('height', '520px', 'important');
  window.dispatchEvent(new Event('resize'));
});
await page.waitForFunction(() => {
  const root = document.getElementById('video-scopes-host')?.shadowRoot;
  const perf = root?.querySelector('#perf')?.textContent ?? '';
  const m = /^(\d+)fps/.exec(perf);
  return m && Number(m[1]) >= 10;
}, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));

const info = await page.evaluate(() => {
  const host = document.getElementById('video-scopes-host');
  const r = host.getBoundingClientRect();
  const root = host.shadowRoot;
  return {
    clip: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    mode: root.querySelector('.cell')?.dataset.mode,
    perf: root.querySelector('#perf')?.textContent,
  };
});
console.log(JSON.stringify(info));
await page.screenshot({ path: join(OUT, 'readme-histogram.png'), clip: info.clip });

await browser.close();
server.close();
