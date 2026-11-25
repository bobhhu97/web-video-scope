/**
 * Measures whether the full-resolution CPU->GPU copy is actually worth removing.
 *
 * Two paths to get video pixels onto the GPU:
 *   A) copyExternalImageToTexture  -> an rgba8unorm texture at source resolution
 *   B) importExternalTexture       -> a zero-copy GPUExternalTexture
 *
 * Path A moves width*height*4 bytes every frame (8 MB at 1080p). Path B hands the
 * GPU a handle to the decoder's own surface. This script quantifies the gap on
 * this machine rather than assuming it.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const DIST = resolve('dist');
// The host page lives outside dist/ so it is not shipped in the extension
// package; the server serves it from tests/fixtures/.
const FIXTURES = resolve('tests/fixtures');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = createServer(async (q, s) => {
  try {
    const urlPath = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    const root = urlPath.startsWith('/fixtures/') ? FIXTURES : DIST;
    const rel = urlPath.startsWith('/fixtures/') ? urlPath.slice('/fixtures'.length) : urlPath;
    const p = join(root, rel);
    const body = await readFile(p);
    s.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    s.end(body);
  } catch { if (!s.headersSent) s.writeHead(404).end(); }
});
await new Promise((k) => server.listen(4194, '127.0.0.1', k));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal',
    '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 950 });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4194/fixtures/content-host.html', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

const out = await page.evaluate(async () => {
  const video = document.querySelector('video');
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const W = video.videoWidth;
  const H = video.videoHeight;
  const N = 60;

  const result = { source: `${W}x${H}`, gpu: adapter.info?.vendor ?? 'unknown', backend: 'metal (WebGPU default on macOS)' };

  // ---- A: full-resolution copyExternalImageToTexture ----------------------
  const dst = device.createTexture({
    size: { width: W, height: H },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  const timeA = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    device.queue.copyExternalImageToTexture(
      { source: video, flipY: false },
      { texture: dst },
      { width: W, height: H },
    );
    // Force the copy to complete before timing it, otherwise we measure queueing.
    await device.queue.onSubmittedWorkDone();
    timeA.push(performance.now() - t0);
  }

  // ---- B: importExternalTexture, zero copy --------------------------------
  const timeB = [];
  let importWorks = true;
  let importErr = null;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      const ext = device.importExternalTexture({ source: video });
      // A GPUExternalTexture from an element expires on first use; touching it
      // via a bind group is what forces the work.
      const layout = device.createBindGroupLayout({
        entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} }],
      });
      const bg = device.createBindGroup({ layout, entries: [{ binding: 0, resource: ext }] });
      void bg;
      await device.queue.onSubmittedWorkDone();
      timeB.push(performance.now() - t0);
    } catch (e) {
      importWorks = false;
      importErr = e.message;
      break;
    }
  }

  const stats = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const avg = a.reduce((x, y) => x + y, 0) / a.length;
    return { avg: +avg.toFixed(3), median: +s[Math.floor(s.length / 2)].toFixed(3), p90: +s[Math.floor(s.length * 0.9)].toFixed(3) };
  };

  result.copyExternalImageToTexture = stats(timeA);
  result.importExternalTexture = importWorks ? stats(timeB) : { error: importErr };
  result.bytesMovedPerFrame = W * H * 4;
  result.note = 'times include onSubmittedWorkDone, i.e. they are upper bounds';
  return result;
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
await new Promise((k) => server.close(k));
