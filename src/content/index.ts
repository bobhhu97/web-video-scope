import { VideoDetector } from './video-detector';
import { FrameLoop } from './frame-loop';
import { followFullscreen, overlayFullscreenParent } from './fullscreen';
import { readVideoColorSpace, applyRangeMode, UNKNOWN_COLOR_SPACE } from './color-space';
import { ScopeController, type HdrFrameStats } from './scope-controller';
import { Hud, type HudHandlers } from '../ui/hud';
import { t } from '../ui/i18n';
import {
  DEFAULT_PROBE_CONFIG,
  DEFAULT_STATE,
  loadSettings,
  resolveCells,
  saveSettings,
  type CellConfig,
  type HudState,
  type Layout,
} from '../ui/settings';
import {
  DEFAULT_SCOPE_OPTIONS,
  type ScopeMode,
  type ScopeOptions,
} from '../gpu/scope-renderer';
import type { FalseColorConfig } from '../ui/false-color-overlay';
import type { PrimariesId } from '../core/color/primaries';
import { resolveDisplayTransferFix } from '../core/color/transfer';
import {
  RangeDetector,
  sanitizeRangeDiagnosis,
  type ColorSpaceInfo,
} from '../core/range-detector';
import { histogramStats } from '../core/scopes/stats';
import type { RangeSpec } from '../core/scale/quantize';
import { resolveEffectiveTransfer, resolveEffectiveUnit } from '../core/scale/units';
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
import { CursorProbeTooltip, Probe, formatSample, type ProbeSample } from '../ui/probe';
import { openFloatingWindow, pipSupported, type FloatingWindow } from '../ui/pip';
import { videoReadability, readabilityNotice, type Readability } from './readability';
import { keepAttached, type Guardian } from './keep-attached';

const HOST_ID = 'video-scopes-host';

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
    el.textContent = `Web Video Scope [${kind}] ${detail}`;
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
let guardian: Guardian | null = null;
let reattachCount = 0;
let floating: FloatingWindow | null = null;
let floatingHud: Hud | null = null;
let probe: Probe | null = null;
let probeTooltip: CursorProbeTooltip | null = null;
let lastProbeSample: ProbeSample | null = null;
let lastProbeClient = { x: 0, y: 0 };
let probedVideo: HTMLVideoElement | null = null;
let readability: Readability = { kind: 'unknown' };
let lastHdrStats: HdrFrameStats | null = null;

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
const COLOR_PROBE_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// options + state plumbing
// ---------------------------------------------------------------------------

function currentTier(): QualityTier {
  return (state.lockedTier ?? governor.tier) as QualityTier;
}

function resolvedMatrix() {
  if (state.matrixMode && state.matrixMode !== 'auto') return state.matrixMode;
  if (colorInfo.matrix) return colorInfo.matrix;
  if (state.primariesMode === 'rec2020' || colorInfo.primaries === 'rec2020') return 'bt2020';
  return 'bt709';
}

function currentSourceTransfer(): 'sdr' | 'pq' | 'hlg' {
  if (colorInfo.transfer === 'pq') return 'pq';
  if (colorInfo.transfer === 'hlg') return 'hlg';
  return 'sdr';
}

function currentEffectiveTransfer(): 'sdr' | 'pq' | 'hlg' {
  return resolveEffectiveTransfer(state.hdrMode ?? 'auto', colorInfo.transfer);
}

function resolvedPrimaries(effectiveTransfer = currentEffectiveTransfer()): PrimariesId {
  if (state.primariesMode && state.primariesMode !== 'auto') return state.primariesMode;
  if (colorInfo.primaries) return colorInfo.primaries;
  return effectiveTransfer !== 'sdr' ? 'rec2020' : 'rec709';
}

