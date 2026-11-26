# Contributing

Thanks for wanting to improve Web Video Scope. This project analyses the video in a browser tab on the GPU and draws broadcast-style scopes — contributions range from shader work and colour maths to UI polish, docs and tests. Everyone is welcome.

## Ways to help

- **Report a bug** — open an issue with a repro (a page/video that shows it, browser + OS, steps, expected vs actual). If it is a rendering problem, a screenshot of the scope and of the source video helps enormously.
- **Suggest a feature** — open an issue describing the problem you want solved, not only the solution. Scope additions should say what reference they check against (a standard, another scope, a known fixture).
- **Improve docs** — the READMEs, the in-panel help and the demo page all need clear eyes.
- **Send code** — see below.

Good first contributions: issues labelled `good first issue` and `help wanted`.

## Ground rules

- Everything runs locally in the browser. **No network calls, no telemetry, no frames written to disk.** A PR that sends pixels anywhere will not be merged.
- The extension ships **zero runtime dependencies**. Build/test tools are dev-only; adding a runtime dependency needs a clear justification.
- Correctness is measured, not eyeballed. New scope behaviour should come with a test that asserts on measured pixels or a CPU-reference kernel, not just a screenshot.

## Development setup

Requires Node >= 20 and pnpm.

```bash
pnpm install
pnpm dev               # watch build into dist/
pnpm build             # tsc --noEmit + vite build + assert-fresh-build
pnpm test              # vitest, unit + CPU-reference tests
pnpm verify:manifest   # manifest / CSP / bundle integrity — 31 checks
pnpm verify:all        # build + tests + all browser suites (needs Chrome)
```

`pnpm verify:all` drives real Chrome over WebGPU and asserts on measured pixels. The individual suites are `verify:e2e`, `verify:ui`, `verify:scatter`, `verify:cie`; run the one relevant to your change. See the README "Development" section for details, including why a blank measurement can be a race and why a grey ramp cannot test a point-cloud scope.

## Pull request workflow

1. Fork the repository and create a branch off `master`.
2. Make a focused change — one concern per PR.
3. Run `pnpm build`, `pnpm test`, and the verification suite relevant to your change. Paste the results in the PR.
4. Open a PR against `master` and fill in the template. Link the issue it addresses.
5. Be responsive to review. CI must be green before merge.

By contributing you agree that your contribution is licensed under the project's MIT license.

## Reporting a security issue

Do **not** open a public issue for a security problem. Use GitHub's private vulnerability reporting on the repository (Security tab → Report a vulnerability).

## Code of conduct

Be respectful and constructive. Assume good faith, criticise the change not the person, and keep discussions on topic. Unacceptable behaviour (harassment, personal attacks, discrimination) may result in a warning or ban.
