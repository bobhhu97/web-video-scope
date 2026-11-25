import { initCanvas, configureCanvas, SignalTexture, Downscaler, analysisSize, ScopeRenderer, DEFAULT_SCOPE_OPTIONS, drawGraticule, DOWNSCALE_WGSL } from '/gpu/harness-bundle.js';

const params = new URLSearchParams(location.search);
const limited = params.get('range') !== 'full';
const mode = params.get('mode') ?? 'waveform-luma';
const units = params.get('units') ?? 'ire';
const preset = params.get('analysis') ?? 'default';
/**
 * Two disjoint patterns, because a scope aggregates every source row into one
 * column: mixing bars and a ramp vertically makes each column contain both and
 * no measurement can separate them.
 *  - `bars`: full-height colour bars, for vectorscope / CIE / bar-IRE tests
 *  - `ramp`: full-height grey staircase, for axis linearity and range tests
 */
const patternKind = params.get('pattern') ?? 'bars';

const pattern = document.getElementById('pattern');
const video = document.getElementById('video');
const gpuCanvas = document.getElementById('scope-gpu');
const gratCanvas = document.getElementById('scope-grat');
const status = document.getElementById('status');

/**
 * The canvas is sRGB full-range, so the browser hands the scope display-
 * normalised values in 0..1 regardless of what the `range` query param says.
 * Painting legal 16..235 here and ALSO telling the scope "limited" would apply
 * the range expansion twice and push black up to ~0.117 on the axis.
 * So the pattern is always display-normalised, and `range` only controls how
 * the scope interprets the axis.
 */
function encoder() {
  return (v) => 255 * v;
}

function drawBars(ctx) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const enc = encoder();
  const bars = [
    [1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0],
    [1, 0, 1], [1, 0, 0], [0, 0, 1], [0, 0, 0],
  ];
  const barW = w / bars.length;
  bars.forEach((rgb, i) => {
    const c = rgb.map((v) => Math.round(enc(v * 0.75))).join(',');
    ctx.fillStyle = `rgb(${c})`;
    ctx.fillRect(Math.round(i * barW), 0, Math.ceil(barW), h);
  });
}

function drawRamp(ctx) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const enc = encoder();
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const v = i / (steps - 1);
    const c = Math.round(enc(v));
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(Math.round((i * w) / steps), 0, Math.ceil(w / steps), h);
  }
}

const ctx2d = pattern.getContext('2d');
if (patternKind === 'ramp') drawRamp(ctx2d);
else drawBars(ctx2d);

video.srcObject = pattern.captureStream(30);
video.play().catch(() => {});

async function main() {
  const gpu = await initCanvas(gpuCanvas);
  const renderer = new ScopeRenderer(gpu, {
    ...DEFAULT_SCOPE_OPTIONS,
    mode,
    units,
    range: { limited, depth: 8 },
    width: 640,
    height: 340,
  });
  const gratCtx = gratCanvas.getContext('2d');

  // One downscale per frame, shared by every scope on the page.
  let signal = null;
  let downscaler = null;
  let frames = 0;
  let t0 = performance.now();

  function frame() {
    configureCanvas(gpu, gpuCanvas.clientWidth, gpuCanvas.clientHeight);
    renderer.resize(gpuCanvas.width, gpuCanvas.height);

    if (gratCanvas.width !== gpuCanvas.clientWidth || gratCanvas.height !== gpuCanvas.clientHeight) {
      gratCanvas.width = gpuCanvas.clientWidth;
      gratCanvas.height = gpuCanvas.clientHeight;
    }

    if (video.readyState >= 2) {
      if (!signal || signal.width !== video.videoWidth) {
        signal?.destroy();
        downscaler?.destroy();
        signal = new SignalTexture(gpu.device, video);
        const a = analysisSize(signal.width, signal.height, preset);
        downscaler = new Downscaler(gpu.device, a.width, a.height, DOWNSCALE_WGSL);
      }

      // Debug hook for the verification script (harmless in normal use).
      window.__scope = { gpu, renderer, signal, downscaler, video, patternKind, limited };

      if (signal.update(video.currentTime)) {
        const cmd = gpu.device.createCommandEncoder();
        downscaler.run(cmd, signal.texture);
        gpu.device.queue.submit([cmd.finish()]);

        renderer.submit(downscaler);
        frames++;
        const dt = performance.now() - t0;
        if (dt > 1000) {
          status.textContent =
            `src ${signal.width}x${signal.height} · analysis ${downscaler.width}x${downscaler.height} · ` +
            `${limited ? 'limited' : 'full'} · ${renderer.options.mode} · ${patternKind} · ` +
            `${((frames * 1000) / dt).toFixed(0)} fps`;
          frames = 0;
          t0 = performance.now();
          // Keep the histogram path exercised so it cannot rot unnoticed.
          void renderer.readHistogram().catch(() => {});
        }
        drawGraticule(
          gratCtx,
          { ...renderer.options, width: gratCanvas.width, height: gratCanvas.height },
          ['rec709', 'p3'],
        );
      }
    }
    requestAnimationFrame(frame);
  }
  frame();
}

main().catch((e) => {
  status.textContent = 'ERROR: ' + e.message;
  status.style.color = '#d87f7f';
  console.error(e);
});
