/**
 * Capture the README screenshots.
 *
 * Runs the built content script in real Chrome with hardware WebGPU (the same
 * flags the pixel-measurement suites use), on a demo watch page in docs/demo/,
 * so each screenshot shows a real scope reading a real frame.
 *
 *   node scripts/capture-readme.mjs            # all shots
 *   node scripts/capture-readme.mjs --headed   # watch it happen
 *
 * Screenshots land in docs/screenshots/readme-*.png at 2x device pixels, which
 * GitHub downsamples to a crisp 1x in the README.
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DIST = resolve('dist');
const DEMO = resolve('docs/demo');
const OUT = resolve('docs/screenshots');
const PORT = 4391;
const headed = process.argv.includes('--headed');
mkdirSync(OUT, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const fromDemo = path === '/' || path === '/index.html';
    const file = fromDemo ? join(DEMO, 'index.html') : join(DIST, path);
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
  headless: !headed,
  userDataDir: mkdtempSync(join(tmpdir(), 'readme-')),
  args: [
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

/** State presets. Every capture seeds chrome.storage with one of these. */
const BASE = {
  visible: true, lang: 'en', layout: 'grid', activeSlot: 0, mode: 'waveform-rgb',
  precision: 'auto', hdrMode: 'auto', primariesMode: 'auto',
  sdrWhiteNits: 203, nitLow: 100, nitHigh: 1000,
  videoFalseColor: false, falseColorPreset: 'auto', falseColorOpacity: 0.88, falseColorLegend: true,
  eyedropperEnabled: false,
  panelOpacity: 0.98, graticuleBrightness: 1.0,
  units: 'ire', gain: 0.9, gamma: 0.9, zoom: 1,
  rangeMode: 'auto', matrixMode: 'auto', barTargets: 0.75, coord: 'xy',
  signalMode: 'display', gamuts: ['rec709', 'p3'],
  panels: {}, cells: {}, analysisFps: 30, lockedTier: null,
  hostPosition: { left: null, top: 16, right: 16 },
};

const cell = (mode, over = {}) => ({
  mode, waveChannels: mode === 'waveform-rgb' ? 'RGB' : 'Y', paradeMode: 'RGB', histMode: 'YRGB',
  traceMode: mode === 'vectorscope' || mode === 'cie' ? 'colorize' : 'channel',
  lowPass: false, units: 'ire', gain: 0.9, gamma: 0.9, barTargets: 0.75, showSkinLine: true,
  toneFilter: 'all', coord: 'xy', gamuts: ['rec709', 'p3'], zoom: 1, panX: null, panY: null, ...over,
});

const state = (over = {}) => ({ ...BASE, ...over });

const GRID = state({
  layout: 'grid',
  cells: {
    grid: [
      cell('waveform-rgb', { traceMode: 'channel' }),
      cell('waveform-parade', { paradeMode: 'RGB' }),
      cell('vectorscope', { zoom: 1.35 }),
      cell('cie', { gamuts: ['rec709', 'p3'] }),
    ],
  },
  panels: { grid: ['waveform-rgb', 'waveform-parade', 'vectorscope', 'cie'] },
});

const WAVE = state({
  layout: 'single', mode: 'waveform-luma', activeSlot: 0,
  cells: { single: [cell('waveform-luma', { waveChannels: 'Y', traceMode: 'green' })] },
  panels: { single: ['waveform-luma'] },
});

const VECTOR = state({
  layout: 'single', mode: 'vectorscope', activeSlot: 0,
  cells: { single: [cell('vectorscope', { barTargets: 0.75, showSkinLine: true, zoom: 1.15 })] },
  panels: { single: ['vectorscope'] },
});

const CIE = state({
  layout: 'single', mode: 'cie', activeSlot: 0,
  cells: { single: [cell('cie', { coord: 'xy', gamuts: ['rec709', 'p3', 'rec2020'], zoom: 1.05 })] },
  panels: { single: ['cie'] },
});

const PARADE = state({
  layout: 'single', mode: 'waveform-parade', activeSlot: 0,
  cells: { single: [cell('waveform-parade', { paradeMode: 'RGB' })] },
  panels: { single: ['waveform-parade'] },
});

/**
 * Inject the built bundle exactly as Chrome does, and open the panel.
 *
 * The seeded layout does not survive startup on its own: `enable()` restores the
 * saved settings but keeps the layout the in-memory state already had, so a
 * seeded `single` layout comes back as the default `grid`. Pressing the layout
 * button is the real user path to switch, and it re-renders the cells from the
 * saved per-layout config, which is exactly what the shot needs.
 */
async function boot({ viewport, pattern, state: seed }) {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
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
  }, seed);
  await page.goto(`http://127.0.0.1:${PORT}/?pattern=${pattern}&vsInline=1`, {
    waitUntil: 'networkidle2',
  });
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
  const wanted = seed.layout ?? 'grid';
  const btnLabel = { single: '1', pair: '2', triple: '3', grid: '4' }[wanted];
  if (btnLabel) {
    await page.evaluate((label) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const btn = [...root.querySelectorAll('#layouts button')]
        .find((b) => b.textContent.trim() === label);
      btn?.click();
    }, btnLabel);
  }
  return page;
}

