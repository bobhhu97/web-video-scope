struct Params {
  size: vec4u,      // srcW, srcH, plotW, plotH
  opts: vec4u,      // accMode(0=wave,1=parade,2=vec,3=cie,4=hist), subMode, traceMode, flags
  coeff: vec4f,     // kr, kg, kb, zoom
  srcCoeff: vec4f,  // sourceMatrix kr, kg, kb, sdrWhiteNits
  m0: vec4f,        // rgb -> xyz row 0
  m1: vec4f,        // rgb -> xyz row 1
  m2: vec4f,        // rgb -> xyz row 2
  axis: vec4f,      // black, span, gain, gamma
  view: vec4f,      // panX, panY, nitLow, nitHigh
  frameA: vec4f,    // vec: (cx, cy, discCx, discCy) | cie: (left, top, width, height)
  frameB: vec4f,    // vec: (radius, scale, 0, 0)    | cie: (x0, y0, scale, 0)
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> density: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> lumaHist: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> p: Params;

const WEIGHT_SCALE: f32 = 64.0;
const SDR_REF_WHITE_NITS: f32 = 203.0;

const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;

const HLG_A: f32 = 0.17883277;
const HLG_B: f32 = 0.28466892;
const HLG_C: f32 = 0.55991073;

fn srgbToLinear(v: f32) -> f32 {
  let a = abs(v);
  let lin = select(a / 12.92, pow((a + 0.055) / 1.055, 2.4), a > 0.04045);
  return select(-lin, lin, v >= 0.0);
}

fn linearToSrgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  return select(c * 12.92, 1.055 * pow(c, 1.0 / 2.4) - 0.055, c > 0.0031308);
}

fn nitsToPq(nits: f32) -> f32 {
  let y = clamp(nits / 10000.0, 0.0, 1.0);
  let ym = pow(y, PQ_M1);
  return pow((PQ_C1 + PQ_C2 * ym) / (1.0 + PQ_C3 * ym), PQ_M2);
}

fn pqToNits(e: f32) -> f32 {
  let ep = pow(clamp(e, 0.0, 1.0), 1.0 / PQ_M2);
  let num = max(ep - PQ_C1, 0.0);
  let den = max(PQ_C2 - PQ_C3 * ep, 1e-6);
  return 10000.0 * pow(num / den, 1.0 / PQ_M1);
}

fn hlgToLinear(e: f32) -> f32 {
  let v = clamp(e, 0.0, 1.0);
  return select((v * v) / 3.0, (exp((v - HLG_C) / HLG_A) + HLG_B) / 12.0, v > 0.5);
}

fn linearToHlg(l: f32) -> f32 {
  let v = clamp(l, 0.0, 1.0);
  return select(sqrt(3.0 * v), HLG_A * log(max(12.0 * v - HLG_B, 1e-7)) + HLG_C, v > 1.0 / 12.0);
}

fn hlgToNits(e: f32) -> f32 {
  let scene = hlgToLinear(e);
  return 1000.0 * pow(scene, 1.2);
}

fn nitsToHlg(nits: f32) -> f32 {
  let scene = pow(clamp(nits / 1000.0, 0.0, 1.0), 1.0 / 1.2);
  return clamp(linearToHlg(scene), 0.0, 1.0);
}

fn blend(v: f32) -> f32 {
  return p.axis.x + v * p.axis.y;
}

/**
 * Splat one sample onto a waveform/parade column with sub-pixel vertical interpolation.
 * Honours both `zoom` and vertical pan `panY`: visible axis span is `[panY, panY + 1/zoom]`.
 */
