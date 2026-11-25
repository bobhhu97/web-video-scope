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
    hud?.setPerf(fps, timer.lastMs, currentTier());
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
  state = await loadSettings();
  state = { ...state, visible: true };
  // Persist the open state immediately: the panel must come back after a
  // reload, and a crash mid-session must not lose the user's choice.
  await saveSettings(state);

  hud = new Hud(state, {
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
      openPipWindow(host)
        .then((win) => {
          // Stop following fullscreen while detached, then resume on close.
          unfollowFullscreen?.();
          unfollowFullscreen = null;
          onPipClosed(win, host, document.documentElement);
        })
        .catch((e: Error) => hud?.setNotice(`PiP failed: ${e.message}`));
    },
    onToggleLock() {
      const locked = state.lockedTier === null;
      state = { ...state, lockedTier: locked ? currentTier() : null };
      void saveSettings(state);
      hud?.setState(state);
      hud?.setPerf(0, timer.lastMs, currentTier());
    },
  });
  hud.mount();
  unfollowFullscreen = followFullscreen(hud.hostElement!);

  buildController();

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
      return;
    }
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

  if (!detector.video) hud.setNotice('No video found on this page.');
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
  rangeDetector.reset();
  governor = initialGovernorState();

  state = { ...state, visible: false };
  await saveSettings(state);
}

function toggle(): void {
  void (enabled ? disable() : enable());
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
  const saved = await loadSettings();
  if (saved.visible) void enable();
})();

// Keep the panel reachable when the page tears down the DOM it lived in.
document.addEventListener('fullscreenchange', () => {
  if (!hud?.mounted) return;
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  const fs = document.fullscreenElement;
  if (fs && host.parentElement !== fs) fs.appendChild(host);
});