/** Place and size the panel deterministically, then let the scopes settle. */
async function place(page, box) {
  await page.evaluate((b) => {
    const host = document.getElementById('video-scopes-host');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('right', b.right + 'px', 'important');
    host.style.setProperty('left', 'auto', 'important');
    host.style.setProperty('top', b.top + 'px', 'important');
    host.style.setProperty('width', b.width + 'px', 'important');
    host.style.setProperty('height', b.height + 'px', 'important');
    window.dispatchEvent(new Event('resize'));
  }, box);
  // Poll for a lit canvas rather than a fixed delay: a WebGPU canvas only holds
  // pixels after it has been presented.
  await page.waitForFunction(() => {
    const root = document.getElementById('video-scopes-host')?.shadowRoot;
    const perf = root?.querySelector('#perf')?.textContent ?? '';
    const m = /^(\d+)fps/.exec(perf);
    return m && Number(m[1]) >= 10;
  }, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200));
}

/**
 * Measure each scope canvas: how many pixels are lit, how wide the data spans,
 * and how coloured it is. Used to prove a shot is not an empty scope before it
 * ships in the README.
 */
async function measure(page) {
  return page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host')?.shadowRoot;
    if (!root) return [];
    const out = [];
    for (const cellEl of root.querySelectorAll('.cell')) {
      const canvas = cellEl.querySelector('canvas.gpu');
      if (!canvas) continue;
      // A WebGPU canvas only holds pixels after a present, and createImageBitmap
      // can win that race and read transparent black, so poll for alpha.
      let bmp = null, d = null;
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise((r) => requestAnimationFrame(r));
        bmp = await createImageBitmap(canvas);
        const oc = new OffscreenCanvas(bmp.width, bmp.height);
        const c = oc.getContext('2d');
        c.drawImage(bmp, 0, 0);
        d = c.getImageData(0, 0, bmp.width, bmp.height).data;
        let any = 0;
        for (let i = 3; i < d.length; i += 16) { if (d[i] > 8) { any++; if (any > 10) break; } }
        if (any > 10) break;
      }
      let lit = 0, coloured = 0;
      let minX = bmp.width, maxX = -1, minY = bmp.height, maxY = -1;
      for (let y = 0; y < bmp.height; y++) {
        for (let x = 0; x < bmp.width; x++) {
          const i = (y * bmp.width + x) * 4;
          if (d[i + 3] <= 8) continue;
          lit++;
          const mx = Math.max(d[i], d[i + 1], d[i + 2]);
          const mn = Math.min(d[i], d[i + 1], d[i + 2]);
          if (mx - mn > 40) coloured++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      out.push({
        mode: cellEl.dataset.mode,
        lit,
        colouredPct: Math.round((coloured / Math.max(1, lit)) * 100),
        spanX: maxX < 0 ? 0 : Math.round(((maxX - minX) / bmp.width) * 100),
        spanY: maxY < 0 ? 0 : Math.round(((maxY - minY) / bmp.height) * 100),
      });
    }
    return out;
  });
}

async function shoot(page, name, clip) {
  const path = join(OUT, `readme-${name}.png`);
  const measured = await measure(page);
  await page.screenshot(clip ? { path, clip } : { path });
  return { path, measured };
}

const shots = [];
const report = [];

// 1. Hero: the four-panel grid over the cinematic plate.
{
  const page = await boot({ viewport: { width: 1560, height: 890 }, pattern: 'cinematic', state: GRID });
  await place(page, { width: 700, height: 600, right: 20, top: 20 });
  const g = await page.evaluate(() => {
    const host = document.getElementById('video-scopes-host');
    const r = host.getBoundingClientRect();
    const root = host.shadowRoot;
    return {
      host: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      perf: root.querySelector('#perf')?.textContent,
      status: root.querySelector('#status')?.textContent,
      cs: root.querySelector('#cs')?.textContent,
      cells: [...root.querySelectorAll('.cell')].map((c) => c.dataset.mode),
    };
  });
  report.push({ name: 'hero', ...g });
  shots.push(await shoot(page, 'hero'));
  await page.close();
}

// 2-5. Single-scope close-ups, cropped to the panel only.
//   - the waveform uses continuous-tone footage, which is what a real trace
//     looks like (bars would only ever draw flat steps)
//   - the vectorscope and CIE use the hue x saturation sweep, the fixture that
//     actually fills a scatter plot
const closeups = [
  ['waveform', WAVE, 'cinematic'],
  ['parade', PARADE, 'bars'],
  ['vectorscope', VECTOR, 'spectrum'],
  ['cie', CIE, 'spectrum'],
];
for (const [name, seed, pattern] of closeups) {
  const page = await boot({ viewport: { width: 1200, height: 900 }, pattern, state: seed });
  await place(page, { width: 760, height: 520, right: 20, top: 20 });
  const clip = await page.evaluate(() => {
    const r = document.getElementById('video-scopes-host').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
  report.push({ name, clip });
  shots.push(await shoot(page, name, clip));
  await page.close();
}

// 6. Floating window / false colour on the video itself.
{
  const page = await boot({
    viewport: { width: 1560, height: 890 },
    pattern: 'cinematic',
    state: state({
      layout: 'pair',
      videoFalseColor: true,
      falseColorPreset: 'arri',
      falseColorLegend: true,
      cells: { pair: [cell('waveform-rgb'), cell('vectorscope')] },
      panels: { pair: ['waveform-rgb', 'vectorscope'] },
    }),
  });
  await place(page, { width: 560, height: 420, right: 20, top: 20 });
  await new Promise((r) => setTimeout(r, 1500));
  report.push({ name: 'false-color' });
  shots.push(await shoot(page, 'false-color'));
  await page.close();
}

await browser.close();
server.close();

const summary = shots.map((s) => ({ ...s, path: s.path.replace(process.cwd() + '/', '') }));
await writeFile(join(OUT, 'readme-report.json'), JSON.stringify({ shots: summary, report }, null, 2));
console.log(JSON.stringify({ shots: summary, report }, null, 2));
