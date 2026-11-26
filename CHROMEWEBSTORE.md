# Chrome Web Store — Web Video Scope

Single source of truth for the store listing, permission justifications, privacy
disclosure and publishing readiness. Copy-paste from here into the Chrome
Developer Dashboard.

- **Last Updated:** 2026-11-25
- **Current version:** 0.1.0
- **Status:** not submitted

---

## Listing

**Name** (≤ 75 chars)

```
Web Video Scope — Waveform, Vectorscope & CIE
```

**Short description** (≤ 132 chars)

```
See exposure, black level, colour balance and video range on any video you watch. Waveform, vectorscope and CIE diagram.
```

**Category:** Developer Tools
**Language:** English

### Detailed description

```
Web Video Scope overlays broadcast-style measurement tools on any video playing in your browser, so you can see what the picture is actually doing rather than guessing from the display.

WHAT YOU SEE
• Waveform monitor — luma on its own, the three colour channels overlaid, or side-by-side as an RGB parade. This shows exposure per column of the picture and exposes colour casts.
• Vectorscope — hue and saturation plotted on a circular scale, with the standard colour-bar targets and the skin-tone line drawn in.
• CIE chromaticity diagram — where the image's colours sit inside the range of colours a display can show, with common colour-space boundaries overlaid. Switch between the 1931 and 1976 versions.

SCALES THAT SUIT YOUR WORKFLOW
Switch the vertical scale between IRE, 8-bit code values, 10-bit code values, millivolts and HDR nits. The trace does not move when you change scale — only the labels change.

KNOWS ABOUT VIDEO RANGE
Limited-range and full-range video are drawn differently, so legal black sits at 6.3% of the scale instead of being stretched to the bottom. The extension reads the range and colour information the video already carries, tells you what it found, and warns you when a file's labelling disagrees with its actual content.

STAYS OUT OF THE WAY
The panel is a floating window you can drag, resize, and open in its own always-on-top window for a second monitor. It keeps working in fullscreen. It analyses only what is on screen, keeps up with playback, and reduces its own workload automatically if your machine is struggling, so your video keeps playing smoothly.

PRIVATE BY DESIGN
Everything happens on your own computer. Nothing is recorded, stored off your device, or sent anywhere.
```

---

## Permissions justification

Every permission needs a specific, plain-English reason. Vague wording such as
"needed for the extension to work" is rejected.

| Permission | Justification (paste into dashboard) |
| --- | --- |
| `activeTab` | Grants temporary access to the current tab only when you click the toolbar button, so the measurement panel can be opened on the page you are looking at. Access ends when you navigate away. |
| `scripting` | Displays the measurement panel on pages that were already open before the extension was installed, by adding the panel script to that one tab after you click the button. |
| `storage` | Remembers your panel settings — chosen scale, layout, and quality level — so the panel reappears the way you left it. Stored locally on your computer only. |
| `tabCapture` | Reads video that is served from another website and blocks direct access to its pixels. Used only when you explicitly request analysis of such a video; it captures the tab you choose and nothing else. |

**Host permissions:** none requested. The extension declares neither
`host_permissions` nor automatic `content_scripts`; `content.js` is injected
into the active tab via `chrome.scripting.executeScript` only when you click
the toolbar button or press `Alt+S`.

**Remote code:** none. All scripts ship inside the extension package.

### Why no `<all_urls>` host permission or background content script

Video can appear anywhere, so instead of injecting a content script into every
webpage you open, the extension uses `activeTab` + `scripting` to inject its
measurement script on demand into the single tab you explicitly activate.

---

## Privacy & data use

**Single purpose:** measure and display the technical characteristics of video
playing in the browser.

| Question | Answer |
| --- | --- |
| Does it collect personally identifiable information? | No |
| Does it collect health information? | No |
| Does it collect financial information? | No |
| Does it collect authentication information? | No |
| Does it collect personal communications? | No |
| Does it collect location? | No |
| Does it collect web history? | No |
| Does it collect user activity? | No |
| Does it collect website content? | No — video frames are measured in memory and discarded immediately; nothing is retained. |
| Is data sold to third parties? | No |
| Is data used for purposes unrelated to the single purpose? | No |
| Is data used to determine creditworthiness? | No |

**Data handling summary:** all analysis runs locally in the browser. No network
requests are made by the extension. Settings are stored with
`chrome.storage.local` on your device. Video frames are processed in GPU memory
and never written to disk.

**Privacy policy URL:** required. See `docs/privacy-policy.md` (deploy it and
paste the public URL here).

**Certification:** the extension does not use remote code and does not transfer
data off-device, so both disclosure checkboxes can be checked as compliant.

---

## Assets

| Asset | Status |
| --- | --- |
| Store icon 128×128 | ✅ `public/icons/icon-128.png` |
| Extension icons 16/32/48/128 | ✅ generated by `scripts/make-icons.mjs` |
| Screenshots (1280×800 or 640×400, 1–5) | ⬜ to capture |
| Small promo tile 440×280 | optional |
| Marquee 1400×560 | optional |

### Suggested screenshots

1. Waveform panel open over a playing video, IRE scale visible.
2. Four-panel 2×2 layout showing waveform, parade, vectorscope and CIE together.
3. Vectorscope with colour-bar targets and the skin-tone line.
4. CIE diagram with Rec.709 and P3 boundaries.
5. Panel in its own always-on-top window beside the video.

Capture these from `public/test-harness.html`, which renders a known test pattern
and therefore shows clean, explainable traces. The verification suite already
writes scope images to `docs/screenshots/`.

---

## Version history

| Version | Date | Summary |
| --- | --- | --- |
| 0.1.0 | 2026-11-25 | First complete build. Waveform (luma / RGB / parade), vectorscope, CIE 1931 and 1976 diagrams. Range detection from decoder metadata with mismatch warnings. Five quality tiers with automatic down-adjustment. Zero-copy video upload. Pixel probe, picture-in-picture, fullscreen support. |

---

## Pre-submission checklist

Verified automatically by `node scripts/verify-manifest.mjs` (36 checks):

- [x] `manifest_version: 3`, no V2 APIs
- [x] Every referenced icon file exists at the correct size
- [x] `action` key present (required by `chrome.action.*`)
- [x] No `eval`, no `new Function`, no remote script or import URLs
- [x] No inline `<script>` bodies or `on*=` handlers in packaged HTML
- [x] Every declared permission is actually used in the bundle
- [x] No host permissions requested
- [x] Content script not declared `all_frames`
- [x] Bundle under 1 MB (currently ~108 KB)

Needs a human:

- [ ] Capture 1–5 screenshots at 1280×800 or 640×400
- [ ] Publish the privacy policy and paste its URL above
- [ ] Load the unpacked build and confirm the panel appears on a real video site
- [ ] Zip `dist/` **excluding** `.git/`, `node_modules/`, `.env`, `CHROMEWEBSTORE.md`
- [ ] Confirm the listing has no implementation jargon (no "WebGPU", "service
      worker", "MutationObserver")

---

## Known limitations to state honestly in support replies

1. Display-referred by default. Pixels come from the browser's colour-managed
   output, which is exact for standard dynamic range content. High dynamic range
   or non-standard colour content needs the raw-plane mode.
2. The nits scale assumes a PQ signal. On standard dynamic range content it is a
   set of reference ticks, not an absolute light measurement.
3. DRM-protected video cannot be analysed; no pixels are exposed to the page.
   The extension says so instead of showing an empty panel.
4. Video from another site that blocks cross-origin reads needs the tab-capture
   path, which is requested explicitly.
