// Raw-plane downscale.
//
// The display path feeds `accumulate` values the browser has already expanded
// to the legal span, which `accumulate.blend()` then maps back to code space.
// A raw I420 frame is different: Y is *already* a code value, so expanding it
// again would double-compress the signal.
//
// To keep one accumulate shader, this pass packs the planes into an rgba8
// texture with a fixed convention:
//   R = Y code value (0..1, i.e. code/255)
//   G = U in (code - 128) / 224  + 0.5
//   B = V in (code - 128) / 224  + 0.5
//
// The three planes stay separate textures: U and V are sampled independently
// here, so the CPU never has to interleave them. Interleaving on the CPU was
// measured at ~90 ms/frame for 1080p, which is why this shader exists.

@group(0) @binding(0) var yPlane: texture_2d<f32>;
@group(0) @binding(1) var uPlane: texture_2d<f32>;
@group(0) @binding(2) var vPlane: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(pts[i], 0.0, 1.0);
  o.uv = vec2f((pts[i].x + 1.0) * 0.5, (pts[i].y + 1.0) * 0.5);
  return o;
}

fn normChroma(code: f32) -> f32 {
  // 224/255 is the legal chroma span; recentre so 0.5 is neutral.
  return (code - 128.0 / 255.0) * (255.0 / 224.0) * 0.5 + 0.5;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let y = textureSampleLevel(yPlane, samp, in.uv, 0.0).r;
  let u = textureSampleLevel(uPlane, samp, in.uv, 0.0).r;
  let v = textureSampleLevel(vPlane, samp, in.uv, 0.0).r;
  return vec4f(y, normChroma(u), normChroma(v), 1.0);
}
