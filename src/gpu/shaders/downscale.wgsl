@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

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

// uv spans the whole source, and analysisSize preserves aspect ratio, so a
// single bilinear sample per destination texel is the entire resize.
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(srcTex, samp, in.uv, 0.0).rgb, 1.0);
}
