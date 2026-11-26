# Web Video Scope

> **简体中文** → [README.zh-CN.md](README.zh-CN.md) · English (this file)

**Broadcast-grade video scopes, overlaid on any video on the web.**

A Manifest V3 Chrome extension. Press `Alt+S` and a floating panel overlays a
waveform monitor, RGB parade, vectorscope and CIE chromaticity diagram on
whatever `<video>` element the page is playing — YouTube, Vimeo, a file://
clip, a canvas `captureStream`. It reads the video's real colour metadata and
draws the trace in code-value space, so legal black sits where a hardware
scope would put it.

![Rick Astley's "Never Gonna Give You Up" on YouTube with SmallHD false colour and the four-scope quad layout open](docs/screenshots/readme-hero.png)

```
Download web-video-scope-*.zip from Releases → unzip →
chrome://extensions → Developer mode → Load unpacked → unzipped folder → Alt+S
```

---

## Contents

- [What it measures](#what-it-measures) — the five scopes and how to read them
- [How it reads the signal](#how-it-reads-the-signal) — one code-value axis, range detection, false colour
- [Performance](#performance) — zero-copy upload, fixed analysis size, adaptive governor
- [Install & use](#install)
- [Development & verification](#development)
- [Architecture](#architecture)
- [Known limitations & privacy](#known-limitations)
- [Open source, credits & licence](#open-source-credits--licence)
- [Prior art](#prior-art)

---

## What it measures

| Scope | What it tells you |
| --- | --- |
| **Waveform** | Exposure and black level per column of the picture. `Y` for luma alone, `RGB` overlaid to expose a colour cast, `YRGB` / `YUV`, or colourised by luminance. |
| **Parade** | The same signal split into R, G, B (or Y, U, V) side by side, so channels can be compared directly. |
| **Vectorscope** | Hue and saturation. 75% and 100% bar targets computed from the active matrix, plus the 123° skin-tone line. |
| **CIE 1931 / 1976** | Where the picture's colours sit inside the visible gamut, with Rec.709 / P3 / Rec.2020 triangles overlaid. |
| **Histogram** | Where the pixels pile up across the range, per channel or combined. |

Each panel has its own picker, zoom and settings; drag panels to swap slots, or
switch between 1-up / 2-up / 3-up / four-grid layouts from the toolbar.

All five scopes, side by side, reading real test footage — waveform on a
continuous-tone scene, parade on 75% colour bars, vectorscope and CIE on a
hue × saturation sweep, and a YRGB histogram:

![Waveform, parade, vectorscope, CIE diagram and histogram shown side by side](docs/screenshots/readme-scopes-all.png)

## How it reads the signal

### Five scales, one axis

`IRE`, `8-bit`, `10-bit`, `mV` and `nits` are five sets of labels on **one
underlying code-value axis**, so changing the scale never moves the trace — only
the numbers beside it. That is asserted by unit tests rather than assumed.

The 10-bit view below is the useful demonstration. A limited-range signal is
drawn where it actually lives: legal black at code 64, legal white at 940, with
the sub-black and super-white headroom still visible on either side. Nothing is
stretched to fill the box.

![Waveform on a 10-bit code-value scale, with legal black at 64 and legal white at 940 marked](docs/screenshots/readme-ten-bit.png)

### It reads the range instead of guessing it

`new VideoFrame(video).colorSpace` exposes `fullRange`, `matrix`, `primaries`
and `transfer` for the decoded frame. The status badge reports what was found:

```
axis:limited    BT709    src:limited · bt709 · NV12
```

If the metadata disagrees with the content — a limited-range signal labelled
full, or the reverse — a percentile heuristic over the frame's luma raises a
warning after 3 consecutive frames. The `range` selector overrides the verdict
by hand.

### False colour on the picture itself

ARRI, SmallHD and spectrum ramps, drawn as an overlay on the video rather than
in a separate scope, so exposure problems show up where you are actually
looking. The strip below wipes the **same frame** (Rick Astley at 36 s from the
video above) through all three presets, so the only thing changing is the
false-colour mapping:

![One Rick Astley frame shown three ways as a wipe: ARRI, SmallHD and spectrum false colour](docs/screenshots/readme-false-color-wipe.png)

---

## Performance

Smoothness is the first constraint; precision is a dial.

**Zero-copy upload.** Frames reach the GPU through `importExternalTexture`,
which hands over a handle to the decoder's own surface instead of copying
pixels. Measured at 1280×720 with `pnpm bench:upload` on this machine (Apple
GPU, Metal backend):

| Upload path | Median | p90 | Bytes moved per frame |
| --- | --- | --- | --- |
| `copyExternalImageToTexture` | 0.90 ms | 1.90 ms | 3.6 MB |
| `importExternalTexture` | **0.10 ms** | **0.20 ms** | **0** |

Roughly 9–10× less time in the upload step, and nothing copied. The copy path
stays as the fallback for cross-origin video, where import throws a
`SecurityError`.

**Fixed analysis resolution.** Each frame is downscaled once to a 640-pixel long
edge (640×360 for 16:9) and that single texture feeds every scope. Cost is
therefore independent of source resolution — the 4K version of a frame costs the
same as the 720p one.

**Frame-driven, not timer-driven.** `requestVideoFrameCallback` means the scopes
advance when the video does, and cost nothing while paused.

**Adaptive governor.** GPU time is measured per frame against a 4 ms budget.
Sustained overshoot walks down five tiers (60 fps / high → 15 fps / low); a
catastrophic frame skips two. Recovery needs a run of stable frames so the
display does not oscillate. The tier never changes *which* scopes you chose —
only their frame rate and analysis resolution. Click the badge to pin a tier.

In the captures above the panel reports **30 fps at ~3–6 ms** with all four
scopes open on a 1080p source, zero-copy upload confirmed.

All of it runs on WebGPU, which on macOS is Metal. There is no separate Metal
integration to add: the import, the compute gathers and the resolve passes are
already Metal work.

## Install

### Easiest: download a pre-built release

Grab the latest `web-video-scope-<version>.zip` from the
[Releases page](https://github.com/bobhhu97/web-video-scope/releases), unzip it,
then in Chrome:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the unzipped folder (the one containing `manifest.json`)
3. Open any page with a video and press **Alt+S**

No `pnpm`, Node, or build step needed — the ZIP is the complete extension.
It is not on the Chrome Web Store, so Chrome will show a developer-mode
extension warning; that is expected for an unpacked load.

### Build from source

```bash
pnpm install
pnpm build          # writes dist/
pnpm package        # writes release/web-video-scope-<version>.zip
```

Then load `dist/` in Chrome exactly as in steps 1–3 above.

Drag the header to move the panel, drag the bottom-right corner to resize, or
use `⧉` to detach it into an always-on-top window for a second monitor. Layout,
units, range override and quality tier persist across sessions. The panel keeps
working in fullscreen.

> Chrome 137+ removed the `--load-extension` switch, so loading the unpacked
> build is a UI step. `pnpm verify:manifest` checks everything about the package
> that can be verified without installing it.

## Development

```bash
pnpm test              # unit tests (vitest) — 290 tests
pnpm build             # production bundle
pnpm verify:manifest   # manifest, CSP and bundle integrity — 31 checks
pnpm verify:e2e        # injects the built content script on a live <video> — 24 checks
pnpm verify:ui         # panel layout, geometry, IRE axis — 15 checks
pnpm verify:scatter    # vectorscope + CIE point clouds, locus, fill — 12 checks
pnpm verify:cie        # CIE 1:1 axes, grid squareness, zoom, pickers — 12 checks
pnpm bench:upload      # zero-copy vs copying upload
pnpm capture:readme    # regenerate every image in this document
```

The browser suites drive real Chrome over WebGPU and assert on **measured
pixels** — "a 75% legal bar must read 75 ± 4 IRE", "the 3 button must yield three
sized panels" — not on screenshots.

`pnpm capture:readme` runs `scripts/capture-readme.mjs`. It opens
`docs/demo/index.html` (a synthetic watch page that renders known patterns
through `captureStream`), injects the built bundle, and measures every scope
canvas before saving the shot. A blank plot fails the capture instead of
shipping as a pretty picture of nothing.

Two notes on reading those suites, both learned the hard way:

- **A blank measurement is not always a blank scope.** A WebGPU canvas only
  holds pixels once it has been presented, and `createImageBitmap` can win that
  race and read transparent black. Every suite polls until a lit pixel appears.
- **A grey ramp cannot test a point-cloud scope.** Every pixel of a neutral ramp
  has one chromaticity, so a correct CIE plot shows a single dot — visually
  identical to a broken one. The scatter suites use colour bars and a hue ×
  saturation sweep, the only fixtures that fill the plot the way real footage
  does.

## Architecture

```
content script
├── video-detector   pick the main <video>, follow SPA navigation
├── frame-loop       rVFC, with a rAF watchdog for sources that never fire it
├── color-space      VideoFrame.colorSpace -> matrix / primaries / fullRange
├── scope-controller owns every GPU resource; one downscale shared by all scopes
└── ui/hud           shadow DOM panel (DOM + events only, no drawing)

core (pure, unit tested)
├── color            luma/chroma matrices, primaries, transfer functions, CIE locus
├── scale            code-space quantisation and unit ticks
├── range-detector   metadata + percentile heuristics
├── perf-governor    tier decisions
└── scopes/reference CPU kernels that serve as the GPU oracle

gpu
├── external-source          importExternalTexture wrapper (zero-copy upload)
├── downscale-external.wgsl  external texture -> fixed analysis texture
├── downscale.wgsl           copied source -> fixed analysis texture (fallback)
├── accumulate.wgsl          compute: pixel -> atomic density bins
└── resolve.wgsl             phosphor transfer + composite to a transparent canvas
```

The GPU density pass and its CPU reference implementation share one index
convention; the reference is the oracle the shader is checked against.

## Known limitations

1. **Display-referred by default.** Pixels arrive after the browser's colour
   management. For SDR Rec.709 that is exact — the range expansion inverts
   exactly. For PQ/HLG or non-Rec.709 primaries, switch to the raw-plane path.
2. **`nits` assumes PQ.** The axis is read as a PQ signal, exact for HDR. On SDR
   content it is a different set of reference ticks, labelled `PQ assumed`.
3. **Raw-plane mode has no per-channel RGB.** Only Y/U/V are available, so the
   RGB parade mirrors luma and says so.
4. **DRM video cannot be analysed.** EME-encrypted frames expose no pixels to
   the page. The panel says this rather than showing an empty scope.
5. **Cross-origin video without CORS needs `tabCapture`.** Opt-in, and requested
   only when you ask for it.
6. **The governor reduces frame rate under load**, never your layout. Pin a tier
   from the badge to opt out.

## Privacy

Everything runs locally. No network requests, no telemetry, and no frame is ever
written to disk — pixels are read in GPU memory, plotted, and discarded. Settings
live in `chrome.storage.local`. See
[docs/privacy-policy.md](docs/privacy-policy.md).

## Contributing

Contributions are welcome — code, docs, bug reports and test patterns alike. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the pull-request
workflow and the project's ground rules. Please read
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before participating. Security issues
should be reported privately as described in [SECURITY.md](SECURITY.md).

## Open source, credits & licence

### This project's licence

Web Video Scope is released under the **MIT License**. See [LICENSE](LICENSE)
for the full text. Copyright (c) 2026 Web Video Scope contributors.

### Open-source components

No runtime dependencies are shipped — the built extension is self-contained.
The following open-source projects are used at build/test time or as reference
data, and we are grateful to their authors:

| Project | Licence | How it is used |
| --- | --- | --- |
| [TypeScript](https://www.typescriptlang.org/) | Apache-2.0 | Language and compiler |
| [Vite](https://vitejs.dev/) | MIT | Build tooling |
| [Vitest](https://vitest.dev/) | MIT | Unit tests |
| [jsdom](https://github.com/jsdom/jsdom) | MIT | DOM simulation in tests |
| [Puppeteer](https://pptr.dev/) (`puppeteer-core`) | Apache-2.0 | Capturing the README screenshots |
| [`@webgpu/types`](https://github.com/gpuweb/types) | BSD-3-Clause | WebGPU type definitions |
| [`@types/chrome`](https://github.com/DefinitelyTyped/DefinitelyTyped) / [`@types/jsdom`](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT | Chrome / jsdom type definitions |
| [colour-science](https://www.colour-science.org/) | BSD-3-Clause | Generated the CIE standard-observer locus data in `src/core/color/locus-data.ts` (data derived, not code copied) |

Build-tool transitive dependencies resolved in `pnpm-lock.yaml` (esbuild,
rollup, chai, and the Vitest ecosystem) are likewise dev-only and retain their
own licences.

The scope behaviour also follows published standards and conventions — ITU-R
BT.2408 (203-nit SDR reference white), Rec.709 / P3 / Rec.2020, and SMPTE/EBU
colour-bar targets — and takes UX cues from DaVinci Resolve. These are
specifications and design references, not copied code.

The demonstration video frame is from
[youtube.com/watch?v=dQw4w9WgXcQ](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
and remains © its respective rights holders.

## Prior art

Resolve, Premiere and hardware scopes all do this properly. This exists because
none of them can measure what is already playing in a browser tab, and because
browser devtools have nothing to say about a picture's exposure.
