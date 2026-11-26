struct ResolveParams {
  size: vec4u,      // canvasW, canvasH, planes, resMode(0=wave, 1=parade, 2=vec, 3=cie, 4=hist)
  plot: vec4u,      // padLeft, padTop, plotW, plotH
  modeOpts: vec4u,  // subMode, traceMode(0=chan,1=mono,2=colorize,3=hdrZones,4=green), effectiveTransfer, coordIsUV
  opts: vec4f,      // gain, gamma, zoom, totalSamples
  coeff: vec4f,     // kr, kg, kb, black
  view: vec4f,      // panX, panY, axisNitLow, axisNitHigh
  frameA: vec4f,    // vec: (cx, cy, discCx, discCy) | cie: (left, top, width, height)
  frameB: vec4f,    // vec: (radius, scale, 0, 0)    | cie: (x0, y0, scale, 0)
};

@group(0) @binding(0) var<storage, read> density: array<u32>;
@group(0) @binding(1) var<uniform> p: ResolveParams;

const WEIGHT_SCALE: f32 = 64.0;
const MONO_TINT: vec3f = vec3f(0.93, 0.93, 0.93);
const GREEN_TINT: vec3f = vec3f(0.35, 0.98, 0.58);
const ZONE_SHADOW: vec3f = vec3f(0.24, 0.73, 0.98);
const ZONE_MID: vec3f = vec3f(0.30, 0.88, 0.64);
const ZONE_HIGH: vec3f = vec3f(1.0, 0.54, 0.18);
const ZONE_PEAK: vec3f = vec3f(1.0, 0.22, 0.44);

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

fn phosphor(exposure: f32, gain: f32, gamma: f32) -> f32 {
  let i = 1.0 - exp(-max(exposure, 0.0) * gain);
  return pow(i, 1.0 / max(gamma, 0.05));
}

fn linearToSrgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  return select(c * 12.92, 1.055 * pow(c, 1.0 / 2.4) - 0.055, c > 0.0031308);
}

/** Dual-Nit threshold zone color from an axis coordinate [0, 1]. */
fn hdrZoneColorFromAxis(axis: f32) -> vec3f {
  let lo = p.view.z;
  let hi = p.view.w;
  if (axis < lo) {
    return ZONE_SHADOW;
  }
  if (axis <= hi) {
    return ZONE_MID;
  }
  let over = clamp((axis - hi) / max(1.0 - hi, 0.04), 0.0, 1.0);
  return mix(ZONE_HIGH, ZONE_PEAK, over);
}

fn channelTint(ch: u32, subMode: u32) -> vec3f {
  if (subMode == 5u) {
    // YRGB: 0=Y, 1=R, 2=G, 3=B
    if (ch == 0u) { return vec3f(0.86, 0.90, 0.94); }
    if (ch == 1u) { return vec3f(1.0, 0.16, 0.16); }
    if (ch == 2u) { return vec3f(0.16, 1.0, 0.30); }
    return vec3f(0.24, 0.50, 1.0);
  }
  if (subMode == 6u) {
    // YUV: 0=Y, 1=U(Cb), 2=V(Cr)
    if (ch == 0u) { return vec3f(0.88, 0.92, 0.96); }
    if (ch == 1u) { return vec3f(0.22, 0.74, 0.98); }
    return vec3f(0.96, 0.42, 0.72);
  }
  if (subMode <= 3u) {
    if (subMode == 1u) { return vec3f(1.0, 0.18, 0.18); }
    if (subMode == 2u) { return vec3f(0.18, 1.0, 0.32); }
    if (subMode == 3u) { return vec3f(0.26, 0.52, 1.0); }
    return vec3f(0.84, 0.93, 0.96);
  }
  // RGB: 0=R, 1=G, 2=B
  if (ch == 0u) { return vec3f(1.0, 0.14, 0.14); }
  if (ch == 1u) { return vec3f(0.14, 1.0, 0.28); }
  return vec3f(0.24, 0.48, 1.0);
}

fn chromaToDisplayTint(cb: f32, cr: f32) -> vec3f {
  let kr = p.coeff.x;
  let kg = p.coeff.y;
  let kb = p.coeff.z;
  let y = 0.62;
  let r = y + 2.0 * (1.0 - kr) * cr;
  let b = y + 2.0 * (1.0 - kb) * cb;
  let g = (y - kr * r - kb * b) / max(kg, 1e-4);
  let fl = min(0.0, min(r, min(g, b)));
  let r0 = r - fl;
  let g0 = g - fl;
  let b0 = b - fl;
  let pk = max(y, max(r0, max(g0, max(b0, 1e-6))));
  return clamp(
    vec3f(r0 / pk, g0 / pk, b0 / pk) * 0.72 + vec3f(0.88, 1.0, 0.92) * 0.28,
    vec3f(0.0),
    vec3f(1.0),
  );
}

