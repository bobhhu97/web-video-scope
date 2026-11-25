import { VideoDetector } from './video-detector';
import { FrameLoop } from './frame-loop';
import { followFullscreen } from './fullscreen';
import { readVideoColorSpace, applyRangeMode } from './color-space';
import { ScopeController } from './scope-controller';
import { Hud } from '../ui/hud';
import { DEFAULT_STATE, loadSettings, saveSettings, type HudState, type Layout } from '../ui/settings';
import {
  DEFAULT_SCOPE_OPTIONS,
  type ScopeMode,
  type ScopeOptions,
} from '../gpu/scope-renderer';
import { RangeDetector, type ColorSpaceInfo } from '../core/range-detector';
import { histogramStats } from '../core/scopes/stats';
import type { RangeSpec } from '../core/scale/quantize';
import {
  TIER_DESCRIPTION,
  initialGovernorState,
  stepGovernorHard,
  type GovernorState,
  type QualityTier,
} from '../core/perf-governor';
import { GpuTimer } from '../core/gpu-timer';
import { getDevice } from '../gpu/device';
import type { AnalysisPreset } from '../gpu/downscale';
import { Probe, formatSample } from '../ui/probe';
import { openPipWindow, pipSupported, onPipClosed } from '../ui/pip';
import { videoReadability, readabilityNotice, type Readability } from './readability';

const HOST_ID = 'video-scopes-host';

/**
 * Last-resort visibility. If anything below throws, this leaves a note in the
 * page so a failure is visible instead of silent. Only shown when something
 * goes wrong — a healthy run never creates it.
 */
function showDiagnostic(kind: 'injected' | 'error', detail: string): void {
  const id = 'video-scopes-diag';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText =
      'all:initial;position:fixed;top:8px;left:8px;z-index:2147483647;' +
      'font:12px/1.5 ui-monospace,monospace;padding:6px 10px;border-radius:6px;' +
      'max-width:420px;white-space:pre-wrap;' +
      (kind === 'error'
        ? 'background:#3a1414;color:#ffb4b4;border:1px solid #ff6b6b'
        : 'background:#16291d;color:#8cd9a5;border:1px solid #3d6b4a');
    el.textContent = `Video Scopes [${kind}] ${detail}`;
    document.documentElement.appendChild(el);
    setTimeout(() => el?.remove(), 12000);
  }
}

let enabled = false;
let detector: VideoDetector | null = null;
let loop: FrameLoop | null = null;
let hud: Hud | null = null;
let controller: ScopeController | null = null;
let state: HudState = { ...DEFAULT_STATE };
let unfollowFullscreen: (() => void) | null = null;
let probe: Probe | null = null;
let probedVideo: HTMLVideoElement | null = null;
let readability: Readability = { kind: 'unknown' };

let colorInfo: ColorSpaceInfo = {
  fullRange: null,
  matrix: null,
  primaries: null,
  transfer: 'unknown',
  format: null,
  source: 'unknown',
};
let effectiveRange: RangeSpec = { limited: true, depth: 8 };
const rangeDetector = new RangeDetector(3);

let governor: GovernorState = initialGovernorState();
const timer = new GpuTimer();
let frameCount = 0;
let lastPerfAt = performance.now();
let lastColorProbeAt = 0;
/**
 * `new VideoFrame(video)` is not free — it takes a reference on the decoder's
 * current frame and synchronises with the media pipeline. Probing it every
 * frame measurably hurt throughput, so colour metadata is re-read at most 4
 * times per second, which is far faster than a source can switch in practice.
 */
const COLOR_PROBE_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// options + state plumbing
// ---------------------------------------------------------------------------

function currentTier(): QualityTier {
  return (state.lockedTier ?? governor.tier) as QualityTier;
}

function optionsForMode(mode: ScopeMode): ScopeOptions {
  return {
    ...DEFAULT_SCOPE_OPTIONS,
    mode,
    gain: state.gain,
    gamma: state.gamma,
    zoom: state.zoom,
    units: state.units,
    range: effectiveRange,
    matrix: colorInfo.matrix ?? 'bt709',
    primaries: colorInfo.primaries ?? 'rec709',
    coord: state.coord,
    signalKind: state.signalMode,
  };
}

function analysisPreset(): AnalysisPreset {
  return TIER_DESCRIPTION[currentTier()].preset;
}

function applyTier(tier: QualityTier): void {
  const d = TIER_DESCRIPTION[tier];
  loop?.setTargetFps(d.fps);
  controller?.setMinInterval(1000 / d.fps);
  if (state.layout !== d.layout && state.lockedTier === null) {
    state = { ...state, layout: d.layout };
    hud?.relayout(d.layout);
    hud?.setState(state);
    controller?.setTargets(hud?.panelCanvases() ?? []);
  }
  void saveSettings(state);
}

