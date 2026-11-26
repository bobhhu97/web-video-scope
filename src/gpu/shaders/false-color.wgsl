struct FalseColorParams {
  coeff: vec4f,   // kr, kg, kb, black
  range: vec4f,   // span, nitLow, nitHigh, opacity
  flags: vec4u,   // raw, sourceTransfer(0=sdr,1=pq,2=hlg), effectiveTransfer(0=sdr,1=pq,2=hlg), preset(0=arri,1=smallhd,2=spectrum,3=hdrNits)
  extra: vec4f,   // sdrWhiteNits, transferFix(0=none,1=bt709_apple,2=bt709_itu), 0, 0
  uvRect: vec4f,  // u0, v0, uSpan, vSpan (handles object-fit: cover cropping 1:1)
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> p: FalseColorParams;

const PQ_M1: f32 = 0.1593017578125;
const PQ_M2: f32 = 78.84375;
const PQ_C1: f32 = 0.8359375;
const PQ_C2: f32 = 18.8515625;
const PQ_C3: f32 = 18.6875;

const HLG_A: f32 = 0.17883277;
const HLG_B: f32 = 0.28466892;
const HLG_C: f32 = 0.55991073;

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

fn srgbToLinear(v: f32) -> f32 {
  let a = abs(v);
  let lin = select(a / 12.92, pow((a + 0.055) / 1.055, 2.4), a > 0.04045);
  return select(-lin, lin, v >= 0.0);
}

fn linearToSrgb(v: f32) -> f32 {
  let c = clamp(v, 0.0, 1.0);
  return select(c * 12.92, 1.055 * pow(c, 1.0 / 2.4) - 0.055, c > 0.0031308);
}

fn linearToBt709Itu(l: f32) -> f32 {
  let v = max(l, 0.0);
  return select(4.5 * v, 1.0992968 * pow(v, 0.45) - 0.0992968, v >= 0.01805397);
}

fn recoverSignalRgb(rgb: vec3f, mode: u32) -> vec3f {
  if (mode == 0u) {
    return rgb;
  }
  let lin = vec3f(srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b));
  if (mode == 1u) {
    let invGamma = 1.0 / 1.9609375;
    return vec3f(
      pow(max(lin.r, 0.0), invGamma),
      pow(max(lin.g, 0.0), invGamma),
      pow(max(lin.b, 0.0), invGamma),
    );
  }
  if (mode == 2u) {
    return vec3f(linearToBt709Itu(lin.r), linearToBt709Itu(lin.g), linearToBt709Itu(lin.b));
  }
  if (mode == 3u) {
    let e2020 = vec3f(
      0.6274039 * lin.r + 0.3292830 * lin.g + 0.0433131 * lin.b,
      0.0690973 * lin.r + 0.9195404 * lin.g + 0.0113623 * lin.b,
      0.0163914 * lin.r + 0.0880133 * lin.g + 0.8955953 * lin.b,
    );
    return clamp(e2020, vec3f(0.0), vec3f(1.0));
  }
  if (mode == 4u) {
    let ep3 = vec3f(
      0.8224620 * lin.r + 0.1775380 * lin.g,
      0.0331942 * lin.r + 0.9668058 * lin.g,
      0.0170826 * lin.r + 0.0723974 * lin.g + 0.9105200 * lin.b,
    );
    return clamp(ep3, vec3f(0.0), vec3f(1.0));
  }
  return clamp(lin, vec3f(0.0), vec3f(1.0));
}

fn pqToNits(e: f32) -> f32 {
  let ep = pow(clamp(e, 0.0, 1.0), 1.0 / PQ_M2);
  let num = max(ep - PQ_C1, 0.0);
  let den = max(PQ_C2 - PQ_C3 * ep, 1e-6);
  return 10000.0 * pow(num / den, 1.0 / PQ_M1);
}

fn hlgToNits(e: f32) -> f32 {
  let v = clamp(e, 0.0, 1.0);
  let scene = select((v * v) / 3.0, (exp((v - HLG_C) / HLG_A) + HLG_B) / 12.0, v > 0.5);
  return 1000.0 * pow(scene, 1.2);
}

