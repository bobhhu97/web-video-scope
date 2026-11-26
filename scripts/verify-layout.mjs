/**
 * Checks the rebuilt layout against the complaints that prompted it:
 *  - are all scopes reachable, and can one be chosen?
 *  - do the controls stay visible when the window is small?
 *  - does the trace stay inside the plot, with tick labels present?
 *
 * Runs at deviceScaleFactor 2, because the "trace spills past the border" bug
 * only appeared on a Retina display: the renderer was given device pixels but
 * subtracted CSS-pixel margins.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
// Must match WAVE_PAD in src/ui/graticule.ts.
const PAD = { top: 14, right: 10, bottom: 22, left: 44 };
const FIX = resolve('tests/fixtures');
const server = createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(await readFile(join(FIX, 'content-host.html')));
  } catch { res.writeHead(404).end(); }
});
await new Promise((k) => server.listen(4340, '127.0.0.1', k));

const results = [];
const check = (n, ok, d) => {
  results.push({ n, ok, d });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'layout-')),
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', '--force-device-scale-factor=2'],
});

try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  // A smallish floating-window size, which is where the old layout collapsed.
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4340/x?vsInline=1', { waitUntil: 'networkidle2' });
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
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
  });
  await page.waitForFunction(
    () => !!document.getElementById('video-scopes-host')?.shadowRoot?.querySelector('.cell'),
    { timeout: 15000 },
  );

  // Shrink the panel to a realistic floating size and let it settle.
  await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    h.style.width = '560px';
    h.style.height = '420px';
  });
  await new Promise((r) => setTimeout(r, 3500));

  const ui = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const q = (s) => root.querySelector(s);
    const rect = (el) => (el ? el.getBoundingClientRect() : null);
    const panel = q('.panel');
    const grid = q('.grid');
    const opts = q('details.options');
    const nav = q('#modes');
    return {
      dpr: window.devicePixelRatio,
      panelH: Math.round(rect(panel).height),
      gridH: Math.round(rect(grid).height),
      optsH: Math.round(rect(opts).height),
      navButtons: Array.from(root.querySelectorAll('#modes button')).map((b) => b.textContent),
      optsVisible: rect(opts).height > 10 && rect(opts).bottom <= rect(panel).bottom + 1,
      gridGetsMostSpace: rect(grid).height > rect(opts).height,
      layoutValue: root.getElementById('layout')?.value,
    };
  });

  check('the scope picker lists every scope', ui.navButtons.length === 5, ui.navButtons.join(','));
  check('controls stay visible at a small size', ui.optsVisible, `options ${ui.optsH}px`);
  check('scopes keep the majority of the space', ui.gridGetsMostSpace,
    `scopes ${ui.gridH}px vs options ${ui.optsH}px of ${ui.panelH}px`);

  // Choosing a scope must switch to a single, readable panel.
  // Record every change to the grid so a later revert is visible in the log
  // instead of leaving only the final state.
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const grid = root.querySelector('.grid');
    window.__gridHistory = [grid.className + ' #' + grid.querySelectorAll('.cell').length];
    new MutationObserver(() => {
      window.__gridHistory.push(grid.className + ' #' + grid.querySelectorAll('.cell').length);
    }).observe(grid, { attributes: true, childList: true, attributeFilter: ['class'] });

    const btn = Array.from(root.querySelectorAll('#modes button'))
      .find((b) => b.textContent === 'Vector');
    btn.click();
    window.__gridHistory.push('after-click ' + grid.className + ' #' + grid.querySelectorAll('.cell').length);
  });
  // Rebuilding the canvas set is asynchronous (new GPU contexts), so wait for
  // the single cell rather than sampling after a fixed delay.
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById('video-scopes-host')?.shadowRoot;
        return root?.querySelectorAll('.cell').length === 1;
      },
      { timeout: 10000 },
    )
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));

  const afterPick = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cells = Array.from(root.querySelectorAll('.cell'));
    const navBtn = Array.from(root.querySelectorAll('#modes button'))
      .find((b) => b.textContent === 'Vector');
    return {
      navBtnExists: !!navBtn,
      navBtnPressed: navBtn?.getAttribute('aria-pressed'),
      count: cells.length,
      modes: cells.map((c) => c.dataset.mode),
      layout: root.getElementById('layout')?.value,
      pressed: Array.from(root.querySelectorAll('#modes button'))
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.textContent),
    };
  });
  check('choosing a scope switches to single view', afterPick.count === 1 && afterPick.layout === 'single',
    `${afterPick.count} cell(s), layout=${afterPick.layout}`);
  if (afterPick.count !== 1) {
    const hist = await page.evaluate(() => window.__gridHistory);
    console.log('  grid history:', hist.join(' -> '));
    console.log('  logs:', logs.filter(l=>l.includes('relayout')).join('\n         '));
  }
  check('the chosen scope is the one shown', afterPick.modes[0] === 'vectorscope', afterPick.modes.join(','));

  // Panel-count buttons, one through four. This is the control the user said was
  // missing entirely, so measure the resulting cell count, not just the click.
  const layoutBtnCount = await page.evaluate(
    () => document.getElementById('video-scopes-host').shadowRoot.querySelectorAll('#layouts button').length,
  );
  check('the toolbar has one button per panel count', layoutBtnCount === 4, `${layoutBtnCount} buttons`);

  for (const [layoutKey, expected] of [['pair', 2], ['triple', 3], ['grid', 4], ['single', 1]]) {
    await page.evaluate((lk) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const btn = root.querySelector(`#layouts button[data-layout="${lk}"]`);
      btn.click();
    }, layoutKey);
    // New cells need fresh WebGPU contexts, so wait for the count rather than a
    // fixed delay.
    await page
      .waitForFunction(
        (n) => {
          const root = document.getElementById('video-scopes-host')?.shadowRoot;
          if (!root) return false;
          const cells = root.querySelectorAll('.cell').length;
          return n === 1 ? cells === 1 : cells === n;
        },
        { timeout: 8000 },
        expected,
      )
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const got = await page.evaluate((lk) => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const cells = Array.from(root.querySelectorAll('.cell'));
      const btn = root.querySelector(`#layouts button[data-layout="${lk}"]`);
      const iconRects = btn ? btn.querySelectorAll('svg rect').length : 0;
      const pressed = Array.from(root.querySelectorAll('#layouts button'))
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.layout);
      // Every cell must have a non-zero box, or the "grid" is only nominal.
      const sized = cells.every((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 40 && r.height > 30;
      });
      return { count: cells.length, pressed, iconRects, sized, select: root.getElementById('layout')?.value };
    }, layoutKey);
    check(
      `the "${layoutKey}" icon button (${expected} boxes) yields ${expected} sized panel(s)`,
      got.count === expected &&
        got.sized &&
        got.iconRects === expected &&
        got.pressed.length === 1 &&
        got.pressed[0] === layoutKey,
      `${got.count} cells, iconRects=${got.iconRects}, sized=${got.sized}, pressed=${got.pressed.join('|')}, select=${got.select}`,
    );
  }

  // Measure in single luma view: an RGB overlay's peak is the brightest
  // channel, not luma white, so the IRE arithmetic would be meaningless there.
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const btn = Array.from(root.querySelectorAll('#modes button')).find((b) => b.textContent === 'Wave');
    btn.click();
  });
  await page.waitForFunction(
    () => {
      const root = document.getElementById('video-scopes-host')?.shadowRoot;
      return root?.querySelectorAll('.cell').length === 1 &&
        !!root.querySelector('.cell[data-mode="waveform-luma"]');
    },
    { timeout: 10000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));

  const geo = await page.evaluate(async (pad) => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cell = root.querySelector('.cell[data-mode="waveform-luma"]');
    if (!cell) return { missing: true };
    const canvas = cell.querySelector('canvas.gpu');
    const grat = cell.querySelector('canvas.grat');
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    const dpr = canvas.width / cssW;

    const plotTop = pad.top;
    const plotH = cssH - pad.top - pad.bottom;

    // A WebGPU canvas only holds real pixels once it has been presented, and
    // createImageBitmap can win that race and read an empty buffer. Poll until
    // two frames in a row agree and at least one lit pixel exists, rather than
    // sampling once after two rAFs — sampling once produced intermittent
    // "the waveform is blank" reports for a scope that was drawing fine.
    const readFrame = async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bmp = await createImageBitmap(canvas);
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const c = oc.getContext('2d');
      c.drawImage(bmp, 0, 0);
      return { bmp, d: c.getImageData(0, 0, bmp.width, bmp.height).data };
    };
    let bmp = null;
    let d = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const got = await readFrame();
      bmp = got.bmp;
      d = got.d;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 60) { lit++; if (lit > 20) break; }
      }
      if (lit > 20) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Extent of lit pixels, in CSS px.
    let topmost = bmp.height, leftmost = bmp.width, rightmost = -1;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        const i = (y * bmp.width + x) * 4;
        if (d[i] + d[i + 1] + d[i + 2] > 60) {
          if (y < topmost) topmost = y;
          if (x < leftmost) leftmost = x;
          if (x > rightmost) rightmost = x;
        }
      }
    }

    // IRE of the brightest row near the right edge of the plot (the white step).
    const sampleX = Math.round((pad.left + (cssW - pad.left - pad.right) * 0.97) * dpr);
    let peakRow = -1, peakLum = -1;
    for (let y = 0; y < bmp.height; y++) {
      const i = (y * bmp.width + sampleX) * 4;
      const l = d[i] + d[i + 1] + d[i + 2];
      if (l > peakLum) { peakLum = l; peakRow = y; }
    }
    const peakCss = peakRow / dpr;
    const axis = 1 - (peakCss - plotTop) / plotH;
    const ire = ((axis - 16 / 255) / (235 / 255 - 16 / 255)) * 100;

    // Label glyphs in the left margin.
    const gctx = grat.getContext('2d');
    const gd = gctx.getImageData(0, 0, grat.width, grat.height).data;
    const marginEnd = Math.round(40 * dpr);
    let labelPixels = 0;
    for (let y = 0; y < grat.height; y++) {
      for (let x = 0; x < marginEnd; x++) {
        const i = (y * grat.width + x) * 4;
        if (gd[i] + gd[i + 1] + gd[i + 2] > 90) labelPixels++;
      }
    }

    return {
      dpr, cssW, cssH, devW: bmp.width, devH: bmp.height,
      topInsetCss: +(topmost / dpr).toFixed(1),
      leftInsetCss: +(leftmost / dpr).toFixed(1),
      rightGapCss: +((bmp.width - 1 - rightmost) / dpr).toFixed(1),
      peakIre: +ire.toFixed(1),
      debug: {
        canvasW: canvas.width, canvasH: canvas.height, cssW, cssH, dpr,
        grids: root.querySelectorAll('.grid').length,
        gridClass: root.querySelector('.grid')?.className,
        gridRect: ((g) => ({ w: Math.round(g.width), h: Math.round(g.height) }))(
          root.querySelector('.grid').getBoundingClientRect()),
        hostRect: ((g) => ({ w: Math.round(g.width), h: Math.round(g.height) }))(
          document.getElementById('video-scopes-host').getBoundingClientRect()),
        panelRect: ((g) => ({ w: Math.round(g.width), h: Math.round(g.height) }))(
          root.querySelector('.panel').getBoundingClientRect()),
        gridStyle: ((g) => {
          const cs = getComputedStyle(g);
          return { cols: cs.gridTemplateColumns, rows: cs.gridTemplateRows, cls: g.className };
        })(root.querySelector('.grid')),
        cells: Array.from(root.querySelectorAll('.cell')).map((c) => {
          const r = c.getBoundingClientRect();
          return `${c.dataset.mode}:${Math.round(r.width)}x${Math.round(r.height)}`;
        }),
      }, 
      labelPixels,
      badge: root.getElementById('status')?.textContent ?? '',
    };
  }, PAD);

  check('trace does not touch the top edge', !geo.missing && geo.topInsetCss >= 8, `${geo.topInsetCss} css px inset`);
  check('trace does not touch the left edge', !geo.missing && geo.leftInsetCss >= 20, `${geo.leftInsetCss} css px inset`);
  check('trace does not touch the right edge', !geo.missing && geo.rightGapCss >= 4, `${geo.rightGapCss} css px gap`);
  check('y-axis labels are drawn', !geo.missing && geo.labelPixels > 100, `${geo.labelPixels} label px`);
  // White must land on 100 IRE on a limited axis. Allow measurement slack for the
  // anti-aliased edge of a 1px trace.
  check('white reads 100 IRE on a limited axis', !geo.missing && Math.abs(geo.peakIre - 100) <= 4,
    `${geo.peakIre} IRE (${geo.badge})`);

  await page.screenshot({ path: resolve('docs/screenshots/layout-rebuilt.png') });
  await writeFile(resolve('docs/screenshots/layout-report.json'), JSON.stringify({ ui, afterPick, geo }, null, 2));
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