function refreshHud(): void {
  hud?.setState(state);
  hud?.setColorInfo(colorInfo);
  controller?.setOptionsFor(optionsForMode);
}

// ---------------------------------------------------------------------------
// frame pipeline
// ---------------------------------------------------------------------------

function onDiagnosis(hist: Uint32Array, total: number): void {
  const diagnosis = rangeDetector.push(colorInfo, histogramStats(hist, total));
  hud?.setDiagnosis(diagnosis);
  const next = applyRangeMode(state.rangeMode, colorInfo, diagnosis);
  const changed = next.limited !== effectiveRange.limited || next.depth !== effectiveRange.depth;
  effectiveRange = next;
  if (changed) controller?.setOptionsFor(optionsForMode);
}

async function onFrameSubmitted(): Promise<void> {
  const device = await getDevice().catch(() => null);
  if (!device) return;
  const ms = await timer.sample(device);

  if (state.lockedTier === null) {
    const next = stepGovernorHard(governor, ms);
    if (next.tier !== governor.tier) {
      governor = next;
      applyTier(governor.tier);
    } else {
      governor = next;
    }
  }

  frameCount += 1;
  const now = performance.now();
  if (now - lastPerfAt > 500) {
    const fps = (frameCount * 1000) / (now - lastPerfAt);
    hud?.setPerf(fps, timer.lastMs, currentTier(), controller?.uploadPath);
    const dims = controller?.analysisDims;
    if (dims) hud?.setNotice(null);
    frameCount = 0;
    lastPerfAt = now;
  }
}