fn xyToDisplayTint(x: f32, y: f32) -> vec3f {
  if (y <= 1e-5) { return vec3f(0.75, 0.85, 1.0); }
  let X = x / y;
  let Y = 1.0;
  let Z = (1.0 - x - y) / y;
  var lin = vec3f(
    3.2409699 * X - 1.5373832 * Y - 0.4986108 * Z,
    -0.9692436 * X + 1.8759675 * Y + 0.0415551 * Z,
    0.0556301 * X - 0.2039770 * Y + 1.0569715 * Z,
  );
  let mn = min(lin.x, min(lin.y, lin.z));
  if (mn < 0.0) {
    let mx = max(lin.x, max(lin.y, lin.z));
    if (mx > mn) {
      let t = -mn / (mx - mn);
      lin = lin * (1.0 - t) + vec3f(mx * t);
    } else {
      lin = vec3f(0.0);
    }
  }
  let pk = max(max(lin.x, max(lin.y, lin.z)), 1e-6);
  let lift = 0.12;
  return vec3f(
    linearToSrgb((lin.x / pk) * (1.0 - lift) + lift),
    linearToSrgb((lin.y / pk) * (1.0 - lift) + lift),
    linearToSrgb((lin.z / pk) * (1.0 - lift) + lift),
  );
}

/**
 * Crisp scatter density resolver:
 * - Sparse bins (noise / faint watermarks) render at exact 1 px with zero bloat.
 * - Concentrated peaks (>= 0.4% of frame samples, e.g. colour bars & white point)
 *   emit a tight circular pinpoint phosphor halo (radius <= 4 dev px).
 */
