# Security Policy

## Supported versions

This project is pre-1.0. Security fixes are applied to the latest released
version only.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

Web Video Scope processes video frames locally in the browser. Issues that could
expose frame content, break the extension's isolation, or allow code injection
are taken seriously.

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting: go to the repository's **Security**
tab and click **Report a vulnerability**. Include:

- a description of the problem and its impact,
- steps to reproduce (a page, video, or extension state that triggers it),
- browser and OS versions,
- any suggested fix, if you have one.

You should receive an acknowledgement within a few days. We will keep the report
confidential, work on a fix, and credit you in the release notes unless you
prefer to remain anonymous.

## Scope

The extension makes **no network requests** and sends **no telemetry**; frames
stay in GPU memory. Reports about upstream browser behaviour (Chrome WebGPU,
extension APIs) are best filed with Chromium, but let us know if a workaround is
needed here.