/** ARRI ALEXA / Amira classic 6-band exposure false color on [0..1] IRE scale. */
fn arriFalseColor(ire: f32) -> vec3f {
  let lumaGrey = clamp(ire, 0.0, 1.0) * 0.84 + 0.05;
  if (ire < 0.025) {
    return vec3f(0.58, 0.16, 0.88); // Purple: black clip (< 2.5%)
  }
  if (ire < 0.045) {
    return vec3f(0.14, 0.44, 0.96); // Blue: just above black (2.5–4.5%)
  }
  if (ire >= 0.38 && ire <= 0.42) {
    return vec3f(0.18, 0.86, 0.32); // Green: 18% middle grey (38–42%)
  }
  if (ire >= 0.52 && ire <= 0.56) {
    return vec3f(0.96, 0.54, 0.70); // Pink: 1-stop over grey / Caucasian skin (52–56%)
  }
  if (ire >= 0.97 && ire < 0.99) {
    return vec3f(0.98, 0.88, 0.16); // Yellow: near white shoulder (97–99%)
  }
  if (ire >= 0.99) {
    return vec3f(0.98, 0.14, 0.16); // Red: white clip (>= 99%)
  }
  return vec3f(lumaGrey);
}

/** SmallHD PageOS multi-zone exposure assist false color on [0..1] IRE scale. */
fn smallHdFalseColor(ire: f32) -> vec3f {
  let lumaGrey = clamp(ire, 0.0, 1.0) * 0.82 + 0.05;
  if (ire < 0.03) {
    return vec3f(0.52, 0.12, 0.84); // Deep Purple: crushed blacks (< 3%)
  }
  if (ire < 0.09) {
    return vec3f(0.15, 0.38, 0.94); // Blue: deep shadows (3–9%)
  }
  if (ire < 0.16) {
    return vec3f(0.16, 0.76, 0.90); // Cyan: shadow detail (9–16%)
  }
  if (ire >= 0.38 && ire <= 0.45) {
    return vec3f(0.20, 0.84, 0.34); // Green: 18% middle grey (38–45%)
  }
  if (ire >= 0.52 && ire <= 0.58) {
    return vec3f(0.96, 0.54, 0.72); // Pink: key skin tone (52–58%)
  }
  if (ire >= 0.85 && ire < 0.94) {
    return vec3f(0.98, 0.84, 0.18); // Yellow: bright highlights (85–94%)
  }
  if (ire >= 0.94) {
    return vec3f(0.98, 0.15, 0.15); // Red: highlight clip (>= 94%)
  }
  return vec3f(lumaGrey);
}

