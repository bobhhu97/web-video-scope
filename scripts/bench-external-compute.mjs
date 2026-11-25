/**
 * Can the scope pipeline read an importExternalTexture result directly?
 *
 * The gather pass currently uses textureLoad(src, ...) on an rgba8unorm texture.
 * An external texture binds as `texture_external`, which only supports
 * textureSampleBaseClampToEdge with a sampler. This checks that the binding,
 * the sampler and a compute pass all work together, and that the sampled values
 * match what copyExternalImageToTexture produced.
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const DIST = resolve('dist');
// The host page lives outside dist/ so it is not shipped in the extension
// package; the server serves it from tests/fixtures/.
const FIXTURES = resolve('tests/fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
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
await new Promise((k) => server.listen(4195, '127.0.0.1', k));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:4195/fixtures/content-host.html', { waitUntil: 'networkidle2' });
await page.waitForFunction(() => window.__videoReady === true, { timeout: 15000 });

const out = await page.evaluate(async () => {
  const video = document.querySelector('video');
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const log = [];
  const errors = [];
  device.addEventListener?.('uncapturederror', (e) => errors.push(String(e.error?.message ?? e)));

  // A compute shader that samples an external texture and writes the luma of a
  // fixed texel into a storage buffer. This is the shape the gather pass needs.
  const code = `
    @group(0) @binding(0) var ext: texture_external;
    @group(0) @binding(1) var samp: sampler;
    @group(0) @binding(2) var<storage, read_write> outBuf: array<f32>;

    @compute @workgroup_size(1)
    fn main() {
      // Sample the exact centre of the centre texel, not the texel boundary:
      // 0.5 in UV lands on a corner between four texels and bilinear filtering
      // averages them, which is the 0.5-vs-0.5333 discrepancy this test caught.
      let dims = vec2f(textureDimensions(ext));
      let uv = (floor(dims * 0.5) + 0.5) / dims;
      let c = textureSampleBaseClampToEdge(ext, samp, uv);
      outBuf[0] = c.r;
      outBuf[1] = c.g;
      outBuf[2] = c.b;
    }
  `;

  let ok = false;
  let sampled = null;
  try {
    const ext = device.importExternalTexture({ source: video });
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const outBuf = device.createBuffer({ size: 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: ext },
        { binding: 1, resource: samp },
        { binding: 2, resource: { buffer: outBuf } },
      ],
    });
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, 12);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    sampled = Array.from(new Float32Array(readBuf.getMappedRange()).map((v) => +v.toFixed(4)));
    readBuf.unmap();
    const err = await device.popErrorScope();
    ok = !err;
    if (err) log.push('validation error: ' + err.message);
  } catch (e) {
    log.push('threw: ' + e.message);
  }

  // Compare with copyExternalImageToTexture of the same texel.
  let copyValue = null;
  try {
    const W = video.videoWidth, H = video.videoHeight;
    const tex = device.createTexture({
      size: { width: W, height: H }, format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: video }, { texture: tex }, { width: W, height: H });
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256;
    const buf = device.createBuffer({ size: bytesPerRow, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    const midY = Math.floor(H / 2);
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, { width: W, height: 1, origin: { x: 0, y: midY } });
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const data = new Uint8Array(buf.getMappedRange());
    const midX = Math.floor(W / 2) * 4;
    copyValue = [data[midX] / 255, data[midX + 1] / 255, data[midX + 2] / 255].map((v) => +v.toFixed(4));
    buf.unmap();
    tex.destroy();
  } catch (e) {
    log.push('copy compare failed: ' + e.message);
  }

  return { computeOnExternalTextureWorks: ok, sampled, copyValue, log, errors };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
await new Promise((k) => server.close(k));