fn splatWave(planeOffset: u32, col: u32, dstW: u32, dstH: u32, axis: f32, zoom: f32, panY: f32) {
  let normY = (axis - panY) * zoom;
  if (normY < -0.002 || normY > 1.002) { return; }
  let maxRow = max(dstH, 2u) - 1u;
  let pos = clamp(normY, 0.0, 1.0) * f32(maxRow);
  let b0 = min(maxRow, u32(floor(pos)));
  let b1 = min(maxRow, b0 + 1u);
  let frac = pos - f32(b0);
  let w1 = u32(round(frac * WEIGHT_SCALE));
  let w0 = u32(WEIGHT_SCALE) - w1;
  let r0 = maxRow - b0;
  let r1 = maxRow - b1;
  if (w0 > 0u) {
    atomicAdd(&density[planeOffset + r0 * dstW + col], w0);
  }
  if (w1 > 0u) {
    atomicAdd(&density[planeOffset + r1 * dstW + col], w1);
  }
}

/** Splat with true-pixel RGB accumulation into planes 0..3 (for DaVinci Resolve "Colorize"). */
fn splatWaveColorized(
  col: u32,
  dstW: u32,
  dstH: u32,
  stride: u32,
  axis: f32,
  zoom: f32,
  panY: f32,
  rgb: vec3f,
) {
  let normY = (axis - panY) * zoom;
  if (normY < -0.002 || normY > 1.002) { return; }
  let maxRow = max(dstH, 2u) - 1u;
  let pos = clamp(normY, 0.0, 1.0) * f32(maxRow);
  let b0 = min(maxRow, u32(floor(pos)));
  let b1 = min(maxRow, b0 + 1u);
  let frac = pos - f32(b0);
  let w1 = u32(round(frac * WEIGHT_SCALE));
  let w0 = u32(WEIGHT_SCALE) - w1;
  let r0 = maxRow - b0;
  let r1 = maxRow - b1;
  let cr = clamp(rgb.r, 0.08, 1.0);
  let cg = clamp(rgb.g, 0.08, 1.0);
  let cb = clamp(rgb.b, 0.08, 1.0);
  if (w0 > 0u) {
    let idx0 = r0 * dstW + col;
    atomicAdd(&density[idx0], w0);
    atomicAdd(&density[stride + idx0], u32(round(f32(w0) * cr)));
    atomicAdd(&density[2u * stride + idx0], u32(round(f32(w0) * cg)));
    atomicAdd(&density[3u * stride + idx0], u32(round(f32(w0) * cb)));
  }
  if (w1 > 0u) {
    let idx1 = r1 * dstW + col;
    atomicAdd(&density[idx1], w1);
    atomicAdd(&density[stride + idx1], u32(round(f32(w1) * cr)));
    atomicAdd(&density[2u * stride + idx1], u32(round(f32(w1) * cg)));
    atomicAdd(&density[3u * stride + idx1], u32(round(f32(w1) * cb)));
  }
}

/** Splat 1D horizontal histogram bin with linear interpolation across adjacent bins. */
fn splatHist(planeOffset: u32, dstW: u32, axis: f32, zoom: f32, panX: f32) {
  let normX = (axis - panX) * zoom;
  if (normX < 0.0 || normX > 1.0) { return; }
  let maxBin = max(dstW, 2u) - 1u;
  let pos = clamp(normX, 0.0, 1.0) * f32(maxBin);
  let b0 = min(maxBin, u32(floor(pos)));
  let b1 = min(maxBin, b0 + 1u);
  let frac = pos - f32(b0);
  let w1 = u32(round(frac * WEIGHT_SCALE));
  let w0 = u32(WEIGHT_SCALE) - w1;
  if (w0 > 0u) {
    atomicAdd(&density[planeOffset + b0], w0);
  }
  if (w1 > 0u) {
    atomicAdd(&density[planeOffset + b1], w1);
  }
}

