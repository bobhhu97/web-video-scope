struct ResolveParams {
  size: vec4u,   // canvasW, canvasH, planes, resMode(0 luma, 1 parade, 2 rgbOverlay, 3 vectorscope, 4 cie)
  plot: vec4u,   // padLeft, padTop, plotW, plotH  — density grid occupies exactly this rect
  opts: vec4f,   // gain, gamma, zoom, coordIsUV
  tint: vec4f,   // luma tint rgb (waveform-luma only)
  coeff: vec4f,  // kr, kg, kb, unused
};

@group(0) @binding(0) var<storage, read> density: array<u32>;
@group(0) @binding(1) var<uniform> p: ResolveParams;

/**
 * Sum a small neighbourhood. A pure point plot puts all hits for one bar into a
 * single bin, so without this the trace is a single lit pixel that is invisible
 * next to the graticule.
 */
fn densityAround(col: u32, row: u32, plotW: u32, plotH: u32, plane: u32, base: u32) -> f32 {
  var total = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let x = clamp(i32(col) + dx, 0, i32(plotW) - 1);
      let y = clamp(i32(row) + dy, 0, i32(plotH) - 1);
      total += density[plane * plotW * plotH + u32(y) * plotW + u32(x)] + base;
    }
  }
  return f32(total);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(pts[i], 0.0, 1.0);
  o.uv = vec2f((pts[i].x + 1.0) * 0.5, (1.0 - pts[i].y) * 0.5);
  return o;
}

fn phosphor(count: f32, gain: f32, gamma: f32) -> f32 {
  let i = 1.0 - exp(-count * gain);
  return pow(i, 1.0 / max(gamma, 0.05));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let canvasW = p.size.x;
  let canvasH = p.size.y;
  let planes = p.size.z;
  let mode = p.size.w;
  let gain = p.opts.x;
  let gamma = p.opts.y;
  let zoom = p.opts.z;

  // Canvas pixel, then the same pixel expressed in plot space.
  let canvasX = in.uv.x * f32(canvasW);
  let canvasY = in.uv.y * f32(canvasH);
  let padL = f32(p.plot.x);
  let padT = f32(p.plot.y);
  let plotW = p.plot.z;
  let plotH = p.plot.w;

  // Outside the plot rect there is no density data, so leave it transparent and
  // let the graticule canvas underneath provide the frame and labels.
  if (canvasX < padL || canvasY < padT ||
      canvasX >= padL + f32(plotW) || canvasY >= padT + f32(plotH)) {
    discard;
  }

  let col = min(plotW - 1u, u32((canvasX - padL) / f32(plotW) * f32(plotW)));
  let row = min(plotH - 1u, u32((canvasY - padT) / f32(plotH) * f32(plotH)));
  let stride = plotW * plotH;

  var acc = vec4f(0.0);

  if (mode == 0u) {
    let n = f32(density[row * plotW + col]);
    let i = phosphor(n, gain, gamma);
    acc = vec4f(p.tint.rgb * i, i);
  } else if (mode == 1u) {
    // RGB parade: three equal horizontal slices, each showing one plane.
    let sliceW = max(plotW / 3u, 1u);
    let slice = min(col / sliceW, planes - 1u);
    let localCol = col - slice * sliceW;
    let srcCol = min(plotW - 1u, u32(f32(localCol) / f32(sliceW) * f32(plotW)));
    var tint = vec3f(0.25, 0.5, 1.0);
    if (slice == 0u) { tint = vec3f(1.0, 0.15, 0.15); }
    if (slice == 1u) { tint = vec3f(0.15, 1.0, 0.3); }
    let n = f32(density[slice * stride + row * plotW + srcCol]);
    let i = phosphor(n, gain, gamma);
    acc = vec4f(tint * i, i);
  } else if (mode == 2u) {
    // RGB overlay: additive blend of the three planes.
    var tint = vec3f(0.0);
    for (var ch = 0u; ch < 3u; ch++) {
      let n = f32(density[ch * stride + row * plotW + col]);
      let i = phosphor(n, gain, gamma);
      var c = vec3f(0.22, 0.45, 1.0);
      if (ch == 0u) { c = vec3f(1.0, 0.12, 0.12); }
      if (ch == 1u) { c = vec3f(0.12, 1.0, 0.28); }
      tint += c * i;
    }
    acc = vec4f(tint, clamp(max(tint.r, max(tint.g, tint.b)), 0.0, 1.0));
  } else if (mode == 3u) {
    // Vectorscope: tint by the chroma at this pixel.
    let n = densityAround(col, row, plotW, plotH, 0u, 0u);
    let i = phosphor(n, gain, gamma);
    let cb = clamp((f32(col) + 0.5) / f32(plotW) - 0.5, -0.5, 0.5) / zoom;
    let cr = clamp(0.5 - (f32(row) + 0.5) / f32(plotH), -0.5, 0.5) / zoom;
    let kr = p.coeff.x;
    let kg = p.coeff.y;
    let kb = p.coeff.z;
    let y = 0.5;
    let rr = y + 2.0 * (1.0 - kr) * cr;
    let bb = y + 2.0 * (1.0 - kb) * cb;
    let gg = (y - kr * rr - kb * bb) / max(kg, 1e-4);
    let rgb = clamp(vec3f(rr, gg, bb), vec3f(0.0), vec3f(1.0));
    let tinted = mix(rgb, vec3f(0.55, 1.0, 0.75), 0.35);
    acc = vec4f(tinted * i, i);
  } else {
    // CIE: tint by the chromaticity at this pixel.
    let n = densityAround(col, row, plotW, plotH, 0u, 0u);
    let i = phosphor(n, gain, gamma);
    var rgb = vec3f(0.8, 0.9, 1.0);
    if (p.opts.w > 0.5) {
      let u = (f32(col) + 0.5) / f32(plotW) * 0.62;
      let v = (1.0 - (f32(row) + 0.5) / f32(plotH)) * 0.6;
      let den = 6.0 * u - 16.0 * v + 12.0;
      let cx = select(0.0, (9.0 * u) / den, abs(den) > 1e-5);
      let cy = select(0.0, (4.0 * v) / den, abs(den) > 1e-5);
      rgb = clamp(vec3f(cx, cy, 1.0 - cx - cy) * 1.6, vec3f(0.0), vec3f(1.0));
    } else {
      let cx = (f32(col) + 0.5) / f32(plotW) * 0.8;
      let cy = (1.0 - (f32(row) + 0.5) / f32(plotH)) * 0.9;
      rgb = clamp(vec3f(cx, cy, 1.0 - cx - cy) * 1.6, vec3f(0.0), vec3f(1.0));
    }
    acc = vec4f(mix(rgb, vec3f(0.8, 0.9, 1.0), 0.2) * i, i);
  }

  if (acc.a <= 0.002) { discard; }
  return acc;
}