fn scatterIntensityAndZone(
  col: i32,
  row: i32,
  plotW: u32,
  plotH: u32,
  stride: u32,
  totalSamples: f32,
  gain: f32,
  gamma: f32,
  wantZones: bool,
) -> vec4f {
  let refCount = max(0.25, totalSamples / 4096.0);
  let peakThreshold = max(2u, u32(ceil(totalSamples * 0.004)));
  let invGamma = 1.0 / max(gamma, 0.05);
  let effGain = max(0.05, gain);

  let idx0 = u32(row) * plotW + u32(col);
  let n0 = density[idx0];
  var bestI = 0.0;
  var bestIdx = idx0;

  if (n0 > 0u) {
    let exp0 = (f32(n0) / refCount) * 0.6 * effGain;
    bestI = min(1.0, pow(1.0 - exp(-exp0), invGamma));
  }

  let r = clamp(i32(round(f32(min(plotW, plotH)) / 115.0)), 3, 5);
  for (var dy = -5; dy <= 5; dy++) {
    if (abs(dy) > r) { continue; }
    let qy = row + dy;
    if (qy < 0 || qy >= i32(plotH)) { continue; }
    for (var dx = -5; dx <= 5; dx++) {
      if (abs(dx) > r || (dx == 0 && dy == 0)) { continue; }
      let qx = col + dx;
      if (qx < 0 || qx >= i32(plotW)) { continue; }
      let dist = sqrt(f32(dx * dx + dy * dy));
      if (dist > f32(r) + 0.35) { continue; }
      let qIdx = u32(qy) * plotW + u32(qx);
      let qn = density[qIdx];
      if (qn < peakThreshold) { continue; }
      let qExp = (f32(qn) / refCount) * 0.6 * effGain;
      let qBase = min(1.0, pow(1.0 - exp(-qExp), invGamma));
      if (qBase < 0.7) { continue; }
      let falloff = select(exp(-(dist - 1.2) * (dist - 1.2) * 0.42), 1.0, dist <= 1.35);
      let cand = qBase * falloff;
      if (cand > bestI) {
        bestI = cand;
        bestIdx = qIdx;
      }
    }
  }

  if (!wantZones || bestI <= 0.0) {
    return vec4f(0.0, 0.0, 0.0, bestI);
  }
  let z1 = f32(density[stride + bestIdx]);
  let z2 = f32(density[2u * stride + bestIdx]);
  let z3 = f32(density[3u * stride + bestIdx]);
  let zSum = max(1.0, z1 + z2 + z3);
  let zCol = (ZONE_SHADOW * z1 + ZONE_MID * z2 + mix(ZONE_HIGH, ZONE_PEAK, 0.6) * z3 * 1.25) / zSum;
  return vec4f(clamp(zCol, vec3f(0.0), vec3f(1.0)), bestI);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let canvasW = p.size.x;
  let canvasH = p.size.y;
  let mode = p.size.w;

  let subMode = p.modeOpts.x;
  let traceMode = p.modeOpts.y;
  let coordIsUV = p.modeOpts.w == 1u;

  let gain = p.opts.x;
  let gamma = p.opts.y;
  let zoom = p.opts.z;
  let totalSamples = max(p.opts.w, 1.0);
  let panY = p.view.y;

  let canvasX = in.uv.x * f32(canvasW);
  let canvasY = in.uv.y * f32(canvasH);
  let padL = f32(p.plot.x);
  let padT = f32(p.plot.y);
  let plotW = p.plot.z;
  let plotH = p.plot.w;

  if (canvasX < padL || canvasY < padT ||
      canvasX >= padL + f32(plotW) || canvasY >= padT + f32(plotH)) {
    discard;
  }

  let col = min(plotW - 1u, u32(canvasX - padL));
  let row = min(plotH - 1u, u32(canvasY - padT));
  let stride = plotW * plotH;

  let normRowY = 1.0 - (f32(row) + 0.5) / f32(max(plotH, 1u));
  let rowAxis = panY + normRowY / max(zoom, 1.0);

  var acc = vec4f(0.0);

  if (mode == 0u) {
    // Waveform (linearly interpolated across density columns when plotW > densW)
    let densW = max(1u, u32(round(p.frameB.w)));
    let dStride = densW * plotH;
    let visCols = f32(densW) * zoom;
    let colSamples = totalSamples / visCols;
    let waveRefHits = max(colSamples * 0.05, 2.5);

    let fx = clamp(((f32(col) + 0.5) / f32(max(plotW, 1u))) * f32(densW) - 0.5, 0.0, f32(densW - 1u));
    let c0 = u32(floor(fx));
    let c1 = min(densW - 1u, c0 + 1u);
    let cFrac = fx - f32(c0);

    if (traceMode == 2u) {
      let w0 = f32(density[row * densW + c0]);
      let w1 = f32(density[row * densW + c1]);
      let rawW = mix(w0, w1, cFrac);
      let hits = (rawW / WEIGHT_SCALE) / waveRefHits;
      let i = phosphor(hits, gain, gamma);
      let rgb0 = vec3f(
        f32(density[dStride + row * densW + c0]),
        f32(density[2u * dStride + row * densW + c0]),
        f32(density[3u * dStride + row * densW + c0]),
      );
      let rgb1 = vec3f(
        f32(density[dStride + row * densW + c1]),
        f32(density[2u * dStride + row * densW + c1]),
        f32(density[3u * dStride + row * densW + c1]),
      );
      let rgbSum = mix(rgb0, rgb1, cFrac);
      let avgRgb = clamp(rgbSum / max(rawW, 1.0), vec3f(0.15), vec3f(1.0));
      let peakC = max(max(avgRgb.r, max(avgRgb.g, avgRgb.b)), 0.25);
      let brightRgb = mix(avgRgb / peakC, vec3f(1.0), 0.15);
      acc = vec4f(brightRgb * i, i);
    } else if (subMode <= 3u) {
      let rawW = mix(f32(density[row * densW + c0]), f32(density[row * densW + c1]), cFrac);
      let hits = (rawW / WEIGHT_SCALE) / waveRefHits;
      let i = phosphor(hits, gain, gamma);
      var c = channelTint(0u, subMode);
      if (traceMode == 1u) { c = MONO_TINT; }
      if (traceMode == 3u) { c = hdrZoneColorFromAxis(rowAxis); }
      if (traceMode == 4u) { c = GREEN_TINT; }
      acc = vec4f(c * i, i);
    } else {
      let nPlanes = select(3u, 4u, subMode == 5u);
      var sumRgb = vec3f(0.0);
      var maxI = 0.0;
      for (var ch = 0u; ch < nPlanes; ch++) {
        let rawW = mix(
          f32(density[ch * dStride + row * densW + c0]),
          f32(density[ch * dStride + row * densW + c1]),
          cFrac,
        );
        let hits = (rawW / WEIGHT_SCALE) / waveRefHits;
        let i = phosphor(hits, gain, gamma);
        maxI = max(maxI, i);
        var c = channelTint(ch, subMode);
        if (traceMode == 1u) { c = MONO_TINT * (1.0 / f32(nPlanes)) * 1.65; }
        if (traceMode == 3u) {
          if (subMode == 6u && ch > 0u) {
            c = vec3f(0.45, 0.52, 0.58) * 0.65;
          } else {
            c = hdrZoneColorFromAxis(rowAxis) * 0.75;
          }
        }
        if (traceMode == 4u) { c = GREEN_TINT * 0.65; }
        sumRgb += c * i;
      }
      let clamped = clamp(sumRgb, vec3f(0.0), vec3f(1.0));
      acc = vec4f(clamped, clamp(max(maxI, max(clamped.r, max(clamped.g, clamped.b))), 0.0, 1.0));
    }
  } else if (mode == 1u) {
    // Parade (subMode: 0=RGB, 1=YRGB, 2=YUV)
    let numSlices = select(3u, 4u, subMode == 1u);
    let screenSliceW = max(plotW / numSlices, 1u);
    let slice = min(col / screenSliceW, numSlices - 1u);
    let densW = max(numSlices, u32(round(p.frameB.w)));
    let densSliceW = max(densW / numSlices, 1u);
    let dStride = densW * plotH;
    let visCols = f32(densSliceW) * zoom;
    let colSamples = totalSamples / visCols;
    let waveRefHits = max(colSamples * 0.05, 2.5);

    let localScreenCol = min(screenSliceW - 1u, col - slice * screenSliceW);
    let localFx = clamp(
      ((f32(localScreenCol) + 0.5) / f32(screenSliceW)) * f32(densSliceW) - 0.5,
      0.0,
      f32(densSliceW - 1u),
    );
    let lc0 = u32(floor(localFx));
    let lc1 = min(densSliceW - 1u, lc0 + 1u);
    let cFrac = localFx - f32(lc0);
    let dc0 = slice * densSliceW + lc0;
    let dc1 = slice * densSliceW + lc1;

    let rawW = mix(f32(density[row * densW + dc0]), f32(density[row * densW + dc1]), cFrac);
    let hits = (rawW / WEIGHT_SCALE) / waveRefHits;
    let i = phosphor(hits, gain, gamma);

    var tint = vec3f(1.0);
    if (subMode == 0u) {
      tint = channelTint(slice, 4u);
    } else if (subMode == 1u) {
      tint = channelTint(slice, 5u);
    } else {
      tint = channelTint(slice, 6u);
    }

    if (traceMode == 1u) {
      tint = MONO_TINT;
    } else if (traceMode == 2u) {
      let rgb0 = vec3f(
        f32(density[dStride + row * densW + dc0]),
        f32(density[2u * dStride + row * densW + dc0]),
        f32(density[3u * dStride + row * densW + dc0]),
      );
      let rgb1 = vec3f(
        f32(density[dStride + row * densW + dc1]),
        f32(density[2u * dStride + row * densW + dc1]),
        f32(density[3u * dStride + row * densW + dc1]),
      );
      let rgbSum = mix(rgb0, rgb1, cFrac);
      let avgRgb = clamp(rgbSum / max(rawW, 1.0), vec3f(0.15), vec3f(1.0));
      let peakC = max(max(avgRgb.r, max(avgRgb.g, avgRgb.b)), 0.25);
      tint = mix(avgRgb / peakC, vec3f(1.0), 0.15);
    } else if (traceMode == 3u) {
      if (subMode == 2u && slice > 0u) {
        tint = channelTint(slice, 6u) * 0.75;
      } else {
        tint = hdrZoneColorFromAxis(rowAxis);
      }
    } else if (traceMode == 4u) {
      tint = GREEN_TINT;
    }
    acc = vec4f(tint * i, i);
  } else if (mode == 2u) {
    // Vectorscope
    let cx = p.frameA.x;
    let cy = p.frameA.y;
    let discCx = p.frameA.z;
    let discCy = p.frameA.w;
    let radius = p.frameB.x;
    let scale = max(p.frameB.y, 1e-4);

    let px = f32(col) + 0.5;
    let py = f32(row) + 0.5;
    if (length(vec2f(px - discCx, py - discCy)) > radius + 2.5) {
      discard;
    }
    let s = scatterIntensityAndZone(
      i32(col), i32(row), plotW, plotH, stride, totalSamples, gain, gamma, traceMode == 3u
    );
    let i = s.w;
    if (i <= 0.004) { discard; }
    var c = MONO_TINT;
    if (traceMode == 1u) {
      c = MONO_TINT;
    } else if (traceMode == 3u) {
      c = s.rgb;
    } else if (traceMode == 4u) {
      c = GREEN_TINT;
    } else {
      let cb = (px - cx) / scale;
      let cr = (cy - py) / scale;
      c = chromaToDisplayTint(cb, cr);
    }
    acc = vec4f(c * i, i);
  } else if (mode == 3u) {
    // CIE 1931 xy / 1976 u'v'
    let fLeft = p.frameA.x;
    let fTop = p.frameA.y;
    let fHeight = p.frameA.w;
    let fx0 = p.frameB.x;
    let fy0 = p.frameB.y;
    let fScale = max(p.frameB.z, 1e-4);

    let px = f32(col) + 0.5;
    let py = f32(row) + 0.5;
    let s = scatterIntensityAndZone(
      i32(col), i32(row), plotW, plotH, stride, totalSamples, gain, gamma, traceMode == 3u
    );
    let i = s.w;
    if (i <= 0.004) { discard; }
    var c = MONO_TINT;
    if (traceMode == 1u) {
      c = MONO_TINT;
    } else if (traceMode == 3u) {
      c = s.rgb;
    } else if (traceMode == 4u) {
      c = GREEN_TINT;
    } else {
      var cx = fx0 + (px - fLeft) / fScale;
      var cy = fy0 + (fTop + fHeight - py) / fScale;
      if (coordIsUV) {
        let den = 6.0 * cx - 16.0 * cy + 12.0;
        if (abs(den) > 1e-5) {
          let x = (9.0 * cx) / den;
          let y = (4.0 * cy) / den;
          c = xyToDisplayTint(x, y);
        }
      } else {
        c = xyToDisplayTint(cx, cy);
      }
    }
    acc = vec4f(c * i, i);
  } else if (mode == 4u) {
    // Histogram (1D bins along X, normalized log/power curve along Y)
    let nPlanes = select(select(1u, 3u, subMode >= 4u), 4u, subMode == 5u);
    let binRef = max(totalSamples / f32(max(plotW, 1u)), 1.0);
    let yFrac = 1.0 - (f32(row) + 0.5) / f32(max(plotH, 1u));
    let binAxis = p.view.x + ((f32(col) + 0.5) / f32(max(plotW, 1u))) / max(zoom, 1.0);

    var sumRgb = vec3f(0.0);
    var maxA = 0.0;
    for (var ch = 0u; ch < nPlanes; ch++) {
      let base = ch * plotW;
      let c0 = f32(density[base + col]) / WEIGHT_SCALE;
      let cm = f32(density[base + max(1u, col) - 1u]) / WEIGHT_SCALE;
      let cp = f32(density[base + min(plotW - 1u, col + 1u)]) / WEIGHT_SCALE;
      let smoothHits = cm * 0.22 + c0 * 0.56 + cp * 0.22;
      let curveH = clamp(
        (log2(1.0 + (smoothHits / binRef) * gain * 14.0) / 7.2) * pow(1.0 / max(gamma, 0.2), 0.5),
        0.0,
        0.995,
      );
      if (curveH <= 0.002) { continue; }
      let pxDist = (yFrac - curveH) * f32(plotH);
      var a = 0.0;
      if (abs(pxDist) <= 1.6) {
        // Crisp anti-aliased crest stroke
        a = clamp(1.0 - abs(pxDist) / 1.6, 0.0, 1.0) * 0.96;
      } else if (pxDist < 0.0) {
        // Translucent Resolve-style gradient fill below the curve
        let fillGrad = clamp(0.12 + 0.22 * (yFrac / max(curveH, 1e-3)), 0.0, 0.34);
        a = fillGrad;
      }
      if (a <= 0.0) { continue; }

      var c = channelTint(ch, subMode);
      if (traceMode == 1u) { c = MONO_TINT; }
      if (traceMode == 3u) { c = hdrZoneColorFromAxis(binAxis); }
      if (traceMode == 4u) { c = GREEN_TINT; }
      sumRgb += c * a;
      maxA = max(maxA, a);
    }
    let outRgb = clamp(sumRgb, vec3f(0.0), vec3f(1.0));
    acc = vec4f(outRgb, clamp(max(maxA, max(outRgb.r, max(outRgb.g, outRgb.b))), 0.0, 1.0));
  }

  if (acc.a <= 0.002) { discard; }
  return acc;
}
