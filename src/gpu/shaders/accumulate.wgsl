struct Params {
  size: vec4u,   // srcW, srcH, plotW(density cols), plotH(density rows)
  opts: vec4u,   // accMode, channel(0..4), coordIsUV, signalKind(0=display,1=raw)
  coeff: vec4f,  // kr, kg, kb, zoom
  m0: vec4f,     // rgb -> xyz, row 0 (.w unused)
  m1: vec4f,
  m2: vec4f,
  axis: vec4f,   // black, span, gain, gamma
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> density: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> lumaHist: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> p: Params;

fn srgbToLinear(v: f32) -> f32 {
  return select(v / 12.92, pow((v + 0.055) / 1.055, 2.4), v > 0.04045);
}

/** Expand a display-normalised sample onto the code axis. */
fn blend(v: f32) -> f32 {
  return p.axis.x + v * p.axis.y;
}

/**
 * Map a code-space 0..1 value onto a canvas row.
 * Rows are flipped because density row 0 maps to the TOP of the canvas in the
 * resolve pass, while axis 0 (black) must appear at the BOTTOM.
 */
fn toRow(axis: f32, bins: u32) -> u32 {
  let b = min(bins - 1u, u32(clamp(axis, 0.0, 1.0) * f32(bins)));
  return bins - 1u - b;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let srcW = p.size.x;
  let srcH = p.size.y;
  // Plot dims, not canvas dims: the density grid spans exactly the region the
  // graticule labels, so a bar at 75 IRE lands on the 75 IRE gridline.
  let dstW = p.size.z;
  let dstH = p.size.w;
  if (gid.x >= srcW || gid.y >= srcH) { return; }

  let kr = p.coeff.x;
  let kg = p.coeff.y;
  let kb = p.coeff.z;
  let zoom = p.coeff.w;

  let px = textureLoad(src, vec2i(i32(gid.x), i32(gid.y)), 0);
  let raw = p.opts.w == 1u;

  var axisR = 0.0;
  var axisG = 0.0;
  var axisB = 0.0;
  var axisY = 0.0;
  var cb = 0.0;
  var cr = 0.0;

  if (raw) {
    // Raw mode: R already carries the Y code value (see raw-downscale.wgsl),
    // so it goes straight onto the axis. Expanding it again would compress a
    // limited-range signal twice.
    axisY = clamp(px.r, 0.0, 1.0);
    axisR = axisY;
    axisG = axisY;
    axisB = axisY;
    cb = (px.g - 0.5) * 2.0;
    cr = (px.b - 0.5) * 2.0;
  } else {
    axisR = clamp(blend(px.r), 0.0, 1.0);
    axisG = clamp(blend(px.g), 0.0, 1.0);
    axisB = clamp(blend(px.b), 0.0, 1.0);
    axisY = kr * axisR + kg * axisG + kb * axisB;
    cb = (axisB - axisY) / (2.0 * (1.0 - kb));
    cr = (axisR - axisY) / (2.0 * (1.0 - kr));
  }

  atomicAdd(&lumaHist[min(255u, u32(axisY * 255.0))], 1u);

  let col = min(dstW - 1u, u32(f32(gid.x) / f32(srcW) * f32(dstW)));
  let stride = dstW * dstH;
  let accMode = p.opts.x;

  if (accMode == 0u) {
    let ch = p.opts.y;
    // ch == 4 is the only case that allocates three planes (RGB overlay and
    // parade). Every single-channel selection writes plane 0, because the
    // density buffer is sized to 1 plane for those modes — writing plane 1
    // would be an out-of-bounds storage access.
    if (ch == 4u) {
      atomicAdd(&density[0u * stride + toRow(axisR, dstH) * dstW + col], 1u);
      atomicAdd(&density[1u * stride + toRow(axisG, dstH) * dstW + col], 1u);
      atomicAdd(&density[2u * stride + toRow(axisB, dstH) * dstW + col], 1u);
    } else {
      var v = axisY;
      if (ch == 1u) { v = axisR; }
      if (ch == 2u) { v = axisG; }
      if (ch == 3u) { v = axisB; }
      atomicAdd(&density[toRow(v, dstH) * dstW + col], 1u);
    }
  } else if (accMode == 2u) {
    let fw = f32(dstW);
    let fh = f32(dstH);
    let sx = (0.5 + cb * zoom) * fw;
    let sy = (0.5 - cr * zoom) * fh;
    if (sx >= 0.0 && sx < fw && sy >= 0.0 && sy < fh) {
      atomicAdd(&density[u32(sy) * dstW + u32(sx)], 1u);
    }
  } else {
    let lin = vec3f(srgbToLinear(axisR), srgbToLinear(axisG), srgbToLinear(axisB));
    let xyz = vec3f(dot(p.m0.xyz, lin), dot(p.m1.xyz, lin), dot(p.m2.xyz, lin));
    let sum = xyz.x + xyz.y + xyz.z;
    if (sum > 0.0001) {
      var cx = xyz.x / sum;
      var cy = xyz.y / sum;
      var hi = vec2f(0.8, 0.9);
      if (p.opts.z == 1u) {
        let d = xyz.x + 15.0 * xyz.y + 3.0 * xyz.z;
        cx = 4.0 * xyz.x / d;
        cy = 9.0 * xyz.y / d;
        hi = vec2f(0.62, 0.6);
      }
      let fw = f32(dstW);
      let fh = f32(dstH);
      let sx = cx / hi.x * fw;
      let sy = (1.0 - cy / hi.y) * fh;
      if (sx >= 0.0 && sx < fw && sy >= 0.0 && sy < fh) {
        atomicAdd(&density[u32(sy) * dstW + u32(sx)], 1u);
      }
    }
  }
}
