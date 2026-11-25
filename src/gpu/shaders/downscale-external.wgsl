// Zero-copy downscale: external video texture -> fixed-size analysis texture.
//
// This is the same job as downscale.wgsl, but the source is a `texture_external`
// handed to us by importExternalTexture. That saves the full-resolution
// rgba8 copy (0.8 ms and 3.7 MB per frame at 1280x720, versus 0.1 ms and 0).
//
// External textures only support textureSampleBaseClampToEdge with a sampler,
// so the analysis texture is filled by sampling rather than textureLoad. The
// sampler must be linear so a 1080p source is properly averaged down to 640x360
// instead of point-sampled.

@group(0) @binding(0) var srcTex: texture_external;
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

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(srcTex, samp, in.uv);
  return vec4f(c.rgb, 1.0);
}