function optionsForSlot(slot: number, fallbackMode: ScopeMode): ScopeOptions {
  const cells = resolveCells(state);
  const cell = cells[slot];
  const mode = cell?.mode ?? fallbackMode;
  const matrix = resolvedMatrix();
  const sourceMatrix = colorInfo.matrix ?? matrix;
  const sourceTransfer = currentSourceTransfer();
  const effectiveTransfer = currentEffectiveTransfer();
  const primaries = resolvedPrimaries(effectiveTransfer);

  let gamuts = cell?.gamuts ? [...cell.gamuts] : [...state.gamuts];
  if (primaries === 'rec2020' && !gamuts.includes('rec2020')) {
    gamuts = [...gamuts, 'rec2020'];
  }

  const wc = cell?.waveChannels ?? (mode === 'waveform-rgb' ? 'RGB' : 'Y');
  const chIdx: 0 | 1 | 2 | 3 = wc === 'R' ? 1 : wc === 'G' ? 2 : wc === 'B' ? 3 : 0;

  return {
    ...DEFAULT_SCOPE_OPTIONS,
    mode,
    channel: chIdx,
    waveChannels: wc,
    paradeMode: cell?.paradeMode ?? 'RGB',
    histMode: cell?.histMode ?? 'YRGB',
    traceMode: cell?.traceMode ?? (mode === 'vectorscope' || mode === 'cie' ? 'colorize' : 'channel'),
    lowPass: cell?.lowPass ?? false,
    toneFilter: cell?.toneFilter ?? 'all',
    showSkinLine: cell?.showSkinLine ?? true,
    gain: cell?.gain ?? state.gain,
    gamma: cell?.gamma ?? state.gamma,
    zoom: cell?.zoom ?? 1,
    panX: cell?.panX ?? null,
    panY: cell?.panY ?? null,
    units: resolveEffectiveUnit(cell?.units ?? state.units, effectiveTransfer),
    range: effectiveRange,
    matrix,
    sourceMatrix,
    barTargets: cell?.barTargets ?? state.barTargets ?? 0.75,
    primaries,
    gamuts,
    coord: cell?.coord ?? state.coord,
    signalKind: state.signalMode,
    sourceTransfer,
    effectiveTransfer,
    nitLow: state.nitLow ?? 100,
    nitHigh: state.nitHigh ?? 1000,
    graticuleBrightness: state.graticuleBrightness ?? 1,
  };
}

function falseColorConfig(): FalseColorConfig {
  return {
    enabled: !!state.videoFalseColor,
    preset: state.falseColorPreset ?? 'auto',
    opacity: state.falseColorOpacity ?? 0.88,
    showLegend: state.falseColorLegend !== false,
    lang: state.lang ?? 'en',
    sdrWhiteNits: state.sdrWhiteNits ?? 203,
    nitLow: state.nitLow ?? 100,
    nitHigh: state.nitHigh ?? 1000,
    matrix: resolvedMatrix(),
    range: effectiveRange,
    signalKind: state.signalMode,
    sourceTransfer: currentSourceTransfer(),
    effectiveTransfer: currentEffectiveTransfer(),
    displayTransferFix: resolveDisplayTransferFix(colorInfo.transfer),
  };
}

function analysisPreset(): AnalysisPreset {
  if (state.precision && state.precision !== 'auto') {
    return state.precision;
  }
  return TIER_DESCRIPTION[currentTier()].preset;
}

function applyTier(tier: QualityTier): void {
  const d = TIER_DESCRIPTION[tier];
  const fps = state.precision === 'ultra' || state.precision === 'native' ? Math.max(30, d.fps) : d.fps;
  loop?.setTargetFps(fps);
  controller?.setMinInterval(1000 / fps);
  void saveSettings(state);
}

function computeHdrBadgeInfo(): {
  highPct: number;
  maxNits: number;
  active: boolean;
  nitHigh: number;
} {
  const effTr = currentEffectiveTransfer();
  const cells = resolveCells(state);
  const anyZoneCell = cells.some(
    (c) => c.traceMode === 'hdr-zones' || c.units === 'nits' || c.units === 'hlg',
  );
  const active =
    effTr !== 'sdr' ||
    anyZoneCell ||
    (!!state.videoFalseColor && state.falseColorPreset === 'hdr-nits');
  const highPct =
    lastHdrStats && lastHdrStats.totalPx > 0
      ? (lastHdrStats.highPx / lastHdrStats.totalPx) * 100
      : 0;
  return {
    highPct,
    maxNits: lastHdrStats?.maxNits ?? 0,
    active,
    nitHigh: state.nitHigh ?? 1000,
  };
}