fn sampleInput(x: i32, y: i32, srcW: u32, srcH: u32, lowPass: bool) -> vec4f {
  let cx = clamp(x, 0, i32(srcW) - 1);
  let cy = clamp(y, 0, i32(srcH) - 1);
  let c0 = textureLoad(src, vec2i(cx, cy), 0);
  if (!lowPass) { return c0; }
  let xm = max(0, cx - 1);
  let xp = min(i32(srcW) - 1, cx + 1);
  let cm = textureLoad(src, vec2i(xm, cy), 0);
  let cp = textureLoad(src, vec2i(xp, cy), 0);
  return cm * 0.25 + c0 * 0.5 + cp * 0.25;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let srcW = p.size.x;
  let srcH = p.size.y;
  let dstW = p.size.z;
  let dstH = p.size.w;
  if (gid.x >= srcW || gid.y >= srcH) { return; }

  let accMode = p.opts.x;
  let subMode = p.opts.y;
  let traceMode = p.opts.z;
  let flags = p.opts.w;

  let raw = (flags & 1u) != 0u;
  let coordIsUV = (flags & 2u) != 0u;
  let lowPass = (flags & 4u) != 0u && (accMode == 0u || accMode == 1u);
  let sourceTransfer = (flags >> 3u) & 3u;     // 0=sdr, 1=pq, 2=hlg
  let effectiveTransfer = (flags >> 5u) & 3u;  // 0=sdr, 1=pq, 2=hlg
  let toneFilter = (flags >> 7u) & 3u;         // 0=all, 1=shadows, 2=midtones, 3=highlights
  let recordStats = (flags & 512u) != 0u;

  let kr = p.coeff.x;
  let kg = p.coeff.y;
  let kb = p.coeff.z;
  let zoom = p.coeff.w;
  let panX = p.view.x;
  let panY = p.view.y;
  let nitLow = p.view.z;
  let nitHigh = p.view.w;
  let sdrRefWhite = select(SDR_REF_WHITE_NITS, p.srcCoeff.w, p.srcCoeff.w > 10.0);

  let px = sampleInput(i32(gid.x), i32(gid.y), srcW, srcH, lowPass);

  var axisR = 0.0;
  var axisG = 0.0;
  var axisB = 0.0;
  var axisY = 0.0;
  var cb = 0.0;
  var cr = 0.0;
  var vecCb = 0.0;
  var vecCr = 0.0;
  var dispRgb = vec3f(0.0);
  var linRgb = vec3f(0.0);
  var pixelNits = 0.0;

  if (raw) {
    axisY = clamp(px.r, 0.0, 1.0);
    let cScale = select(224.0 / 255.0, 1.0, p.axis.y < 0.99);
    cb = (px.g - 0.5) * 2.0 * cScale;
    cr = (px.b - 0.5) * 2.0 * cScale;
    vecCb = cb;
    vecCr = cr;
    let yNorm = (axisY - p.axis.x) / max(p.axis.y, 1e-4);
    let rNorm = yNorm + 2.0 * (1.0 - kr) * cr;
    let bNorm = yNorm + 2.0 * (1.0 - kb) * cb;
    let gNorm = (yNorm - kr * rNorm - kb * bNorm) / max(kg, 1e-4);
    axisR = clamp(blend(rNorm), 0.0, 1.0);
    axisG = clamp(blend(gNorm), 0.0, 1.0);
    axisB = clamp(blend(bNorm), 0.0, 1.0);
    dispRgb = clamp(vec3f(rNorm, gNorm, bNorm), vec3f(0.0), vec3f(1.0));

    if (effectiveTransfer == 1u) {
      let nr = pqToNits(clamp(rNorm, 0.0, 1.0));
      let ng = pqToNits(clamp(gNorm, 0.0, 1.0));
      let nb = pqToNits(clamp(bNorm, 0.0, 1.0));
      linRgb = vec3f(nr, ng, nb) / sdrRefWhite;
      pixelNits = max(pqToNits(clamp(yNorm, 0.0, 1.0)), max(nr, max(ng, nb)));
    } else if (effectiveTransfer == 2u) {
      let nr = hlgToNits(clamp(rNorm, 0.0, 1.0));
      let ng = hlgToNits(clamp(gNorm, 0.0, 1.0));
      let nb = hlgToNits(clamp(bNorm, 0.0, 1.0));
      linRgb = vec3f(nr, ng, nb) / sdrRefWhite;
      pixelNits = max(hlgToNits(clamp(yNorm, 0.0, 1.0)), max(nr, max(ng, nb)));
    } else {
      linRgb = vec3f(srgbToLinear(dispRgb.r), srgbToLinear(dispRgb.g), srgbToLinear(dispRgb.b));
      pixelNits = (kr * linRgb.r + kg * linRgb.g + kb * linRgb.b) * sdrRefWhite;
    }
  } else if (sourceTransfer > 0u) {
    // Hardware-decoded HDR video (1u=PQ, 2u=HLG): Downscaler recovered exact normalized
    // [0..1] non-linear PQ/HLG R'G'B' in the stream's native primaries (e.g. BT.2020).
    let rCode = clamp(px.r, 0.0, 1.0);
    let gCode = clamp(px.g, 0.0, 1.0);
    let bCode = clamp(px.b, 0.0, 1.0);
    let yCode = kr * rCode + kg * gCode + kb * bCode;
    var nitsR = 0.0;
    var nitsG = 0.0;
    var nitsB = 0.0;
    var lumNits = 0.0;
    if (sourceTransfer == 1u) {
      nitsR = pqToNits(rCode);
      nitsG = pqToNits(gCode);
      nitsB = pqToNits(bCode);
      lumNits = pqToNits(yCode);
    } else {
      nitsR = hlgToNits(rCode);
      nitsG = hlgToNits(gCode);
      nitsB = hlgToNits(bCode);
      lumNits = hlgToNits(yCode);
    }
    linRgb = vec3f(nitsR, nitsG, nitsB) / sdrRefWhite;
    pixelNits = max(lumNits, max(nitsR, max(nitsG, nitsB)));

    if (effectiveTransfer == 1u) {
      axisR = select(nitsToPq(nitsR), rCode, sourceTransfer == 1u);
      axisG = select(nitsToPq(nitsG), gCode, sourceTransfer == 1u);
      axisB = select(nitsToPq(nitsB), bCode, sourceTransfer == 1u);
    } else if (effectiveTransfer == 2u) {
      axisR = select(nitsToHlg(nitsR), rCode, sourceTransfer == 2u);
      axisG = select(nitsToHlg(nitsG), gCode, sourceTransfer == 2u);
      axisB = select(nitsToHlg(nitsB), bCode, sourceTransfer == 2u);
    } else {
      axisR = clamp(blend(rCode), 0.0, 1.0);
      axisG = clamp(blend(gCode), 0.0, 1.0);
      axisB = clamp(blend(bCode), 0.0, 1.0);
    }
    axisY = kr * axisR + kg * axisG + kb * axisB;
    cb = (bCode - yCode) / (2.0 * (1.0 - kb));
    cr = (rCode - yCode) / (2.0 * (1.0 - kr));
    let skr = p.srcCoeff.x;
    let skb = p.srcCoeff.z;
    let sY = skr * rCode + p.srcCoeff.y * gCode + skb * bCode;
    vecCb = (bCode - sY) / (2.0 * (1.0 - skb));
    vecCr = (rCode - sY) / (2.0 * (1.0 - skr));
    let peakLin = max(1.0, max(linRgb.r, max(linRgb.g, linRgb.b)));
    dispRgb = vec3f(
      linearToSrgb(linRgb.r / peakLin),
      linearToSrgb(linRgb.g / peakLin),
      linearToSrgb(linRgb.b / peakLin),
    );
  } else {
    // SDR display source (or manual HDR curve applied onto [0..1] code signal).
    let rClamped = clamp(px.r, 0.0, 1.0);
    let gClamped = clamp(px.g, 0.0, 1.0);
    let bClamped = clamp(px.b, 0.0, 1.0);
    axisR = clamp(blend(rClamped), 0.0, 1.0);
    axisG = clamp(blend(gClamped), 0.0, 1.0);
    axisB = clamp(blend(bClamped), 0.0, 1.0);
    axisY = kr * axisR + kg * axisG + kb * axisB;
    let yDisp = kr * rClamped + kg * gClamped + kb * bClamped;
    cb = (bClamped - yDisp) / (2.0 * (1.0 - kb));
    cr = (rClamped - yDisp) / (2.0 * (1.0 - kr));

    let skr = p.srcCoeff.x;
    let skb = p.srcCoeff.z;
    let sY = skr * rClamped + p.srcCoeff.y * gClamped + skb * bClamped;
    vecCb = (bClamped - sY) / (2.0 * (1.0 - skb));
    vecCr = (rClamped - sY) / (2.0 * (1.0 - skr));

    dispRgb = vec3f(rClamped, gClamped, bClamped);
    linRgb = vec3f(srgbToLinear(rClamped), srgbToLinear(gClamped), srgbToLinear(bClamped));
    if (effectiveTransfer == 1u) {
      pixelNits = max(pqToNits(axisY), max(pqToNits(axisR), max(pqToNits(axisG), pqToNits(axisB))));
    } else if (effectiveTransfer == 2u) {
      pixelNits = max(hlgToNits(axisY), max(hlgToNits(axisR), max(hlgToNits(axisG), hlgToNits(axisB))));
    } else {
      pixelNits = (kr * linRgb.r + kg * linRgb.g + kb * linRgb.b) * sdrRefWhite;
    }
  }

  if (recordStats) {
    let histY = select(clamp(kr * px.r + kg * px.g + kb * px.b, 0.0, 1.0), axisY, raw);
    atomicAdd(&lumaHist[min(255u, u32(histY * 255.0))], 1u);
    if (pixelNits < nitLow) {
      atomicAdd(&lumaHist[256u], 1u);
    } else if (pixelNits <= nitHigh) {
      atomicAdd(&lumaHist[257u], 1u);
    } else {
      atomicAdd(&lumaHist[258u], 1u);
    }
    let scaledNits = u32(clamp(round(pixelNits * 10.0), 0.0, 100000.0));
    atomicMax(&lumaHist[259u], scaledNits);
  }

  let axisU = clamp(0.5 + cb, 0.0, 1.0);
  let axisV = clamp(0.5 + cr, 0.0, 1.0);
  let stride = dstW * dstH;
  let srcU = (f32(gid.x) + 0.5) / f32(srcW);

  if (accMode == 0u) {
    // Waveform: map horizontal video position through [panX, panX + 1/zoom].
    let normX = (srcU - panX) * zoom;
    if (normX < 0.0 || normX >= 1.0) { return; }
    let col = min(dstW - 1u, u32(normX * f32(dstW)));

    if (traceMode == 2u) {
      // DaVinci Resolve "Colorize": tint trace with actual display RGB of the pixel.
      if (subMode <= 3u) {
        var v = axisY;
        if (subMode == 1u) { v = axisR; }
        if (subMode == 2u) { v = axisG; }
        if (subMode == 3u) { v = axisB; }
        splatWaveColorized(col, dstW, dstH, stride, v, zoom, panY, dispRgb);
      } else {
        splatWaveColorized(col, dstW, dstH, stride, axisR, zoom, panY, dispRgb);
        splatWaveColorized(col, dstW, dstH, stride, axisG, zoom, panY, dispRgb);
        splatWaveColorized(col, dstW, dstH, stride, axisB, zoom, panY, dispRgb);
        if (subMode == 5u) {
          splatWaveColorized(col, dstW, dstH, stride, axisY, zoom, panY, dispRgb);
        }
      }
    } else if (subMode == 4u) {
      // RGB Overlay
      splatWave(0u * stride, col, dstW, dstH, axisR, zoom, panY);
      splatWave(1u * stride, col, dstW, dstH, axisG, zoom, panY);
      splatWave(2u * stride, col, dstW, dstH, axisB, zoom, panY);
    } else if (subMode == 5u) {
      // YRGB Overlay
      splatWave(0u * stride, col, dstW, dstH, axisY, zoom, panY);
      splatWave(1u * stride, col, dstW, dstH, axisR, zoom, panY);
      splatWave(2u * stride, col, dstW, dstH, axisG, zoom, panY);
      splatWave(3u * stride, col, dstW, dstH, axisB, zoom, panY);
    } else if (subMode == 6u) {
      // YUV Overlay
      splatWave(0u * stride, col, dstW, dstH, axisY, zoom, panY);
      splatWave(1u * stride, col, dstW, dstH, axisU, zoom, panY);
      splatWave(2u * stride, col, dstW, dstH, axisV, zoom, panY);
    } else {
      var v = axisY;
      if (subMode == 1u) { v = axisR; }
      if (subMode == 2u) { v = axisG; }
      if (subMode == 3u) { v = axisB; }
      splatWave(0u, col, dstW, dstH, v, zoom, panY);
    }
  } else if (accMode == 1u) {
    // Parade: subMode 0 = RGB (3 slices), 1 = YRGB (4 slices), 2 = YUV (3 slices)
    let normX = (srcU - panX) * zoom;
    if (normX < 0.0 || normX >= 1.0) { return; }
    let numSlices = select(3u, 4u, subMode == 1u);
    let sliceW = max(dstW / numSlices, 1u);
    let localCol = min(sliceW - 1u, u32(normX * f32(sliceW)));

    for (var s = 0u; s < numSlices; s++) {
      let col = min(dstW - 1u, s * sliceW + localCol);
      var v = axisR;
      if (subMode == 0u) {
        if (s == 1u) { v = axisG; }
        if (s == 2u) { v = axisB; }
      } else if (subMode == 1u) {
        if (s == 0u) { v = axisY; }
        if (s == 1u) { v = axisR; }
        if (s == 2u) { v = axisG; }
        if (s == 3u) { v = axisB; }
      } else {
        if (s == 0u) { v = axisY; }
        if (s == 1u) { v = axisU; }
        if (s == 2u) { v = axisV; }
      }
      if (traceMode == 2u) {
        splatWaveColorized(col, dstW, dstH, stride, v, zoom, panY, dispRgb);
      } else {
        splatWave(0u, col, dstW, dstH, v, zoom, panY);
      }
    }
  } else if (accMode == 2u) {
    // Vectorscope (with optional DaVinci Resolve Low/Mid/High Tone filter)
    if (toneFilter > 0u) {
      if (effectiveTransfer > 0u) {
        if (toneFilter == 1u && pixelNits >= nitLow) { return; }
        if (toneFilter == 2u && (pixelNits < nitLow || pixelNits > nitHigh)) { return; }
        if (toneFilter == 3u && pixelNits <= nitHigh) { return; }
      } else {
        if (toneFilter == 1u && axisY >= 0.35) { return; }
        if (toneFilter == 2u && (axisY < 0.30 || axisY > 0.72)) { return; }
        if (toneFilter == 3u && axisY <= 0.68) { return; }
      }
    }
    let cx = p.frameA.x;
    let cy = p.frameA.y;
    let ringR = p.frameB.x;
    let scale = p.frameB.y;
    let sx = cx + vecCb * scale;
    let sy = cy - vecCr * scale;
    let dx = sx - cx;
    let dy = sy - cy;
    if (dx * dx + dy * dy > (ringR + 1.5) * (ringR + 1.5)) { return; }
    if (sx < 0.0 || sx >= f32(dstW) || sy < 0.0 || sy >= f32(dstH)) { return; }
    let idx = u32(floor(sy)) * dstW + u32(floor(sx));
    atomicAdd(&density[idx], 1u);
    if (traceMode == 3u) {
      let hasRefSplit = (sdrRefWhite > nitLow + 8.0) && (sdrRefWhite < nitHigh - 15.0);
      var zPlane = 2u;
      if (pixelNits > nitHigh + 1.0) {
        zPlane = 4u;
      } else if (hasRefSplit) {
        if (pixelNits > sdrRefWhite + 1.0) {
          zPlane = 3u;
        } else if (pixelNits < nitLow) {
          zPlane = 1u;
        }
      } else if (pixelNits > nitLow + 1.0) {
        zPlane = 3u;
      }
      atomicAdd(&density[zPlane * stride + idx], 1u);
    }
  } else if (accMode == 3u) {
    // CIE 1931 xy / 1976 u'v'
    let xyz = vec3f(dot(p.m0.xyz, linRgb), dot(p.m1.xyz, linRgb), dot(p.m2.xyz, linRgb));
    let sum = xyz.x + xyz.y + xyz.z;
    if (sum <= 0.002) { return; }
    var cx = xyz.x / sum;
    var cy = xyz.y / sum;
    if (coordIsUV) {
      let d = xyz.x + 15.0 * xyz.y + 3.0 * xyz.z;
      if (d <= 1e-6) { return; }
      cx = 4.0 * xyz.x / d;
      cy = 9.0 * xyz.y / d;
    }
    let fLeft = p.frameA.x;
    let fTop = p.frameA.y;
    let fWidth = p.frameA.z;
    let fHeight = p.frameA.w;
    let fx0 = p.frameB.x;
    let fy0 = p.frameB.y;
    let fScale = p.frameB.z;
    let sx = fLeft + (cx - fx0) * fScale;
    let sy = fTop + fHeight - (cy - fy0) * fScale;
    if (sx < fLeft || sx >= fLeft + fWidth || sy < fTop || sy >= fTop + fHeight) { return; }
    if (sx < 0.0 || sx >= f32(dstW) || sy < 0.0 || sy >= f32(dstH)) { return; }
    let idx = u32(floor(sy)) * dstW + u32(floor(sx));
    atomicAdd(&density[idx], 1u);
    if (traceMode == 3u) {
      let hasRefSplit = (sdrRefWhite > nitLow + 8.0) && (sdrRefWhite < nitHigh - 15.0);
      var zPlane = 2u;
      if (pixelNits > nitHigh + 1.0) {
        zPlane = 4u;
      } else if (hasRefSplit) {
        if (pixelNits > sdrRefWhite + 1.0) {
          zPlane = 3u;
        } else if (pixelNits < nitLow) {
          zPlane = 1u;
        }
      } else if (pixelNits > nitLow + 1.0) {
        zPlane = 3u;
      }
      atomicAdd(&density[zPlane * stride + idx], 1u);
    }
  } else if (accMode == 4u) {
    // 1D Horizontal Histogram across plotW bins
    if (subMode == 4u) {
      splatHist(0u * dstW, dstW, axisR, zoom, panX);
      splatHist(1u * dstW, dstW, axisG, zoom, panX);
      splatHist(2u * dstW, dstW, axisB, zoom, panX);
    } else if (subMode == 5u) {
      splatHist(0u * dstW, dstW, axisY, zoom, panX);
      splatHist(1u * dstW, dstW, axisR, zoom, panX);
      splatHist(2u * dstW, dstW, axisG, zoom, panX);
      splatHist(3u * dstW, dstW, axisB, zoom, panX);
    } else if (subMode == 6u) {
      splatHist(0u * dstW, dstW, axisY, zoom, panX);
      splatHist(1u * dstW, dstW, axisU, zoom, panX);
      splatHist(2u * dstW, dstW, axisV, zoom, panX);
    } else {
      var v = axisY;
      if (subMode == 1u) { v = axisR; }
      if (subMode == 2u) { v = axisG; }
      if (subMode == 3u) { v = axisB; }
      splatHist(0u, dstW, v, zoom, panX);
    }
  }
}
