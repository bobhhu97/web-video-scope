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
    if (req.url?.startsWith('/hostile')) {
      const raw = await readFile(join(FIX, 'content-host.html'), 'utf8');
      const hostileHtml = raw.replace(
        '<style>',
        '<style>html { transform: translateZ(0); } body { min-height: 1800px; padding-top: 200px; } #pattern { display: none; } .wrap { position: relative; z-index: 2147483647; isolation: isolate; background: #141418; }',
      );
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "require-trusted-types-for 'script'",
      });
      res.end(hostileHtml);
      return;
    }
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
    '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox'],
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

  // Regression: the very first activation must already be floating. It used to
  // fall back to the in-page panel because `enable()` awaited two storage
  // round-trips before asking for the window and the user activation had
  // lapsed by then, so the window only appeared on the second click.
  const firstActivation = await page.evaluate(() => ({
    hostInPage: !!document.getElementById('video-scopes-host'),
    status: window.__scopeDebug?.status ?? null,
    attempt: window.__scopeDebug?.floatingAttempt ?? null,
  }));
  check(
    'the first activation goes straight to the floating window',
    pipPage !== null && !firstActivation.hostInPage && firstActivation.status === 'floating',
    JSON.stringify(firstActivation),
  );
  check(
    'the window request still held user activation',
    firstActivation.attempt?.outcome === 'opened' && firstActivation.attempt?.activation === true,
    JSON.stringify(firstActivation.attempt),
  );

  if (pipPage) {
    const inside = await pipPage.evaluate(() => {
      const h = document.getElementById('video-scopes-host');
      const cell = h?.shadowRoot?.querySelector('.cell');
      const canvas = cell?.querySelector('canvas.gpu');
      // The decisive check: the canvas must have been created by THIS document.
      // A canvas adopted from the page keeps working for reading but its WebGPU
      // context is dead, which is the bug that made the window look empty.
      const ownedByThisDocument = !!canvas && canvas.ownerDocument === document;
      const hasContext = !!canvas && !!canvas.getContext;
      return {
        hasHost: !!h,
        hasPanel: !!h?.shadowRoot?.querySelector('.panel'),
        cells: h?.shadowRoot?.querySelectorAll('.cell').length ?? 0,
        size: h ? `${Math.round(h.getBoundingClientRect().width)}x${Math.round(h.getBoundingClientRect().height)}` : null,
        ownedByThisDocument,
        hasContext,
        canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
      };
    });
    check('the HUD is inside the separate window', inside.hasHost && inside.hasPanel, JSON.stringify(inside));
    check('all four scope panels are present in the window', inside.cells === 4, `${inside.cells} cells`);
    check(
      'canvases were created by the window document (GPU context usable)',
      inside.ownedByThisDocument,
      `ownerDocument matches: ${inside.ownedByThisDocument}, canvas ${inside.canvasSize}`,
    );

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

  // -------------------------------------------------------------------------
  // Hostile host page test (YouTube/Bilibili simulation):
  //  - TrustedTypes CSP (`require-trusted-types-for 'script'`)
  //  - `html { transform: translateZ(0) }` + scrolled viewport (`scrollY = 180`)
  //  - `.wrap { z-index: 2147483647; isolation: isolate }`
  //  - Limited-range (`src:limited`) BT.709 video PAUSED when clicking False Color
  //    from inside the Document PiP floating window!
  // -------------------------------------------------------------------------
  const hostilePage = await browser.newPage();
  const hostileErrors = [];
  hostilePage.on('pageerror', (e) => hostileErrors.push(e.message));
  await hostilePage.setViewport({ width: 1280, height: 800 });
  await hostilePage.goto('http://127.0.0.1:4300/hostile', { waitUntil: 'networkidle2' });
  await hostilePage.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });
  await hostilePage.evaluate(() => window.scrollTo(0, 180));

  // Run content script in an isolated world (matching real Chrome MV3 content script execution)
  const cdp = await hostilePage.createCDPSession();
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'video-scopes-ext',
    grantUniveralAccess: true,
  });
  await cdp.send('Runtime.evaluate', {
    contextId: executionContextId,
    expression: `
      const store = {};
      window.chrome = {
        runtime: { onMessage: { addListener() {} } },
        storage: {
          local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
          session: { get: async (k) => ({ [k]: store['s:' + k] }), set: async (o) => { for (const [k, v] of Object.entries(o)) store['s:' + k] = v; } },
        },
      };
    `,
  });
  await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: code });

  await hostilePage.bringToFront();
  await hostilePage.mouse.click(24, 24);
  await hostilePage.keyboard.down('Alt');
  await hostilePage.keyboard.press('KeyS');
  await hostilePage.keyboard.up('Alt');

  let hostilePip = null;
  for (let i = 0; i < 40 && !hostilePip; i++) {
    await new Promise((r) => setTimeout(r, 250));
    for (const t of browser.targets()) {
      if (t.type() !== 'page' || t === page.target() || t === hostilePage.target() || t === pipPage?.target()) continue;
      if (!t.url().startsWith('about:blank')) continue;
      try {
        const cand = await t.page();
        if (await cand.evaluate(() => !!document.getElementById('video-scopes-host'))) {
          hostilePip = cand;
          break;
        }
      } catch {
        // Ignore target init race
      }
    }
  }

  check(
    'TrustedTypes + max z-index host opens Document PiP window cleanly without TrustedHTML errors',
    hostilePip !== null && hostileErrors.length === 0,
    hostileErrors.join(' | ') || 'clean',
  );

  if (hostilePip) {
    // Let 6+ frames run so RangeDetector processes WebCodecs limited-range metadata + 0..1 RGB stats
    await new Promise((r) => setTimeout(r, 900));
    // Pause the host video BEFORE clicking False Color in the PiP window!
    await hostilePage.evaluate(() => document.getElementById('video').pause());
    await new Promise((r) => setTimeout(r, 150));

    // Switch to Chinese & click False Color button inside the PiP window
    await hostilePip.evaluate(() => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      root.getElementById('lang-btn').click();
      root.getElementById('false-color-btn').click();
    });
    await new Promise((r) => setTimeout(r, 650));

    const pipHudDiag = await hostilePip.evaluate(() => {
      const root = document.getElementById('video-scopes-host').shadowRoot;
      const warn = root.getElementById('warn');
      const status = root.getElementById('status');
      const cs = root.getElementById('cs');
      const fcBtn = root.getElementById('false-color-btn');
      return {
        warnHidden: warn.hidden,
        warnText: warn.textContent,
        status: status.textContent,
        cs: cs.textContent,
        fcPressed: fcBtn.getAttribute('aria-pressed'),
      };
    });

    check(
      'No bogus "full as limited" warning appears on limited-range video when toggling False Color',
      pipHudDiag.warnHidden === true && pipHudDiag.fcPressed === 'true',
      `warnHidden=${pipHudDiag.warnHidden} warn="${pipHudDiag.warnText}" cs="${pipHudDiag.cs}"`,
    );

    const overlayGeom = await hostilePage.evaluate(() => {
      const v = document.getElementById('video');
      const fc = document.getElementById('video-scopes-false-color');
      if (!fc) return { exists: false };
      const vr = v.getBoundingClientRect();
      const fcr = fc.getBoundingClientRect();
      const isTopLayer = fc.matches(':popover-open');
      const cx = vr.left + vr.width / 2;
      const cy = vr.top + vr.height / 2;
      fc.style.pointerEvents = 'auto';
      const topEl = document.elementFromPoint(cx, cy);
      fc.style.pointerEvents = 'none';
      const legend = fc.shadowRoot?.querySelector('.legend')?.textContent ?? '';
      return {
        exists: true,
        isTopLayer,
        topHitId: topEl?.id || topEl?.tagName,
        dx: Math.abs(vr.left - fcr.left),
        dy: Math.abs(vr.top - fcr.top),
        dw: Math.abs(vr.width - fcr.width),
        dh: Math.abs(vr.height - fcr.height),
        videoClip: {
          x: vr.left + window.scrollX,
          y: vr.top + window.scrollY,
          width: vr.width,
          height: vr.height,
        },
        legend,
      };
    });

    // Capture the real OS/Chrome compositor screenshot of the host page & video region!
    await hostilePage.screenshot({ path: resolve('docs/screenshots/false-color-pip-overlay.png') });
    await hostilePip.screenshot({ path: resolve('docs/screenshots/floating-window-zh-no-warn.png') });

    const videoShotB64 = await hostilePage.screenshot({
      clip: overlayGeom.videoClip,
      encoding: 'base64',
    });
    // Decode actual composited PNG pixels over the pure-greyscale source video:
    // without False Color overlay, every pixel on the 16-step grey ramp has R===G===B (chroma === 0)!
    const compositedColors = await hostilePip.evaluate(async (b64) => {
      const res = await fetch('data:image/png;base64,' + b64);
      const blob = await res.blob();
      const bmp = await createImageBitmap(blob);
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      let purplePx = 0;
      let greenPx = 0;
      let pinkPx = 0;
      let redPx = 0;
      for (let i = 0; i < d.length; i += 16) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (b > 150 && r > 90 && g < 80) purplePx++;
        if (g > 150 && r < 90 && b < 110) greenPx++;
        if (r > 175 && g > 95 && g < 165 && b > 125) pinkPx++;
        if (r > 180 && g < 75 && b < 75) redPx++;
      }
      return { purplePx, greenPx, pinkPx, redPx };
    }, videoShotB64);

    check(
      'False Color overlay promotes to Top Layer (:popover-open) above z-index:2147483647, aligns within 1px under html transform, and composites ARRI colors on paused video',
      overlayGeom.exists &&
        overlayGeom.isTopLayer &&
        overlayGeom.topHitId === 'video-scopes-false-color' &&
        overlayGeom.dx <= 1.5 &&
        overlayGeom.dy <= 1.5 &&
        compositedColors.purplePx > 200 &&
        compositedColors.greenPx > 200 &&
        compositedColors.pinkPx > 200 &&
        compositedColors.redPx > 200,
      `topHit=${overlayGeom.topHitId} Δ=(${overlayGeom.dx},${overlayGeom.dy}) px=${JSON.stringify(compositedColors)}`,
    );

    // 10. Vertical Y-orientation check: TOP half white (100% -> ARRI Red), BOTTOM half black (0% -> ARRI Purple)
    await hostilePage.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const cx = c.getContext('2d');
      const paint = () => {
        cx.fillStyle = '#ffffff';
        cx.fillRect(0, 0, 640, 180); // Top half = White (Red clip in ARRI)
        cx.fillStyle = '#000000';
        cx.fillRect(0, 180, 640, 180); // Bottom half = Black (Purple clip in ARRI)
      };
      paint();
      const stream = c.captureStream(30);
      const timer = setInterval(paint, 33);
      window.__stopOrientTimer = () => clearInterval(timer);
      const v = document.getElementById('video');
      v.srcObject = stream;
      await v.play();
    });
    await new Promise((r) => setTimeout(r, 900));
    await hostilePage.evaluate(() => window.__stopOrientTimer?.());

    const orientShotB64 = await hostilePage.screenshot({
      clip: overlayGeom.videoClip,
      encoding: 'base64',
    });
    const yOrient = await hostilePip.evaluate(async (b64) => {
      const res = await fetch('data:image/png;base64,' + b64);
      const bmp = await createImageBitmap(await res.blob());
      const oc = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = oc.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      // Sample band at y = 20% (top half) vs y = 70% (bottom half, above bottom-left legend)
      const topRow = ctx.getImageData(0, Math.floor(bmp.height * 0.2), bmp.width, 1).data;
      const botRow = ctx.getImageData(0, Math.floor(bmp.height * 0.7), bmp.width, 1).data;
      let topRed = 0, topPurple = 0, botRed = 0, botPurple = 0;
      for (let i = 0; i < topRow.length; i += 4) {
        if (topRow[i] > 180 && topRow[i + 1] < 80 && topRow[i + 2] < 80) topRed++;
        if (topRow[i + 2] > 150 && topRow[i] > 90 && topRow[i + 1] < 80) topPurple++;
        if (botRow[i] > 180 && botRow[i + 1] < 80 && botRow[i + 2] < 80) botRed++;
        if (botRow[i + 2] > 150 && botRow[i] > 90 && botRow[i + 1] < 80) botPurple++;
      }
      return { topRed, topPurple, botRed, botPurple };
    }, orientShotB64);

    check(
      'False Color vertical orientation is strictly upright (top white -> top Red, bottom black -> bottom Purple)',
      yOrient.topRed > 200 && yOrient.topPurple === 0 && yOrient.botPurple > 200 && yOrient.botRed === 0,
      JSON.stringify(yOrient),
    );
  }
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
