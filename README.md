# Video Scopes

A Manifest V3 Chrome extension that overlays professional video scopes on any
`<video>` element on the web: luma / RGB / RGB-parade waveform, vectorscope, and
CIE 1931 / 1976 chromaticity diagrams, with correct video-range handling.

## Install (development)

```bash
pnpm install
pnpm build          # writes dist/
```

Then in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `dist/` folder
3. Open any page with a video and press **Alt+S**

`Alt+S` toggles the panel. Drag the header to move it, drag the bottom-right
corner to resize. The layout, units, range override and quality tier persist
across sessions.

> Note: Chrome 137+ removed the `--load-extension` command-line switch, so
> loading must be done through the UI. `pnpm verify:manifest` checks everything
> about the package that can be verified without installing it.

## What it shows

| Scope | What it tells you |
| --- | --- |
| **Waveform (Y / RGB / Parade)** | Exposure and black level per column. RGB overlay exposes colour casts; parade separates the channels. |
| **Vectorscope** | Hue and saturation. 75% and 100% bar targets are computed from the active matrix, plus the 123° skin-tone line. |
| **CIE 1931 xy / 1976 u'v'** | Where the image sits inside the visible gamut, with Rec.709 / P3 / Rec.2020 triangles overlaid. |

### Scales

`IRE`, `8-bit`, `10-bit`, `mV`, and `nits` are different labels on **one shared
code-value axis**, so switching scales never moves the trace. That is deliberate
and is asserted by tests.

## Video range

Range is read from the decoder, not guessed: `new VideoFrame(video).colorSpace`
exposes `fullRange`, `matrix`, `primaries` and `transfer`. The status badge shows
what was found, e.g. `BT709 · limited · bt709 · NV12`.

Because the axis is in code space, a limited-range signal draws its black at
6.27% of the plot height instead of at the floor — the same thing a hardware
waveform monitor does. If the metadata looks wrong (a limited signal declared
full, or the reverse), a heuristic over the frame's luma percentiles raises a
warning after 3 consecutive frames. You can override with the `range` selector.

## Performance

Smoothness is the first constraint; precision is a dial.

- **Fixed analysis resolution.** Every frame is downscaled once to 640×360
  (long edge), shared by all scopes. Cost is therefore independent of source
  resolution: a 4K source costs 2.8% of a full-resolution pass.
- **Frame-driven.** `requestVideoFrameCallback` means the scopes advance when the
  video does, and cost nothing while paused.
- **Adaptive governor.** GPU time is measured per frame against a 4 ms budget.
  Sustained overshoot walks down five tiers (60 fps/4 panels → 15 fps/1 panel);
  a catastrophic frame skips two. Recovery requires 60 stable frames so the
  display does not oscillate. Click the badge to pin the current tier.
- Measured on a 1080p30 source with all four panels open: ~32 fps, ~1.6 ms GPU.

## Development

```bash
pnpm test              # unit tests (vitest)
pnpm build             # production bundle
pnpm verify:manifest   # manifest + CSP + bundle integrity
pnpm verify            # pixel-measured scope checks in real Chrome + WebGPU
pnpm verify:e2e        # injects the built content script on a live <video>
pnpm verify:all        # everything above
```

The two browser suites drive real Chrome over WebGPU and assert on measured
pixels (for example "a 75% legal bar must read 75 ± 4 IRE", "switching units must
not move the trace"), not on screenshots. Screenshots land in
`docs/screenshots/`.

`public/test-harness.html` is a standalone page for manual inspection; it renders
known patterns through `captureStream` and accepts `?range=`, `?units=`,
`?mode=`, `?pattern=` and `?analysis=`.

## Known limitations

1. **Display-referred by default.** The pixels come from
   `copyExternalImageToTexture`, i.e. after the browser's colour management. For
   SDR Rec.709 this is accurate (the range expansion is inverted exactly). For
   PQ/HLG or non-Rec.709 primaries, switch to the raw-plane path.
2. **`nits` assumes PQ.** The axis is read as a PQ signal, which is exact for
   HDR. On SDR content it is just a different set of reference ticks; the UI
   labels it `PQ assumed`.
3. **Raw-plane mode has no per-channel RGB.** Only Y/U/V are available, so RGB
   parade mirrors luma and is labelled accordingly.
4. **DRM video cannot be analysed.** EME-encrypted frames expose no pixels to the
   page.
5. **Cross-origin video without CORS is not analysable by default.** Requires the
   opt-in network-rule path.
6. **The governor simplifies layouts under load.** From tier 3 the 2×2 grid drops
   to three panels, at tier 4 to one. Preferring a readable video over a fourth
   scope is intentional; pin a tier to opt out.

## Architecture

```
content script
├── video-detector   pick the main <video>, follow SPA navigation
├── frame-loop       rVFC, with a rAF watchdog for sources that never fire it
├── color-space      VideoFrame.colorSpace -> matrix / primaries / fullRange
├── scope-controller owns every GPU resource; one downscale shared by all scopes
└── ui/hud           shadow DOM panel (DOM + events only, no drawing)

core (pure, unit tested)
├── color      luma/chroma matrices, primaries, transfer functions, CIE locus
├── scale      code-space quantisation and unit ticks
├── range-detector  metadata + percentile heuristics
├── perf-governor   tier decisions
└── scopes/reference  CPU kernels that serve as the GPU oracle

gpu
├── downscale.wgsl   source -> fixed analysis texture
├── accumulate.wgsl  compute: pixel -> atomic density bins
└── resolve.wgsl     phosphor transfer + composite to a transparent canvas
```

The GPU density pass and its CPU reference implementation share one index
convention; the reference is the oracle the shader is checked against.