function syncProbeOutputs(sample: ProbeSample | null, clientX: number, clientY: number): void {
  lastProbeSample = sample;
  if (sample) {
    lastProbeClient = { x: clientX, y: clientY };
  }
  const pc = state.probeConfig ?? DEFAULT_PROBE_CONFIG;
  if (!sample) {
    probeTooltip?.hide();
    controller?.drawProbeRings(null);
    activeHud()?.setProbe(null);
    return;
  }

  const effTr = currentEffectiveTransfer();
  probeTooltip?.show(clientX, clientY, sample, pc, effTr, state.lang ?? 'en');
  controller?.drawProbeRings(pc.showScopeRings ? sample : null);

  if (!state.eyedropperEnabled) {
    const effUnit = resolveEffectiveUnit(state.units, effTr);
    activeHud()?.setProbe(formatSample(sample, effUnit, effectiveRange));
  } else {
    activeHud()?.setProbe(null);
  }
}

function refreshHud(): void {
  const diagnosis = sanitizeRangeDiagnosis(
    rangeDetector.current,
    state.signalMode,
    state.rangeMode,
  );
  effectiveRange = applyRangeMode(state.rangeMode, colorInfo, diagnosis);
  const effTr = currentEffectiveTransfer();
  const axisLabel =
    effTr === 'pq'
      ? 'PQ nits'
      : effTr === 'hlg'
        ? 'HLG'
        : effectiveRange.limited
          ? 'limited'
          : 'full';
  activeHud()?.setState(state);
  activeHud()?.setColorInfo(colorInfo);
  activeHud()?.setDiagnosis(
    {
      ...diagnosis,
      effective: effectiveRange.limited ? 'limited' : 'full',
      effectiveAxisLabel: axisLabel,
    },
    computeHdrBadgeInfo(),
  );
  controller?.setOptionsFor(optionsForSlot);
}

function syncVideoColorSpace(video: HTMLVideoElement): void {
  if (video.readyState < 2) return;
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
    refreshHud();
  }
}

function requestRedraw(): void {
  const video = detector?.video;
  if (!video || !controller) return;
  syncVideoColorSpace(video);
  void controller
    .frame(video, true)
    .then(() => syncRuntimeNotice())
    .catch(() => {
      /* ignore transient redraw errors */
    });
}

// ---------------------------------------------------------------------------
// frame pipeline
// ---------------------------------------------------------------------------

function onDiagnosis(hist: Uint32Array, total: number, hdr?: HdrFrameStats): void {
  if (hdr) lastHdrStats = hdr;
  const rawDiagnosis = rangeDetector.push(colorInfo, histogramStats(hist, total));
  const diagnosis = sanitizeRangeDiagnosis(rawDiagnosis, state.signalMode, state.rangeMode);
  const next = applyRangeMode(state.rangeMode, colorInfo, diagnosis);
  const changed = next.limited !== effectiveRange.limited || next.depth !== effectiveRange.depth;
  effectiveRange = next;

  const effTr = currentEffectiveTransfer();
  const axisLabel =
    effTr === 'pq'
      ? 'PQ nits'
      : effTr === 'hlg'
        ? 'HLG'
        : effectiveRange.limited
          ? 'limited'
          : 'full';

  activeHud()?.setDiagnosis(
    {
      ...diagnosis,
      effective: effectiveRange.limited ? 'limited' : 'full',
      effectiveAxisLabel: axisLabel,
    },
    computeHdrBadgeInfo(),
  );

  if (changed) {
    controller?.setOptionsFor(optionsForSlot);
    if (detector?.video?.paused) requestRedraw();
  }
}

