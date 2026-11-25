# Privacy Policy — Video Scopes

**Last updated: 2026-11-25**

Video Scopes is a browser extension that displays technical measurements of video
playing in your browser.

## The short version

Everything the extension does happens on your own computer. It does not collect
information about you, does not send anything to a server, and does not record
what you watch.

## What the extension does with video

To draw a measurement, the extension needs to look at the pixels of the video you
have chosen to analyse. It reads those pixels in your computer's graphics memory,
converts them into a graph, and displays the graph. The pixels are discarded
immediately afterwards. No frame is ever saved to disk, transmitted, or retained
after it is drawn.

## What is stored

The extension stores your display preferences — which scale you picked, which
layout, and the quality level — using the browser's local extension storage. This
data stays on your device, is not synced to any account, and is removed when you
uninstall the extension.

## What is not collected

The extension does not collect or transmit:

- personally identifying information
- browsing history or the addresses of pages you visit
- the content of pages you view
- video frames, audio, or screenshots
- analytics, telemetry, or crash reports
- location data
- any information about your device

## Network access

The extension makes no network requests. All code is bundled inside the
extension package; nothing is downloaded or executed remotely.

## Third parties

No data is shared with anyone, because no data leaves your device. There are no
analytics providers, advertising networks, or external services involved.

## Permissions

Each permission exists to deliver the measurement panel and nothing else:

- **activeTab** — lets the panel open on the page you are viewing, only after you
  click the toolbar button.
- **scripting** — lets the panel appear on pages that were already open before you
  installed the extension.
- **storage** — remembers your display preferences locally.
- **tabCapture** — reads video that another website has blocked from direct
  access. Used only when you explicitly ask to analyse such a video.

## Children's privacy

The extension collects no information from anyone, including children.

## Changes

If this policy changes, the updated version will be published at this address
with a new date.

## Contact

Open an issue on the project repository with any question about this policy.
