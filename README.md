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

- **Zero-copy upload.** Video frames reach the GPU via `importExternalTexture`,
  which hands over a handle to the decoder's own surface instead of copying
  pixels. Measured at 1280×720: **0.10 ms/frame and 0 bytes moved**, against
  0.80 ms and 3.7 MB for a full-resolution copy — an 8× reduction in the upload
  step alone. The copy path remains as a fallback for cross-origin video, where
  import throws a `SecurityError`.
- **Fixed analysis resolution.** Frames are downscaled once to 640×360
  (long edge), shared by all scopes. Cost is therefore independent of source
  resolution: a 4K source costs 2.8% of a full-resolution pass.
- **Frame-driven.** `requestVideoFrameCallback` means the scopes advance when the
  video does, and cost nothing while paused.
- **Adaptive governor.** GPU time is measured per frame against a 4 ms budget.
  Sustained overshoot walks down five tiers (60 fps/4 panels → 15 fps/1 panel);
  a catastrophic frame skips two. Recovery requires 60 stable frames so the
  display does not oscillate. Click the badge to pin the current tier.
- Measured on a 1080p30 source with all four panels open: ~30 fps, ~1.7 ms GPU,
  zero-copy upload confirmed. Raw-plane mode reaches ~34 fps at ~1.7 ms.

All of the above runs on the GPU through WebGPU, which on macOS is backed by
Metal. There is no separate Metal integration to add: `importExternalTexture`,
the compute gathers and the resolve passes are already Metal work. The
`--use-angle=metal` flag in the verification scripts only affects how the test
harness draws its own 2D canvas; it has no bearing on the scope pipeline.

## Development

```bash
pnpm test              # unit tests (vitest)
pnpm build             # production bundle
pnpm icons             # regenerate icons from scripts/make-icons.mjs
pnpm verify:manifest   # manifest + CSP + bundle integrity (32 checks)
pnpm verify            # pixel-measured scope checks in real Chrome + WebGPU
pnpm verify:e2e        # injects the built content script on a live <video>
pnpm verify:ui         # panel layout: all four counts, geometry, IRE axis (15 checks)
pnpm verify:scatter    # vectorscope + CIE point clouds and locus curve (12 checks)
pnpm verify:all        # everything above
pnpm bench:upload      # compare zero-copy vs copying upload paths
```

The browser suites drive real Chrome over WebGPU and assert on measured pixels
(for example "a 75% legal bar must read 75 ± 4 IRE", "the 3 button must yield
three sized panels"), not on screenshots. Screenshots land in
`docs/screenshots/`.

Two notes on reading those suites:

- **A blank measurement is not always a blank scope.** A WebGPU canvas only holds
  pixels once it has been presented, and `createImageBitmap` can win that race and
  read transparent black. Every suite polls until a lit pixel appears; a single
  sample after two `rAF`s produced intermittent "the waveform is empty" results
  for a panel that was drawing correctly.
- **A grey ramp cannot test the point-cloud scopes.** Every pixel of a neutral
  ramp has one chromaticity, so a correct CIE plot shows a single dot — visually
  identical to a broken one. `verify:scatter` therefore uses colour bars, and
  `verify:cie-fill` uses a hue x saturation sweep, which is the only fixture that
  can show whether the plot fills in the way real footage makes it.

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

## Publishing

`CHROMEWEBSTORE.md` holds the store listing text, the justification for every
permission, the privacy disclosure answers and the pre-submission checklist.
`docs/privacy-policy.md` is the policy to publish alongside it.

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
├── external-source  importExternalTexture wrapper (zero-copy upload)
├── downscale-external.wgsl  external texture -> fixed analysis texture
├── downscale.wgsl   copied source -> fixed analysis texture (fallback)
├── accumulate.wgsl  compute: pixel -> atomic density bins
└── resolve.wgsl     phosphor transfer + composite to a transparent canvas
```

The GPU density pass and its CPU reference implementation share one index
convention; the reference is the oracle the shader is checked against.