function syncRuntimeNotice(): void {
  const h = activeHud();
  if (!h || !detector?.video) return;
  if (readability.kind !== 'readable' && !controller?.analysisDims) {
    h.setNotice(readabilityNotice(readability, true));
    return;
  }
  if (state.videoFalseColor && controller) {
    const fc = controller.falseColorDiagnostics;
    if (fc.status === 'offscreen') {
      h.setNotice(t(state.lang).fcOffscreenHint);
      return;
    }
    if (fc.status === 'gpu-error' && fc.gpuError) {
      h.setNotice(`False Color GPU error: ${fc.gpuError}`);
      return;
    }
  }
  if (controller?.analysisDims) {
    h.setNotice(null);
  }
}

let warmupFrames = 0;

async function onFrameSubmitted(hadReadback = false): Promise<void> {
  if (detector?.video?.paused) {
    syncRuntimeNotice();
    return;
  }
  frameCount += 1;
  const now = performance.now();
  if (now - lastPerfAt > 500) {
    const fps = detector?.video?.paused ? 0 : (frameCount * 1000) / (now - lastPerfAt);
    activeHud()?.setPerf(
      fps,
      timer.lastMs,
      currentTier(),
      controller?.uploadPath,
      controller?.analysisDims,
    );
    syncRuntimeNotice();
    frameCount = 0;
    lastPerfAt = now;
  }

  warmupFrames += 1;
  if (!hadReadback && warmupFrames > 4) {
    const device = await getDevice().catch(() => null);
    if (!device) return;
    const ms = await timer.sample(device);

    if (state.lockedTier === null && state.precision === 'auto') {
      const next = stepGovernorHard(governor, ms);
      if (next.tier !== governor.tier) {
        governor = next;
        applyTier(governor.tier);
      } else {
        governor = next;
      }
    }
  }
}