/** Full-range continuous IRE rainbow / thermal spectrum (Atomos / Sony monitor style). */
fn spectrumFalseColor(ire: f32) -> vec3f {
  let v = clamp(ire, 0.0, 1.02);
  if (v < 0.02) { return vec3f(0.42, 0.10, 0.72); }
  if (v >= 0.985) { return vec3f(1.0, 0.12, 0.16); }
  if (v < 0.18) {
    return mix(vec3f(0.14, 0.24, 0.86), vec3f(0.12, 0.76, 0.92), (v - 0.02) / 0.16);
  }
  if (v < 0.40) {
    return mix(vec3f(0.12, 0.76, 0.92), vec3f(0.16, 0.84, 0.38), (v - 0.18) / 0.22);
  }
  if (v < 0.58) {
    return mix(vec3f(0.16, 0.84, 0.38), vec3f(0.88, 0.90, 0.22), (v - 0.40) / 0.18);
  }
  if (v < 0.80) {
    return mix(vec3f(0.88, 0.90, 0.22), vec3f(0.98, 0.56, 0.14), (v - 0.58) / 0.22);
  }
  return mix(vec3f(0.98, 0.56, 0.14), vec3f(0.96, 0.20, 0.58), (v - 0.80) / 0.185);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let sampleUv = clamp(p.uvRect.xy + in.uv * p.uvRect.zw, vec2f(0.0), vec2f(1.0));
  let rawPx = textureSampleLevel(srcTex, samp, sampleUv, 0.0);
  let transferFix = u32(round(p.extra.y));
  let px = vec4f(recoverSignalRgb(rawPx.rgb, transferFix), rawPx.a);
  let raw = p.flags.x == 1u;
  let srcTr = p.flags.y;
  let effTr = p.flags.z;
  let preset = p.flags.w; // 0=arri, 1=smallhd, 2=spectrum, 3=hdr-nits

  let kr = p.coeff.x;
  let kg = p.coeff.y;
  let kb = p.coeff.z;
  let black = p.coeff.w;
  let span = max(p.range.x, 1e-4);
  let nitLow = p.range.y;
  let nitHigh = p.range.z;
  let opacity = p.range.w;
  let sdrWhiteNits = max(p.extra.x, 50.0);

  var nits = 0.0;
  var ireNorm = 0.0; // 0.0 = 0 IRE, 1.0 = 100 IRE (relative to SDR diffuse white on HDR)
  var structLuma = 0.5;

  if (raw) {
    let yNorm = (px.r - black) / span;
    let yClamped = clamp(yNorm, 0.0, 1.0);
    structLuma = yClamped;
    if (effTr == 1u) {
      nits = pqToNits(yClamped);
      ireNorm = linearToSrgb(nits / sdrWhiteNits);
    } else if (effTr == 2u) {
      nits = hlgToNits(yClamped);
      ireNorm = linearToSrgb(nits / sdrWhiteNits);
    } else {
      ireNorm = yNorm;
      nits = srgbToLinear(yClamped) * sdrWhiteNits;
    }
  } else if (srcTr > 0u) {
    // Hardware-decoded HDR video (1u=PQ, 2u=HLG): recoverSignalRgb restored exact [0..1]
    // non-linear PQ/HLG R'G'B' in the stream's native primaries (e.g. BT.2020).
    let rCode = clamp(px.r, 0.0, 1.0);
    let gCode = clamp(px.g, 0.0, 1.0);
    let bCode = clamp(px.b, 0.0, 1.0);
    let yCode = kr * rCode + kg * gCode + kb * bCode;
    var nR = 0.0;
    var nG = 0.0;
    var nB = 0.0;
    var lumNits = 0.0;
    if (srcTr == 1u) {
      nR = pqToNits(rCode);
      nG = pqToNits(gCode);
      nB = pqToNits(bCode);
      lumNits = pqToNits(yCode);
    } else {
      nR = hlgToNits(rCode);
      nG = hlgToNits(gCode);
      nB = hlgToNits(bCode);
      lumNits = hlgToNits(yCode);
    }
    nits = max(lumNits, max(nR, max(nG, nB)));
    let relLin = lumNits / sdrWhiteNits;
    ireNorm = select(linearToSrgb(relLin), 0.99 + clamp((relLin - 1.0) * 0.1, 0.0, 0.1), relLin > 1.0);
    structLuma = yCode;
  } else {
    let r = clamp(px.r, 0.0, 1.0);
    let g = clamp(px.g, 0.0, 1.0);
    let b = clamp(px.b, 0.0, 1.0);
    let y = kr * r + kg * g + kb * b;
    structLuma = y;
    if (effTr == 1u) {
      let ar = clamp(black + r * span, 0.0, 1.0);
      let ag = clamp(black + g * span, 0.0, 1.0);
      let ab = clamp(black + b * span, 0.0, 1.0);
      let ay = kr * ar + kg * ag + kb * ab;
      nits = max(pqToNits(ay), max(pqToNits(ar), max(pqToNits(ag), pqToNits(ab))));
      ireNorm = ay;
    } else if (effTr == 2u) {
      let ar = clamp(black + r * span, 0.0, 1.0);
      let ag = clamp(black + g * span, 0.0, 1.0);
      let ab = clamp(black + b * span, 0.0, 1.0);
      let ay = kr * ar + kg * ag + kb * ab;
      nits = max(hlgToNits(ay), max(hlgToNits(ar), max(hlgToNits(ag), hlgToNits(ab))));
      ireNorm = ay;
    } else {
      // Strictly broadcast Luminance Y' IRE (matches Eyedropper Luma IRE & Waveform Y 1:1)
      ireNorm = y;
      let linY = kr * srgbToLinear(r) + kg * srgbToLinear(g) + kb * srgbToLinear(b);
      nits = linY * sdrWhiteNits;
    }
  }

  var outRgb = vec3f(0.0);
  if (preset == 0u) {
    outRgb = arriFalseColor(ireNorm);
  } else if (preset == 1u) {
    outRgb = smallHdFalseColor(ireNorm);
  } else if (preset == 2u) {
    outRgb = spectrumFalseColor(ireNorm) * (0.76 + 0.24 * clamp(structLuma, 0.0, 1.0));
  } else {
    // Mode 3: HDR 3-to-4 Zone Nit False Color
    // - 4 zones when sdrWhiteNits sits distinctly between nitLow and nitHigh:
    //     <nitLow Blue/Cyan · nitLow–sdrWhite Green · sdrWhite–nitHigh Yellow · >nitHigh Red
    // - 3 zones when nitLow coincides with or exceeds sdrWhiteNits (e.g. 203/1k):
    //     <=nitLow Green · nitLow–nitHigh Yellow · >nitHigh Red
    let detail = 0.52 + 0.48 * clamp(structLuma, 0.0, 1.0);
    let hasRefSplit = (sdrWhiteNits > nitLow + 8.0) && (sdrWhiteNits < nitHigh - 15.0);
    if (hasRefSplit) {
      if (nits < nitLow) {
        let t = clamp(nits / max(nitLow, 0.1), 0.0, 1.0);
        outRgb = mix(vec3f(0.12, 0.42, 0.86), vec3f(0.22, 0.76, 0.98), t) * (0.62 + 0.38 * detail);
      } else if (nits <= sdrWhiteNits + 1.0) {
        let t = clamp((nits - nitLow) / max(sdrWhiteNits - nitLow, 1.0), 0.0, 1.0);
        outRgb = mix(vec3f(0.16, 0.82, 0.46), vec3f(0.26, 0.92, 0.52), t) * detail;
      } else if (nits <= nitHigh + 1.0) {
        let t = clamp((nits - sdrWhiteNits) / max(nitHigh - sdrWhiteNits, 1.0), 0.0, 1.0);
        outRgb = mix(vec3f(0.98, 0.88, 0.16), vec3f(1.0, 0.76, 0.10), t) * (0.80 + 0.20 * detail);
      } else {
        let over = clamp((nits - nitHigh) / max(nitHigh * 2.0, 500.0), 0.0, 1.0);
        outRgb = mix(vec3f(0.98, 0.22, 0.20), vec3f(1.0, 0.08, 0.24), over) * (0.84 + 0.16 * detail);
      }
    } else {
      if (nits <= nitLow + 1.0) {
        let t = clamp(nits / max(nitLow, 0.1), 0.0, 1.0);
        outRgb = mix(vec3f(0.14, 0.68, 0.56), vec3f(0.24, 0.88, 0.52), t) * (0.65 + 0.35 * detail);
      } else if (nits <= nitHigh + 1.0) {
        let t = clamp((nits - nitLow) / max(nitHigh - nitLow, 1.0), 0.0, 1.0);
        outRgb = mix(vec3f(0.98, 0.88, 0.16), vec3f(1.0, 0.76, 0.10), t) * (0.80 + 0.20 * detail);
      } else {
        let over = clamp((nits - nitHigh) / max(nitHigh * 2.0, 500.0), 0.0, 1.0);
        outRgb = mix(vec3f(0.98, 0.22, 0.20), vec3f(1.0, 0.08, 0.24), over) * (0.84 + 0.16 * detail);
      }
    }
  }

  return vec4f(outRgb * opacity, opacity);
}
