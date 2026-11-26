struct DownscaleParams {
  transferFix: u32, // 0=none, 1=bt709_apple(1.9609375), 2=bt709_itu
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: DownscaleParams;

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

fn srgbToLinearChan(v: f32) -> f32 {
  let a = abs(v);
  let lin = select(a / 12.92, pow((a + 0.055) / 1.055, 2.4), a > 0.04045);
  return select(-lin, lin, v >= 0.0);
}

fn linearToBt709Itu(l: f32) -> f32 {
  let v = max(l, 0.0);
  return select(4.5 * v, 1.0992968 * pow(v, 0.45) - 0.0992968, v >= 0.01805397);
}

fn recoverSignalRgb(rgb: vec3f, mode: u32) -> vec3f {
  if (mode == 0u) {
    return rgb;
  }
  let lin = vec3f(srgbToLinearChan(rgb.r), srgbToLinearChan(rgb.g), srgbToLinearChan(rgb.b));
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

// uv spans the whole source, and analysisSize preserves aspect ratio, so a
// single bilinear sample per destination texel is the entire resize.
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb;
  return vec4f(recoverSignalRgb(c, u.transferFix), 1.0);
}