function onFrame(): void {
  const video = detector?.video;
  if (!video || !controller) return;

  const now = performance.now();
  if (now - lastColorProbeAt >= COLOR_PROBE_INTERVAL_MS) {
    lastColorProbeAt = now;
    syncVideoColorSpace(video);
  }

  controller.resize();
  probe?.refreshAtLastPointer();
  void controller.frame(video).catch(() => {
    /* a failed frame must not kill the loop */
  });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

function buildController(): void {
  controller?.destroy();
  warmupFrames = 0;
  controller = new ScopeController(
    activeHud()?.panelCanvases() ?? [],
    optionsForSlot,
    { onDiagnosis, onFrameSubmitted },
    () => state.gamuts,
    analysisPreset,
    falseColorConfig,
  );
  controller.setMinInterval(1000 / TIER_DESCRIPTION[currentTier()].fps);
  controller.setSignalMode(state.signalMode);
  (window as unknown as { __scopeDebug?: unknown }).__scopeDebug = {
    get range() {
      return effectiveRange.limited ? 'limited' : 'full';
    },
    get effective() {
      return state.rangeMode;
    },
    get dims() {
      return controller?.analysisDims ?? null;
    },
    get transfer() {
      return currentEffectiveTransfer();
    },
    get primaries() {
      return resolvedPrimaries();
    },
    get status() {
      return presentationStatus;
    },
    get reattachCount() {
      return reattachCount;
    },
    get falseColor() {
      return {
        enabled: !!state.videoFalseColor,
        preset: state.falseColorPreset ?? 'auto',
        ...(controller?.falseColorDiagnostics ?? {}),
      };
    },
  };
  controller.onRawError = (msg) => activeHud()?.setNotice(`Raw mode unavailable: ${msg}`);
}

let presentationStatus = 'idle';
let enablePromise: Promise<void> | null = null;

function enable(): Promise<void> {
  if (enablePromise) return enablePromise;
  if (enabled) return Promise.resolve();
  enabled = true;

  enablePromise = (async () => {
    state = { ...state, visible: true };
    hud = buildHud();
    hud.mount();
    presentationStatus = 'in-page';

    try {
      await chrome.storage.session.set({ scopesOn: true });
    } catch {
      // Non-fatal
    }

    try {
      state = { ...(await loadSettings()), visible: true, layout: state.layout };
      hud.setState(state);
    } catch {
      // Keep defaults
    }
    void saveSettings(state);

    finishEnable();
  })().finally(() => {
    enablePromise = null;
  });

  return enablePromise;
}

function buildHandlers(): HudHandlers {
  return {
    onStateChange(patch) {
      const signalChanged = patch.signalMode !== undefined && patch.signalMode !== state.signalMode;
      const modeChanged = patch.mode !== undefined && patch.mode !== state.mode;
      const precisionChanged = patch.precision !== undefined && patch.precision !== state.precision;
      const eyeChanged = patch.eyedropperEnabled !== undefined;
      const probeCfgChanged = patch.probeConfig !== undefined || patch.lang !== undefined;
      const hdrChanged =
        patch.hdrMode !== undefined ||
        patch.nitLow !== undefined ||
        patch.nitHigh !== undefined ||
        patch.matrixMode !== undefined ||
        patch.primariesMode !== undefined;
      state = { ...state, ...patch };
      void saveSettings(state);
      if (signalChanged) {
        rangeDetector.reset();
        controller?.setSignalMode(state.signalMode);
      }
      if (precisionChanged) {
        lastPerfAt = performance.now() - 480;
        frameCount = Math.max(1, Math.round((480 / 1000) * TIER_DESCRIPTION[currentTier()].fps));
        applyTier(currentTier());
      }
      if (hdrChanged) controller?.invalidateStats();
      if (modeChanged) {
        activeHud()?.setSingleMode(state.mode);
        controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      }
      if (eyeChanged) {
        probe?.syncMode();
      } else if (probeCfgChanged && lastProbeSample) {
        syncProbeOutputs(lastProbeSample, lastProbeClient.x, lastProbeClient.y);
      }
      refreshHud();
      requestRedraw();
    },
    onCellChange(layout: Layout, slot: number, patch: Partial<CellConfig>) {
      const cells = resolveCells(state, layout);
      if (!cells[slot]) return;
      const prevMode = cells[slot]!.mode;
      cells[slot] = { ...cells[slot]!, ...patch };
      const nextModes = cells.map((c) => c.mode);
      state = {
        ...state,
        activeSlot: slot,
        cells: { ...state.cells, [layout]: cells },
        panels: { ...state.panels, [layout]: nextModes },
        ...(layout === 'single' && slot === 0 ? { mode: cells[0]!.mode } : {}),
      };
      void saveSettings(state);
      if (cells[slot]!.mode !== prevMode) {
        controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      }
      refreshHud();
      requestRedraw();
    },
    onCellsReplace(layout: Layout, cells: CellConfig[]) {
      const nextModes = cells.map((c) => c.mode);
      state = {
        ...state,
        layout,
        cells: { ...state.cells, [layout]: cells },
        panels: { ...state.panels, [layout]: nextModes },
        ...(layout === 'single' && cells[0] ? { mode: cells[0].mode } : {}),
      };
      void saveSettings(state);
      activeHud()?.relayout(layout);
      controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      refreshHud();
      requestRedraw();
    },
    onPanelsChange(layout, panels) {
      const curCells = resolveCells(state, layout);
      const nextCells = panels.map((m, i) =>
        curCells[i] && curCells[i]!.mode === m ? curCells[i]! : { ...curCells[i]!, mode: m },
      );
      state = {
        ...state,
        layout,
        panels: { ...state.panels, [layout]: panels },
        cells: { ...state.cells, [layout]: nextCells },
      };
      void saveSettings(state);
      activeHud()?.relayout(layout);
      controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      controller?.setOptionsFor(optionsForSlot);
      requestRedraw();
    },
    onLayoutChange(layout: Layout) {
      state = { ...state, layout, activeSlot: 0 };
      void saveSettings(state);
      activeHud()?.relayout(layout);
      controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      controller?.setOptionsFor(optionsForSlot);
      requestRedraw();
    },
    onResetAll() {
      const keepLang = state.lang;
      const keepPos = state.hostPosition;
      state = {
        ...DEFAULT_STATE,
        visible: true,
        lang: keepLang,
        hostPosition: keepPos,
        probeConfig: { ...DEFAULT_PROBE_CONFIG },
      };
      void saveSettings(state);
      probe?.syncMode();
      activeHud()?.relayout(state.layout);
      controller?.setSignalMode(state.signalMode);
      controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      refreshHud();
      requestRedraw();
    },
    onResize() {
      controller?.resize();
      requestRedraw();
    },
    onClose() {
      void disable();
    },
    onOpenPip() {
      void detachToFloatingWindow();
    },
    onToggleLock() {
      const locked = state.lockedTier === null;
      state = { ...state, lockedTier: locked ? currentTier() : null };
      void saveSettings(state);
      activeHud()?.setState(state);
      activeHud()?.setPerf(
        0,
        timer.lastMs,
        currentTier(),
        controller?.uploadPath,
        controller?.analysisDims,
      );
    },
  };
}

function buildHud(): Hud {
  return new Hud(state, buildHandlers());
}

function activeHud(): Hud | null {
  return floatingHud ?? hud;
}

function finishEnable(): void {
  const mounted = activeHud()?.hostElement;
  if (!mounted) {
    presentationStatus = 'finish-skipped';
    return;
  }

  try {
    unfollowFullscreen = followFullscreen(mounted, () => {
      controller?.resize();
      requestRedraw();
    });

    guardian = keepAttached(
      mounted,
      overlayFullscreenParent,
      (n) => {
        reattachCount = n;
      },
    );

    buildController();

    probeTooltip = new CursorProbeTooltip();
    probe = new Probe(
      (sample, clientX, clientY) => {
        syncProbeOutputs(sample, clientX, clientY);
      },
      () => ({
        eyedropperEnabled: !!state.eyedropperEnabled,
        matrix: resolvedMatrix(),
        primaries: resolvedPrimaries(),
        range: effectiveRange,
        effectiveTransfer: currentEffectiveTransfer(),
        sourceTransfer: currentSourceTransfer(),
        sdrWhiteNits: state.sdrWhiteNits ?? 203,
        hudHostId: HOST_ID,
      }),
    );

    detector = new VideoDetector((video) => {
      loop?.stop();
      loop = null;
      if (probedVideo && probe) probe.disable(probedVideo);
      probedVideo = video;
      if (!video) {
        readability = { kind: 'unknown' };
        activeHud()?.setNotice('No video found on this page.');
        return;
      }
      readability = videoReadability(video);
      activeHud()?.setNotice(readabilityNotice(readability, true));
      if (readability.kind === 'readable') probe?.enable(video);
      if (video.readyState >= 2) {
        syncVideoColorSpace(video);
      } else {
        video.addEventListener('loadeddata', () => syncVideoColorSpace(video), { once: true });
      }
      video.addEventListener('pause', () => {
        frameCount = 0;
        activeHud()?.setPerf(
          0,
          timer.lastMs,
          currentTier(),
          controller?.uploadPath,
          controller?.analysisDims,
        );
      });
      loop = new FrameLoop(video, onFrame);
      loop.setTargetFps(TIER_DESCRIPTION[currentTier()].fps);
      loop.start();
    });
    detector.start();
    if (!detector.video) activeHud()?.setNotice('No video found on this page.');
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    activeHud()?.setNotice(`Scopes failed to start: ${msg}`);
    presentationStatus = 'scopes-failed';
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
  floating?.close();
  floating = null;
  guardian?.stop();
  guardian = null;
  unfollowFullscreen?.();
  unfollowFullscreen = null;
  if (probedVideo && probe) probe.disable(probedVideo);
  probe = null;
  probeTooltip?.destroy();
  probeTooltip = null;
  lastProbeSample = null;
  probedVideo = null;
  activeHud()?.unmount();
  hud = null;
  presentationStatus = 'closed';
  rangeDetector.reset();
  colorInfo = { ...UNKNOWN_COLOR_SPACE };
  lastHdrStats = null;
  lastColorProbeAt = 0;
  governor = initialGovernorState();

  state = { ...state, visible: false };
  try {
    await chrome.storage.session.set({ scopesOn: false });
  } catch {
    // Ignore.
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'show-scopes' || msg?.type === 'toggle-scopes') {
      ensureVisible();
    } else if (msg?.type === 'hotkey-toggle-scopes') {
      if (enabled) {
        void disable();
      } else {
        ensureVisible();
      }
    }
  });
}