function onFrame(): void {
  const video = detector?.video;
  if (!video || !controller) return;

  const now = performance.now();
  if (now - lastColorProbeAt >= COLOR_PROBE_INTERVAL_MS) {
    lastColorProbeAt = now;
    const info = readVideoColorSpace(video);
    if (
      info.source !== colorInfo.source ||
      info.matrix !== colorInfo.matrix ||
      info.fullRange !== colorInfo.fullRange ||
      info.format !== colorInfo.format ||
      info.primaries !== colorInfo.primaries ||
      info.transfer !== colorInfo.transfer
    ) {
      colorInfo = info;
      hud?.setColorInfo(colorInfo);
      controller.setOptionsFor(optionsForMode);
    }
  }

  controller.resize();
  void controller.frame(video).catch(() => {
    /* a failed frame must not kill the loop */
  });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function buildController(): void {
  controller?.destroy();
  controller = new ScopeController(
    hud?.panelCanvases() ?? [],
    optionsForMode,
    { onDiagnosis, onFrameSubmitted },
    () => state.gamuts,
    analysisPreset,
  );
  controller.setMinInterval(1000 / TIER_DESCRIPTION[currentTier()].fps);
  controller.setSignalMode(state.signalMode);
  controller.onRawError = (msg) => hud?.setNotice(`Raw mode unavailable: ${msg}`);
}

async function enable(): Promise<void> {
  if (enabled) return;
  enabled = true;

  // Mount FIRST, with whatever state we already have. Everything below this
  // point can fail — storage, GPU init, video detection — and the panel will
  // still be on screen showing what went wrong. Putting any `await` before the
  // mount meant a storage hiccup produced no panel at all, which reads as a
  // completely broken extension.
  state = { ...state, visible: true };
  hud = buildHud();
  hud.mount();
  stampTitle('hud-mounted');

  // Now the optional work. Failures here degrade the scopes, not the panel.
  try {
    state = { ...(await loadSettings()), visible: true, layout: state.layout };
    hud.setState(state);
  } catch {
    // Keep the defaults already in use.
  }
  void saveSettings(state);

  finishEnable();
}

/** Handlers for a freshly created HUD. Split out so mount can precede I/O. */
function buildHud(): Hud {
  return new Hud(state, {
    onStateChange(patch) {
      const modeChanged = patch.signalMode !== undefined && patch.signalMode !== state.signalMode;
      state = { ...state, ...patch };
      void saveSettings(state);
      if (modeChanged) controller?.setSignalMode(state.signalMode);
      refreshHud();
    },
    onLayoutChange(layout: Layout) {
      state = { ...state, layout };
      void saveSettings(state);
      hud?.relayout(layout);
      hud?.setState(state);
      controller?.setTargets(hud?.panelCanvases() ?? []);
      controller?.setOptionsFor(optionsForMode);
    },
    onClose() {
      void disable();
    },
    onOpenPip() {
      const host = document.getElementById(HOST_ID);
      if (!host) return;
      if (!pipSupported()) {
        hud?.setNotice('Picture-in-Picture needs Chrome 116+.');
        return;
      }
      void (async () => {
        try {
          const win = await openPipWindow(host);
          // While detached, fullscreen tracking would yank the host back.
          unfollowFullscreen?.();
          unfollowFullscreen = null;
          onPipClosed(win, host, document.documentElement);
        } catch (e) {
          hud?.setNotice(`PiP failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
    onToggleLock() {
      const locked = state.lockedTier === null;
      state = { ...state, lockedTier: locked ? currentTier() : null };
      void saveSettings(state);
      hud?.setState(state);
      hud?.setPerf(0, timer.lastMs, currentTier());
    },
  });
}

/**
 * Everything that can fail without taking the panel down with it.
 * Called right after the HUD is mounted, so any throw still leaves a visible
 * panel that can explain itself.
 */
function finishEnable(): void {
  try {
    unfollowFullscreen = followFullscreen(hud!.hostElement!);

    buildController();
    stampTitle('controller-ready');

    probe = new Probe(
    (sample) => hud?.setProbe(formatSample(sample, state.units, effectiveRange)),
    () => ({ matrix: colorInfo.matrix ?? 'bt709', range: effectiveRange }),
  );

  detector = new VideoDetector((video) => {
    loop?.stop();
    loop = null;
    if (probedVideo && probe) probe.disable(probedVideo);
    probedVideo = video;
    if (!video) {
      readability = { kind: 'unknown' };
      hud?.setNotice('No video found on this page.');
      stampTitle('no-video');
      return;
    }
    stampTitle('video-found');
    // Tell the user *why* a scope would be empty, instead of showing a blank
    // panel that looks broken.
    readability = videoReadability(video);
    hud?.setNotice(readabilityNotice(readability, true));
    if (readability.kind === 'readable') probe?.enable(video);
    loop = new FrameLoop(video, onFrame);
    loop.setTargetFps(TIER_DESCRIPTION[currentTier()].fps);
    loop.start();
  });
  detector.start();
    stampTitle(detector.video ? 'detector-video' : 'detector-novideo');
    if (!detector.video) hud?.setNotice('No video found on this page.');
  } catch (e) {
    // The panel is already on screen, so report here instead of throwing.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    hud?.setNotice(`Scopes failed to start: ${msg}`);
    stampTitle('scopes-failed');
    console.error('[video-scopes] finishEnable failed:', msg);
  }
}

async function disable(): Promise<void> {
  if (!enabled) return;
  enabled = false;
  loop?.stop();
  loop = null;
  detector?.stop();
  detector = null;
  controller?.destroy();
  controller = null;
  unfollowFullscreen?.();
  unfollowFullscreen = null;
  if (probedVideo && probe) probe.disable(probedVideo);
  probe = null;
  probedVideo = null;
  hud?.unmount();
  hud = null;
  stampTitle('closed');
  rangeDetector.reset();
  governor = initialGovernorState();

  state = { ...state, visible: false };
  await saveSettings(state);
}

function toggle(): void {
  void (enabled ? disable() : enable());
}

/**
 * Reflect state in document.title so the extension's health can be read without
 * a screenshot. Only writes while the HUD exists, and restores on unmount.
 */
function stampTitle(status: string): void {
  const marker = ' [VS:';
  const base = document.title.replace(/ \[VS:[^\]]*\]$/, '');
  document.title = `${base}${marker}${status}]`;
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'toggle-scopes') toggle();
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault();
    toggle();
  }
});

// Restore the previous session automatically.
void (async () => {
  // Read settings defensively. A storage failure must not prevent the panel
  // from appearing — that would make an infrastructure hiccup look exactly like
  // a broken extension, which is precisely the failure mode this file has been
  // rewritten to avoid.
  let saved = { ...DEFAULT_STATE };
  try {
    saved = await loadSettings();
  } catch (e) {
    console.warn('[video-scopes] settings unavailable, using defaults:', e);
  }

  // Automatic opening rule: a fresh install (or the first page of a browser
  // session) opens once so the panel is discoverable; afterwards the persisted
  // flag wins, so a deliberate close survives a reload.
  let firstRun = false;
  try {
    const KEY = 'firstRunSeen';
    const got = await chrome.storage.session.get(KEY);
    firstRun = !got[KEY];
    if (firstRun) await chrome.storage.session.set({ [KEY]: true });
  } catch {
    // storage.session may be unavailable; treat it as a first run so the user
    // sees something rather than nothing.
    firstRun = true;
  }

  if (firstRun || saved.visible) {
    try {
      await enable();
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      stampTitle('enable-failed');
      // enable() mounts the panel first, so this only fires for failures in the
      // mount itself — report visibly in that case.
      showDiagnostic('error', msg);
      console.error('[video-scopes] enable failed:', msg);
    }
  } else {
    stampTitle('closed');
  }
})();

// Keep the panel reachable when the page tears down the DOM it lived in.
document.addEventListener('fullscreenchange', () => {
  if (!hud?.mounted) return;
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  const fs = document.fullscreenElement;
  if (fs && host.parentElement !== fs) fs.appendChild(host);
});
