/**
 * End-to-end harness verification with real Chrome + real WebGPU.
 *
 * Measures pixels out of the scope canvas instead of eyeballing screenshots.
 * Two gotchas this script handles explicitly:
 *  - a WebGPU canvas needs to be *presented* (two rAFs) before
 *    createImageBitmap sees real pixels, otherwise it reads all zeros
 *  - the harness pattern puts the grey ramp on top of the bars, so the
 *    measurement samples whichever region it needs
 *
 * Usage: node scripts/verify-harness.mjs [--headed]
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve('docs/screenshots');
const DIST = resolve('dist');
const PORT = Number(process.env.HARNESS_PORT ?? 4173);
mkdirSync(OUT, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wgsl': 'text/plain; charset=utf-8',
};

// Self-contained static server: shell background processes do not survive
// between tool calls, so the verification script owns its own server.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = join(DIST, decodeURIComponent(url.pathname));
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
const BASE = `http://127.0.0.1:${PORT}`;

const headed = process.argv.includes('--headed');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: !headed,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,WebGPU',
    '--use-angle=metal',
    '--no-sandbox',
    '--window-size=1500,900',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  const pageErrors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/404/.test(t)) pageErrors.push(t);
    if (m.type() === 'warn' && /WebGPU|usage|bind group/i.test(t)) pageErrors.push(t);
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  async function load(query) {
    await page.goto(`${BASE}/test-harness.html?${query}`, { waitUntil: 'networkidle2' });
    try {
      await page.waitForFunction(
        () => {
          const s = document.getElementById('status')?.textContent ?? '';
          return /fps/.test(s) || /ERROR/.test(s);
        },
        { timeout: 20000 },
      );
    } catch {
      const diag = await page.evaluate(() => ({
        status: document.getElementById('status')?.textContent,
        video: (() => {
          const v = document.getElementById('video');
          return v ? { rs: v.readyState, w: v.videoWidth, t: v.currentTime } : null;
        })(),
        hasBundle: typeof window.__scope,
      }));
      console.log('  [diag]', query, JSON.stringify(diag));
      throw new Error(`harness never reached steady state: ${query}`);
    }
    // Let the pipeline settle and the canvas present at least once.
    await new Promise((r) => setTimeout(r, 800));
    return page.$eval('#status', (el) => el.textContent);
  }

  /** Read the presented scope canvas and locate the brightest row per column. */
  async function measure() {
    return page.evaluate(async () => {
      const canvas = document.getElementById('scope-gpu');
      // Without a presented frame createImageBitmap returns transparent pixels.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bitmap = await createImageBitmap(canvas);
      const oc = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

      const dpr = bitmap.width / canvas.clientWidth;
      const plotTop = 8 * dpr;
      const plotH = height - 8 * dpr - 16 * dpr;
      const plotLeft = 40 * dpr;
      const plotW = width - 40 * dpr - 8 * dpr;

      /**
       * Robust peak: sample a short run of columns around fracX and take the
       * median axis. A single column can land on the anti-aliased seam between
       * two bars, which reads two bins off.
       */
      const peakAxisAt = (fracX, span = 7) => {
        const cx = Math.round(plotLeft + plotW * fracX);
        const axes = [];
        const lums = [];
        for (let k = -span; k <= span; k++) {
          const x = Math.max(0, Math.min(width - 1, cx + k));
          let bestY = -1;
          let bestLum = -1;
          for (let y = 0; y < height; y++) {
            const i = (y * width + x) * 4;
            const lum = data[i] + data[i + 1] + data[i + 2];
            if (lum > bestLum) {
              bestLum = lum;
              bestY = y;
            }
          }
          axes.push(1 - (bestY - plotTop) / plotH);
          lums.push(bestLum);
        }
        axes.sort((a, b) => a - b);
        const mid = axes[Math.floor(axes.length / 2)];
        return { axis: mid, lum: Math.max(...lums), samples: axes.length };
      };

      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 40) lit++;
      }

      // Patterns are full-height, so one column fully describes one bar/step.
      return {
        width,
        height,
        dpr,
        lit,
        // Bars pattern: bar 0 = 75% white, bar 7 = 75% black.
        white: peakAxisAt(0.0625),
        black: peakAxisAt(0.9375),
        // Ramp pattern: step 0 = legal black, last step = legal white.
        rampDark: peakAxisAt(0.02),
        rampMid: peakAxisAt(0.5),
        rampBright: peakAxisAt(0.98),
      };
    });
  }

  /**
   * Save the scope panel as a PNG.
   * `page.screenshot()` does not composite a WebGPU canvas in headless Chrome,
   * so the GPU layer would come out blank. Encoding the two canvases in-page
   * (GPU density + graticule overlay) captures what the user actually sees.
   */
  async function saveScope(file) {
    const dataUrl = await page.evaluate(async () => {
      const gpuCanvas = document.getElementById('scope-gpu');
      const gratCanvas = document.getElementById('scope-grat');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bmp = await createImageBitmap(gpuCanvas);
      const out = document.createElement('canvas');
      out.width = bmp.width;
      out.height = bmp.height;
      const ctx = out.getContext('2d');
      // Panel background, then the GPU density layer, then the transparent
      // graticule overlay — the same stacking the CSS produces at runtime.
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(bmp, 0, 0);
      ctx.drawImage(gratCanvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/png').split(',')[1];
    });
    writeFileSync(resolve(OUT, file), Buffer.from(dataUrl, 'base64'));
  }

  const relIre = (axis, lo, hi) => ((axis - lo) / (hi - lo)) * 100;

  // ---- limited / IRE -------------------------------------------------------
  let status = await load('range=limited&units=ire&pattern=bars');
  check('page reached steady state', /fps/.test(status), status);
  check('analysis size is 640x360 for a 1280x720 source', /analysis 640x360/.test(status), status);

  const limited = await measure();
  check('scope renders a signal', limited.lit > 500, `${limited.lit} lit px`);

  const whiteIreLim = relIre(limited.white.axis, 16 / 255, 235 / 255);
  const blackIreLim = relIre(limited.black.axis, 16 / 255, 235 / 255);
  check('75% white bar reads 75 IRE (limited)', Math.abs(whiteIreLim - 75) < 4, `${whiteIreLim.toFixed(1)} IRE`);
  check('75% black bar reads 0 IRE (limited)', Math.abs(blackIreLim) < 4, `${blackIreLim.toFixed(1)} IRE`);
  check(
    'legal black sits above the plot floor (footroom visible)',
    limited.black.axis > 0.03,
    `axis=${limited.black.axis.toFixed(4)}`,
  );

  await saveScope('task8-waveform-limited.png');

  // ---- axis linearity on the ramp pattern ---------------------------------
  await load('range=limited&units=ire&pattern=ramp');
  const ramp = await measure();
  check(
    'grey ramp is monotonic dark -> bright',
    ramp.rampDark.axis < ramp.rampMid.axis && ramp.rampMid.axis < ramp.rampBright.axis,
    `${ramp.rampDark.axis.toFixed(3)} < ${ramp.rampMid.axis.toFixed(3)} < ${ramp.rampBright.axis.toFixed(3)}`,
  );
  check(
    'ramp black end sits at 0 IRE and white end at 100 IRE',
    Math.abs(relIre(ramp.rampDark.axis, 16 / 255, 235 / 255)) < 5 &&
      Math.abs(relIre(ramp.rampBright.axis, 16 / 255, 235 / 255) - 100) < 5,
    `${relIre(ramp.rampDark.axis, 16 / 255, 235 / 255).toFixed(1)} .. ${relIre(ramp.rampBright.axis, 16 / 255, 235 / 255).toFixed(1)} IRE`,
  );
  await saveScope('task8-ramp.png');

  // ---- full / IRE ----------------------------------------------------------
  status = await load('range=full&units=ire&pattern=bars');
  const full = await measure();
  const whiteIreFull = relIre(full.white.axis, 0, 1);
  check('75% white bar reads 75 IRE (full)', Math.abs(whiteIreFull - 75) < 4, `${whiteIreFull.toFixed(1)} IRE`);
  check(
    'limited vs full place the same signal differently on the axis',
    Math.abs(limited.white.axis - full.white.axis) > 0.02,
    `limited=${limited.white.axis.toFixed(3)} full=${full.white.axis.toFixed(3)}`,
  );
  await saveScope('task8-waveform-full.png');

  // ---- units must not move the geometry -----------------------------------
  await load('range=limited&units=code8&pattern=bars');
  const code8 = await measure();
  check(
    'switching IRE -> 8-bit does not move the trace',
    Math.abs(code8.white.axis - limited.white.axis) < 0.02,
    `ire=${limited.white.axis.toFixed(4)} code8=${code8.white.axis.toFixed(4)}`,
  );
  await saveScope('task8-units-code8.png');

  await load('range=limited&units=nits&pattern=bars');
  const nits = await measure();
  check(
    'switching IRE -> nits does not move the trace either',
    Math.abs(nits.white.axis - limited.white.axis) < 0.02,
    `ire=${limited.white.axis.toFixed(4)} nits=${nits.white.axis.toFixed(4)}`,
  );

  // ---- other modes render -------------------------------------------------
  // A waveform fills whole columns; a vectorscope / CIE plot is a point cloud
  // with only a few pixels per cluster. Judging both by "lit pixel count"
  // would either fail the scopes or pass a broken waveform.
  for (const [mode, shot, minLit] of [
    ['waveform-rgb', 'task8-rgb-overlay.png', 300],
    ['waveform-parade', 'task8-parade.png', 200],
    ['vectorscope', 'task9-vectorscope.png', 8],
    ['cie', 'task10-cie.png', 8],
  ]) {
    await load(`range=limited&mode=${mode}&pattern=bars`);
    const m = await measure();
    check(`${mode} renders a signal`, m.lit >= minLit, `${m.lit} lit px (min ${minLit})`);
    await saveScope(shot);
  }

  // ---- geometry sanity for the point-cloud scopes -------------------------
  // Colour bars must land in DIFFERENT places, otherwise the chroma math is
  // collapsing every hue onto one spot.
  const spread = await page.evaluate(async () => {
    const canvas = document.getElementById('scope-gpu');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const bmp = await createImageBitmap(canvas);
    const oc = new OffscreenCanvas(bmp.width, bmp.height);
    const c = oc.getContext('2d');
    c.drawImage(bmp, 0, 0);
    const d = c.getImageData(0, 0, bmp.width, bmp.height).data;
    const pts = [];
    for (let y = 0; y < bmp.height; y += 2) {
      for (let x = 0; x < bmp.width; x += 2) {
        const i = (y * bmp.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 120) pts.push([x, y]);
      }
    }
    if (pts.length < 2) return { spread: 0, count: pts.length };
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return {
      spread: Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
      count: pts.length,
    };
  });
  check(
    'CIE plot spreads the bars over the diagram (distinct chromaticities)',
    spread.spread > 60,
    `spread=${spread.spread.toFixed(0)}px over ${spread.count} points`,
  );

  // ---- analysis preset ----------------------------------------------------
  status = await load('range=limited&analysis=low&pattern=bars');
  check('low preset shrinks the analysis texture', /analysis 320x180/.test(status), status);
  await saveScope('task7-analysis-low.png');

  // ---- no WebGPU validation errors ---------------------------------------
  const unexpected = pageErrors.filter((e) => !/favicon/i.test(e));
  check('no WebGPU validation errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '));
} finally {
  await browser.close();
  await new Promise((ok) => server.close(ok));
}

const failed = results.filter((r) => !r.ok);
writeFileSync(
  resolve(OUT, 'verification.json'),
  JSON.stringify({ when: new Date().toISOString(), results }, null, 2),
);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