function ensureVisible(): void {
  if (!enabled) {
    void enable().then(() => detachToFloatingWindow());
    return;
  }
  if (enablePromise) {
    void enablePromise.then(() => detachToFloatingWindow());
    return;
  }
  if (floating?.isOpen()) {
    floating.window.focus();
    return;
  }
  const host = document.getElementById(HOST_ID);
  if (!host) {
    void disable().then(() => enable().then(() => detachToFloatingWindow()));
    return;
  }
  void detachToFloatingWindow();
}

async function detachToFloatingWindow(): Promise<void> {
  if (floating?.isOpen()) {
    floating.window.focus();
    return;
  }
  if (!pipSupported()) {
    activeHud()?.setNotice('Floating window needs Chrome 116+. Panel shown in page.');
    guardian?.reattach();
    return;
  }

  try {
    floating = await openFloatingWindow({
      width: Math.min(920, Math.round(window.screen.availWidth * 0.52)),
      height: Math.min(700, Math.round(window.screen.availHeight * 0.74)),
      onClosed: () => {
        floating = null;
        floatingHud?.unmount();
        floatingHud = null;
        if (enabled && !hud) {
          void disable();
        } else {
          controller?.setTargets(activeHud()?.panelCanvases() ?? []);
          presentationStatus = 'returned';
        }
      },
    });

    guardian?.stop();
    guardian = null;
    hud?.unmount();
    hud = null;

    floatingHud = new Hud(
      { ...state, hostPosition: { left: 0, top: 0, right: 0 } },
      buildHandlers(),
    );
    floatingHud.mount(floating.document, { fill: true });

    if (!controller) buildController();
    controller?.setTargets(floatingHud.panelCanvases());
    refreshHud();
    controller?.resize();
    requestRedraw();

    presentationStatus = 'floating';
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') {
      // Browser requires an in-page gesture for Document PiP; keep in-page HUD cleanly.
      presentationStatus = 'in-page';
      guardian?.reattach();
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    activeHud()?.setNotice(`Floating window failed: ${msg}`);
    guardian?.reattach();
  }
}

