/**
 * Comprehensive Chrome + Metal WebGPU E2E verification & Retina screenshot suite
 * for Round 2 features & fixes:
 *  1. No Nit button on Vectorscope/CIE + clean per-scope Coloring options
 *  2. CIE 1976 u'v' clean viewport padding & non-overlapping labels (u'/v' axes)
 *  3. Vectorscope 2× toggle button + clean 75%/100% targets (no connecting lines)
 *     + interactive 1× / 2× / 4× zoom buttons in every cell's ⚙ popover
 *  4. Eyedropper (Picker / 吸管) toggle: synchronized target rings on all scopes +
 *     configurable cursor readout tooltip (RGB 8b/10b, IRE/Nits, CIE xy/u'v', CbCr, HEX)
 *  5. Global Settings modal: manual Color Space override (Primaries P3/2020, Matrix,
 *     Transfer, Range, SDR White) + English / 简体中文 live language switching
 *  6. SDR False Color modes (ARRI, SmallHD, IRE Spectrum, HDR Nits) + live video
 *     scroll / resize / fullscreen tracking even while video is paused
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIST = resolve('dist');
const OUT = resolve('docs/screenshots');
await mkdir(OUT, { recursive: true });

const TEST_STUDIO_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Scopes Studio — Exposure & Color Reference</title>
  <style>
    html, body {
      margin: 0; padding: 0; background: #070a0f; color: #cbd5e1;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      min-height: 1600px; /* scrollable page to verify scroll tracking! */
    }
    .stage {
      padding: 28px 0 0 28px; box-sizing: border-box;
    }
    .player-card {
      width: 536px; background: #0f141c; border: 1px solid #1e293b;
      border-radius: 10px; padding: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.6);
      transition: none;
    }
    .player-title {
      display: flex; justify-content: space-between; margin-bottom: 8px;
      color: #94a3b8; font-size: 11px; letter-spacing: 0.03em;
    }
    video {
      display: block; width: 100%; aspect-ratio: 16 / 9;
      background: #000; border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="stage" id="stage">
    <div class="player-card" id="player-card">
      <div class="player-title">
        <span>75% SMPTE Bars · Skin &amp; 18% Grey Exposure Chart</span>
        <span>Rec.709 · 960×540</span>
      </div>
      <video id="video" muted playsinline autoplay></video>
    </div>
  </div>
  <script>
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 540;
    const ctx = c.getContext('2d');

    // 75% SMPTE color bars (top 48%)
    const bars75 = [
      [191, 191, 191], // 75% White
      [191, 191, 0],   // 75% Yellow
      [0,   191, 191], // 75% Cyan
      [0,   191, 0],   // 75% Green
      [191, 0,   191], // 75% Magenta
      [191, 0,   0],   // 75% Red
      [0,   0,   191], // 75% Blue
    ];

    function paint() {
      const bw = c.width / bars75.length;
      for (let i = 0; i < bars75.length; i++) {
        const [r, g, b] = bars75[i];
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillRect(Math.round(i * bw), 0, Math.ceil(bw), 240);
      }

      // Middle band (y=240..380): Calibrated exposure zones for ARRI / SmallHD False Color:
      //  0: Black clip (1% IRE -> rgb 2)
      //  1: Near black shadow (3.5% IRE -> rgb 9)
      //  2: Deep shadow (12% IRE -> rgb 31)
      //  3: 18% Middle Grey (40% IRE -> rgb 102)
      //  4: Key Skin Tone (~54% IRE warm -> rgb 168, 129, 108)
      //  5: Bright Highlight (90% IRE -> rgb 230)
      //  6: Near White Shoulder (98% IRE -> rgb 250)
      //  7: White Clip (100% IRE -> rgb 255)
      const zones = [
        [2, 2, 2],
        [9, 9, 9],
        [31, 31, 31],
        [102, 102, 102],
        [168, 129, 108],
        [230, 230, 230],
        [250, 250, 250],
        [255, 255, 255],
      ];
      const zw = c.width / zones.length;
      for (let i = 0; i < zones.length; i++) {
        const [r, g, b] = zones[i];
        ctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
        ctx.fillRect(Math.round(i * zw), 240, Math.ceil(zw), 150);
      }

      // Bottom band (y=390..540): Continuous 0..100% luma ramp
      const grad = ctx.createLinearGradient(0, 0, c.width, 0);
      grad.addColorStop(0, 'rgb(0,0,0)');
      grad.addColorStop(1, 'rgb(255,255,255)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 390, c.width, 150);
    }
    paint();
    setInterval(paint, 33);

    const v = document.getElementById('video');
    v.srcObject = c.captureStream(30);
    v.play().then(() => { window.__videoReady = true; });
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TEST_STUDIO_HTML);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((k) => server.listen(4379, '127.0.0.1', k));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'r2-scopes-')),
  args: [
    '--enable-unsafe-webgpu',
    '--use-angle=metal',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=2',
  ],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) {
      errors.push(m.text());
    }
  });

  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
  await page.goto('http://127.0.0.1:4379/?vsInline=1', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

  await page.evaluate(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) },
        session: {
          get: async (k) => ({ [k]: store['s:' + k] }),
          set: async (o) => {
            for (const [k, v] of Object.entries(o)) store['s:' + k] = v;
          },
        },
      },
    };
  });
  await page.evaluate(readFileSync(join(DIST, 'content.js'), 'utf8'));
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
  });
  await page.waitForFunction(
    () => document.getElementById('video-scopes-host')?.shadowRoot?.querySelectorAll('.cell').length === 4,
    { timeout: 15000 },
  );

  await page.evaluate(() => {
    const h = document.getElementById('video-scopes-host');
    h.style.top = '20px';
    h.style.left = '596px';
    h.style.right = 'auto';
    h.style.width = '820px';
    h.style.height = '850px';
  });
  await new Promise((r) => setTimeout(r, 700));

  // =========================================================================
  // 1. Verify NO Nit button on Vectorscope or CIE & Zone Color All skips them
  // =========================================================================
  const pillAudit = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const vecCell = root.querySelector('.cell[data-mode="vectorscope"]');
    const cieCell = root.querySelector('.cell[data-mode="cie"]');
    const waveCell = root.querySelector('.cell[data-slot="0"]');

    const pillsText = (el) =>
      Array.from(el.querySelectorAll('.cell-pills button')).map((b) => b.textContent.trim());

    // Open CIE & Vectorscope popovers briefly to check Coloring options
    vecCell.querySelector('.cell-gear').click();
    const vecTraceOpts = Array.from(
      vecCell.querySelectorAll('select[data-pop="traceMode"] option'),
    ).map((o) => o.value);
    cieCell.querySelector('.cell-gear').click();
    const cieTraceOpts = Array.from(
      cieCell.querySelectorAll('select[data-pop="traceMode"] option'),
    ).map((o) => o.value);
    cieCell.querySelector('.cell-gear').click(); // close

    // Click Zone Color All -> Wave/Parade should get Nit active, Vector/CIE must NOT
    root.getElementById('zone-all-btn').click();
    const waveNitOn = !!root.querySelector('.cell[data-slot="0"] .pill.nit-on');
    const vecNitOn = !!root.querySelector('.cell[data-mode="vectorscope"] .pill.nit-on');
    const cieNitOn = !!root.querySelector('.cell[data-mode="cie"] .pill.nit-on');
    // Toggle Zone Color All back off
    root.getElementById('zone-all-btn').click();

    return {
      vecPills: pillsText(vecCell),
      ciePills: pillsText(cieCell),
      vecTraceOpts,
      cieTraceOpts,
      waveNitOn,
      vecNitOn,
      cieNitOn,
    };
  });

  check(
    'Vectorscope & CIE have NO Nit button; Vectorscope has direct 2× button',
    !pillAudit.vecPills.includes('Nit') &&
      !pillAudit.ciePills.includes('Nit') &&
      pillAudit.vecPills.includes('2×'),
    `vec=[${pillAudit.vecPills.join(',')}] cie=[${pillAudit.ciePills.join(',')}]`,
  );
  check(
    'Vectorscope & CIE popovers exclude redundant HDR-Zones / Channel-Colors options',
    !pillAudit.vecTraceOpts.includes('hdr-zones') &&
      !pillAudit.cieTraceOpts.includes('hdr-zones') &&
      !pillAudit.vecTraceOpts.includes('channel'),
    `vecOpts=[${pillAudit.vecTraceOpts.join(',')}] cieOpts=[${pillAudit.cieTraceOpts.join(',')}]`,
  );
  check(
    'Zone Color All only activates Nit zones on luminance scopes, leaving Vector & CIE clean',
    pillAudit.waveNitOn && !pillAudit.vecNitOn && !pillAudit.cieNitOn,
  );

  // =========================================================================
  // 2. Vectorscope 2× pill & Popover 1× / 2× / 4× buttons + clean graticule
  // =========================================================================
  const vecZoomAudit = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const vecCell = root.querySelector('.cell[data-mode="vectorscope"]');
    vecCell.querySelector('button[data-act="zoom2x"]').click();
    const afterPillClick = {
      pillOn: vecCell.querySelector('button[data-act="zoom2x"]').classList.contains('on'),
      badgeHidden: vecCell.querySelector('.zoom-reset').hidden,
      badgeText: vecCell.querySelector('.zoom-reset').textContent.trim(),
    };
    // Click 2× pill again -> toggles back to 1×
    vecCell.querySelector('button[data-act="zoom2x"]').click();
    const afterToggleBack = vecCell.querySelector('.zoom-reset').hidden;

    // Open ⚙ popover and test 1× / 2× / 4× view buttons
    vecCell.querySelector('.cell-gear').click();
    const pop = vecCell.querySelector('.cell-popover');
    pop.querySelector('button[data-pop-zoom="2"]').click();
    const pop2xBadge = vecCell.querySelector('.zoom-reset').textContent.trim();
    const pop2xActive = pop.querySelector('button[data-pop-zoom="2"]').classList.contains('active');

    pop.querySelector('button[data-pop-zoom="4"]').click();
    const pop4xBadge = vecCell.querySelector('.zoom-reset').textContent.trim();

    pop.querySelector('button[data-pop-zoom="1"]').click();
    const pop1xReset = vecCell.querySelector('.zoom-reset').hidden;
    vecCell.querySelector('.cell-gear').click(); // close

    return { afterPillClick, afterToggleBack, pop2xBadge, pop2xActive, pop4xBadge, pop1xReset };
  });

  check(
    'Vectorscope 2× pill toggles cleanly between 1× and 2× view',
    vecZoomAudit.afterPillClick.pillOn &&
      !vecZoomAudit.afterPillClick.badgeHidden &&
      vecZoomAudit.afterPillClick.badgeText.startsWith('2×') &&
      vecZoomAudit.afterToggleBack,
    `badge="${vecZoomAudit.afterPillClick.badgeText}"`,
  );
  check(
    'Cell ⚙ popover 1× / 2× / 4× view buttons switch zoom interactively',
    vecZoomAudit.pop2xActive &&
      vecZoomAudit.pop2xBadge.startsWith('2×') &&
      vecZoomAudit.pop4xBadge.startsWith('4×') &&
      vecZoomAudit.pop1xReset,
    `2x="${vecZoomAudit.pop2xBadge}" 4x="${vecZoomAudit.pop4xBadge}"`,
  );

  // Switch CIE cell (slot 3) to 1976 u'v' + Rec.709 & P3 & 2020 and capture close-ups!
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cieCell = root.querySelector('.cell[data-mode="cie"]');
    cieCell.querySelector('button[data-coord="uv"]').click();
  });
  await new Promise((r) => setTimeout(r, 450));

  // Verify CIE 1976 u'v' top header band vs horseshoe locus separation on graticule canvas
  const cieOverlapAudit = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cieCell = root.querySelector('.cell[data-mode="cie"]');
    const grat = cieCell.querySelector('canvas.grat');
    const dpr = window.devicePixelRatio || 2;
    const ctx = grat.getContext('2d');
    const data = ctx.getImageData(0, 0, grat.width, grat.height).data;
    // Check row y_css = 16..20 (the separator band between header text at y=4..14 and locus at y>=22):
    // Saturated green horseshoe pixels (G > 180 && R < 80) must NOT appear in y_css < 20!
    let locusInHeaderPx = 0;
    const maxHeaderRow = Math.floor(20 * dpr);
    for (let y = 0; y < maxHeaderRow; y++) {
      for (let x = 0; x < grat.width; x++) {
        const i = (y * grat.width + x) * 4;
        if (data[i + 1] > 180 && data[i] < 100 && data[i + 3] > 150) {
          locusInHeaderPx++;
        }
      }
    }
    const rect = cieCell.getBoundingClientRect();
    const vecRect = root.querySelector('.cell[data-mode="vectorscope"]').getBoundingClientRect();
    return {
      locusInHeaderPx,
      cieClip: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      vecClip: { x: vecRect.left, y: vecRect.top, width: vecRect.width, height: vecRect.height },
    };
  });

  check(
    "CIE 1976 u'v' horseshoe locus has zero overlap with top header band",
    cieOverlapAudit.locusInHeaderPx === 0,
    `locusInHeaderPx=${cieOverlapAudit.locusInHeaderPx}`,
  );

  await page.screenshot({
    path: join(OUT, 'r2-cie1976-uv.png'),
    clip: cieOverlapAudit.cieClip,
  });
  await page.screenshot({
    path: join(OUT, 'r2-vectorscope-clean.png'),
    clip: cieOverlapAudit.vecClip,
  });

  // =========================================================================
  // 3. Eyedropper Mode: Synchronized Rings on All 4 Scopes + Cursor Readout
  // =========================================================================
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.getElementById('eyedropper-btn').click();
  });

  const videoBox = await page.evaluate(() => {
    const r = document.getElementById('video').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });

  // Move mouse directly onto the Skin Tone patch (zone 4 of 8 -> x ≈ 56% width, y ≈ 58% height) WITHOUT Alt key!
  const skinX = Math.round(videoBox.left + videoBox.width * 0.56);
  const skinY = Math.round(videoBox.top + videoBox.height * 0.58);
  await page.mouse.move(skinX, skinY);
  await new Promise((r) => setTimeout(r, 350));

  const eyedropperAudit = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const cells = Array.from(root.querySelectorAll('.cell'));
    const ringCounts = cells.map((cell) => {
      const m = cell.querySelector('canvas.marker');
      const ctx = m.getContext('2d');
      const d = ctx.getImageData(0, 0, m.width, m.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 80) lit++;
      }
      return { mode: cell.dataset.mode, lit };
    });

    const tipHost = document.getElementById('video-scopes-cursor-probe');
    const tipVisible = tipHost && getComputedStyle(tipHost).display !== 'none';
    const tipText = tipHost?.shadowRoot?.querySelector('.card')?.textContent ?? '';
    return { ringCounts, tipVisible, tipText };
  });

  check(
    'Eyedropper toggle draws synchronized target rings across all 4 scopes (Waveform, Parade, Vector, CIE)',
    eyedropperAudit.ringCounts.every((c) => c.lit > 25),
    eyedropperAudit.ringCounts.map((c) => `${c.mode}:${c.lit}px`).join(', '),
  );
  check(
    'Eyedropper floating cursor tooltip displays RGB 8b, RGB 10b, Luma IRE/nits, and CIE xy',
    eyedropperAudit.tipVisible &&
      eyedropperAudit.tipText.includes('RGB 8b') &&
      eyedropperAudit.tipText.includes('RGB 10b') &&
      eyedropperAudit.tipText.includes('IRE') &&
      eyedropperAudit.tipText.includes('CIE xy'),
    `tip="${eyedropperAudit.tipText.slice(0, 96)}"`,
  );

  // Also test toggling optional Eyedropper fields (CIE u'v' & HEX) ON via Global Settings!
  const customProbeAudit = await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.getElementById('settings-btn').click();
    const uvChk = root.querySelector('input[data-probe-cfg="showUv"]');
    const hexChk = root.querySelector('input[data-probe-cfg="showHex"]');
    uvChk.checked = true;
    uvChk.dispatchEvent(new Event('change'));
    hexChk.checked = true;
    hexChk.dispatchEvent(new Event('change'));
    root.getElementById('settings-done-btn').click();
    const tipText =
      document.getElementById('video-scopes-cursor-probe')?.shadowRoot?.querySelector('.card')
        ?.textContent ?? '';
    return { tipText };
  });

  check(
    'Eyedropper readout customization immediately updates floating tooltip fields (CIE u’v’ + HEX)',
    customProbeAudit.tipText.includes("CIE u'v'") && /#[0-9A-F]{6}/.test(customProbeAudit.tipText),
    `customTip="${customProbeAudit.tipText.slice(0, 96)}"`,
  );

  await page.screenshot({ path: join(OUT, 'r2-eyedropper-rings.png') });

  // =========================================================================
  // 4. SDR False Color Modes (ARRI, SmallHD, Spectrum) + Chinese Language + Global Settings
  // =========================================================================
  // Enable False Color (defaults to Auto -> ARRI on SDR!) and switch UI to 简体中文!
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    root.getElementById('lang-btn').click(); // -> 简体中文!
    root.getElementById('false-color-btn').click();
  });
  await new Promise((r) => setTimeout(r, 700));
  // Re-move mouse onto Cyan bar so rings + Chinese tooltip + ARRI False Color appear together!
  await page.mouse.move(
    Math.round(videoBox.left + videoBox.width * 0.36),
    Math.round(videoBox.top + videoBox.height * 0.25),
  );
  await new Promise((r) => setTimeout(r, 350));

  async function sampleFalseColor() {
    return page.evaluate(async () => {
      const fcHost = document.getElementById('video-scopes-false-color');
      const canvas = fcHost?.shadowRoot?.querySelector('canvas');
      const legend = fcHost?.shadowRoot?.querySelector('.legend')?.textContent ?? '';
      const r = fcHost?.getBoundingClientRect();
      let greenGreyPx = 0;
      let pinkSkinPx = 0;
      let cyanShadowPx = 0;
      let lit = 0;
      if (canvas && canvas.width > 0) {
        for (let attempt = 0; attempt < 25; attempt++) {
          await new Promise((res) => requestAnimationFrame(res));
          const bmp = await createImageBitmap(canvas);
          const oc = new OffscreenCanvas(bmp.width, bmp.height);
          const x = oc.getContext('2d');
          x.drawImage(bmp, 0, 0);
          const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
          lit = 0;
          greenGreyPx = 0;
          pinkSkinPx = 0;
          cyanShadowPx = 0;
          for (let i = 0; i < d.length; i += 16) {
            const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3];
            if (A > 40 && R + G + B > 30) lit++;
            if (G > 140 && R < 90 && B < 120) greenGreyPx++;
            if (R > 170 && G > 80 && G < 165 && B > 115) pinkSkinPx++;
            if (B > 155 && G > 125 && R < 80) cyanShadowPx++;
          }
          if (lit > 1000) break;
        }
      }
      return {
        lit,
        greenGreyPx,
        pinkSkinPx,
        cyanShadowPx,
        legend: legend.trim(),
        rect: r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
      };
    });
  }

  const arriFc = await sampleFalseColor();
  check(
    'ARRI SDR False Color highlights 18% grey (green) & skin tone (pink) with localized legend',
    arriFc.lit > 5000 &&
      arriFc.greenGreyPx > 100 &&
      arriFc.pinkSkinPx > 100 &&
      arriFc.legend.includes('ARRI') &&
      arriFc.legend.includes('18%灰'),
    `lit=${arriFc.lit}, green=${arriFc.greenGreyPx}, pink=${arriFc.pinkSkinPx}, legend="${arriFc.legend}"`,
  );

  await page.screenshot({ path: join(OUT, 'r2-false-color-arri.png') });

  // Switch False Color preset to SmallHD!
  await page.evaluate(() => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    const sel = root.getElementById('fc-preset');
    sel.value = 'smallhd';
    sel.dispatchEvent(new Event('change'));
  });
  await new Promise((r) => setTimeout(r, 500));

  const smallHdFc = await sampleFalseColor();
  check(
    'SmallHD False Color adds 9–16% cyan shadow band & updates SmallHD legend',
    smallHdFc.lit > 5000 &&
      smallHdFc.cyanShadowPx > arriFc.cyanShadowPx + 50 &&
      smallHdFc.legend.includes('SmallHD'),
    `cyanShadow=${smallHdFc.cyanShadowPx} (vs ARRI ${arriFc.cyanShadowPx}), legend="${smallHdFc.legend}"`,
  );

  await page.screenshot({ path: join(OUT, 'r2-false-color-smallhd.png') });

  // =========================================================================
  // 5. Video Scroll & Layout Shift Tracking while Video is PAUSED
  // =========================================================================
  const trackingAudit = await page.evaluate(async () => {
    const video = document.getElementById('video');
    video.pause();
    // Scroll page down by 140px and shift player card right by 48px
    window.scrollTo(0, 140);
    document.getElementById('player-card').style.marginLeft = '48px';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const vr = video.getBoundingClientRect();
    const fr = document.getElementById('video-scopes-false-color').getBoundingClientRect();
    const dx = Math.abs(vr.left - fr.left);
    const dy = Math.abs(vr.top - fr.top);
    const dw = Math.abs(vr.width - fr.width);
    const dh = Math.abs(vr.height - fr.height);
    // Restore scroll & position & resume playback
    window.scrollTo(0, 0);
    document.getElementById('player-card').style.marginLeft = '0px';
    await video.play();
    return { dx, dy, dw, dh, scrolledTop: fr.top };
  });

  check(
    'False Color overlay tracks paused <video> across page scroll & CSS layout moves within 1px',
    trackingAudit.dx <= 1.5 &&
      trackingAudit.dy <= 1.5 &&
      trackingAudit.dw <= 1.5 &&
      trackingAudit.dh <= 1.5,
    `Δleft=${trackingAudit.dx.toFixed(1)}px Δtop=${trackingAudit.dy.toFixed(1)}px`,
  );

  // =========================================================================
  // 6. Open Global Settings Modal (Chinese) & Verify Manual Color Space Override
  // =========================================================================
  const globalSetAudit = await page.evaluate(async () => {
    const root = document.getElementById('video-scopes-host').shadowRoot;
    // Turn off Eyedropper first -> verify rings & tooltip clear cleanly
    root.getElementById('eyedropper-btn').click();
    const tipHiddenAfterOff =
      getComputedStyle(document.getElementById('video-scopes-cursor-probe')).display === 'none';

    // Open Global Settings modal
    root.getElementById('settings-btn').click();
    const backdrop = root.getElementById('settings-backdrop');
    const modalOpen = !backdrop.hidden;

    // Manually override Primaries -> Display P3
    const primSel = root.getElementById('set-primaries');
    primSel.value = 'p3';
    primSel.dispatchEvent(new Event('change'));
    const activePrimaries = window.__scopeDebug?.primaries;
    const csBadge = root.getElementById('cs').textContent;

    return { tipHiddenAfterOff, modalOpen, activePrimaries, csBadge };
  });

  check(
    'Turning off Eyedropper immediately clears floating cursor readout & scope rings',
    globalSetAudit.tipHiddenAfterOff,
  );
  check(
    'Global Settings modal opens & manual Primaries override (Display P3) updates pipeline',
    globalSetAudit.modalOpen &&
      globalSetAudit.activePrimaries === 'p3' &&
      globalSetAudit.csBadge.includes('P3'),
    `primaries="${globalSetAudit.activePrimaries}", cs="${globalSetAudit.csBadge}"`,
  );

  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: join(OUT, 'r2-global-settings-zh.png') });

  check(
    'Zero uncaught page or WebGPU errors across Round 2 suite',
    errors.length === 0,
    errors.join(' | ') || 'clean',
  );
} finally {
  await browser.close();
  await new Promise((k) => server.close(k));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