// Retire any stale content-script instance left running in this tab after an
// extension reload in chrome://extensions before registering our own listeners!
const SUPERSEDE_EVENT = 'video-scopes:supersede';
try {
  window.dispatchEvent(new CustomEvent(SUPERSEDE_EVENT));
} catch {
  // Ignore
}

let superseded = false;
const onKeyDown = (e: KeyboardEvent): void => {
  if (superseded) return;
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault();
    if (enabled) {
      void disable();
    } else {
      ensureVisible();
    }
  }
};
window.addEventListener('keydown', onKeyDown);

window.addEventListener(
  SUPERSEDE_EVENT,
  () => {
    superseded = true;
    window.removeEventListener('keydown', onKeyDown);
    void disable();
  },
  { once: true },
);

void (async () => {
  let shouldStart = false;
  try {
    const got = await chrome.storage.session.get('scopesOn');
    shouldStart = got.scopesOn === true;
  } catch {
    shouldStart = false;
  }

  if (!shouldStart) {
    presentationStatus = 'idle';
    return;
  }

  try {
    const saved = await loadSettings();
    state = { ...saved, visible: true };
  } catch (e) {
    console.warn('[video-scopes] settings unavailable, using defaults:', e);
    state = { ...DEFAULT_STATE, visible: true };
  }

  try {
    await enable();
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    presentationStatus = 'enable-failed';
    showDiagnostic('error', msg);
    console.error('[video-scopes] enable failed:', msg);
  }
})();
