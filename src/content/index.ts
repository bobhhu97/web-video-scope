import { VideoDetector } from './video-detector';
import { FrameLoop } from './frame-loop';
import { followFullscreen } from './fullscreen';
import { readVideoColorSpace, applyRangeMode } from './color-space';
import { ScopeController } from './scope-controller';
import { Hud, type HudHandlers } from '../ui/hud';
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
import { openFloatingWindow, pipSupported, type FloatingWindow } from '../ui/pip';
import { videoReadability, readabilityNotice, type Readability } from './readability';
import { keepAttached, type Guardian } from './keep-attached';

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
let guardian: Guardian | null = null;
let reattachCount = 0;
let lastDisableReason = 'none';
let floating: FloatingWindow | null = null;
/** The HUD living in the floating window, if any. */
let floatingHud: Hud | null = null;
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

  // Quality tiers adjust workload — frame rate and analysis resolution — and
  // nothing else. They used to also force a layout, which silently overrode the
  // user's choice: picking a single scope switched to `single`, then the next
  // governor tick reverted it to `grid`. Which panels are on screen is a user
  // decision, not a performance knob.
  void saveSettings(state);
}

function refreshHud(): void {
  activeHud()?.setState(state);
  activeHud()?.setColorInfo(colorInfo);
  controller?.setOptionsFor(optionsForMode);
}

// ---------------------------------------------------------------------------
// frame pipeline
// ---------------------------------------------------------------------------

function onDiagnosis(hist: Uint32Array, total: number): void {
  const diagnosis = rangeDetector.push(colorInfo, histogramStats(hist, total));
  const next = applyRangeMode(state.rangeMode, colorInfo, diagnosis);
  const changed = next.limited !== effectiveRange.limited || next.depth !== effectiveRange.depth;
  effectiveRange = next;

  // Report what the scopes are actually drawing on, derived from the same value
  // handed to the renderer. Showing the detector's verdict instead let the badge
  // claim "axis:limited" while the shader plotted on a full-range axis, which is
  // how a legal white reading reached 119 IRE with no explanation.
  activeHud()?.setDiagnosis({ ...diagnosis, effective: effectiveRange.limited ? 'limited' : 'full' });

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
    activeHud()?.setPerf(fps, timer.lastMs, currentTier(), controller?.uploadPath);
    const dims = controller?.analysisDims;
    if (dims) activeHud()?.setNotice(null);
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
      activeHud()?.setColorInfo(colorInfo);
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
    activeHud()?.panelCanvases() ?? [],
    optionsForMode,
    { onDiagnosis, onFrameSubmitted },
    () => state.gamuts,
    analysisPreset,
  );
  controller.setMinInterval(1000 / TIER_DESCRIPTION[currentTier()].fps);
  controller.setSignalMode(state.signalMode);
  // Test seam: expose the range the renderer was actually constructed with.
  (window as unknown as { __scopeDebug?: unknown }).__scopeDebug = {
    get range() {
      return effectiveRange.limited ? 'limited' : 'full';
    },
    get effective() {
      return state.rangeMode;
    },
  };
  controller.onRawError = (msg) => activeHud()?.setNotice(`Raw mode unavailable: ${msg}`);
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

  // Remember the opt-in for the rest of this browser session, so switching to
  // another video tab does not need another click. Session scope means closing
  // the browser returns to the off state — no permanent background cost.
  try {
    await chrome.storage.session.set({ scopesOn: true });
  } catch {
    // Non-fatal: the panel still works, it just will not auto-restore.
  }

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
/** Handlers shared by the in-page HUD and the one in the floating window. */
function buildHandlers(): HudHandlers {
  return {
    onStateChange(patch) {
      const signalChanged = patch.signalMode !== undefined && patch.signalMode !== state.signalMode;
      const modeChanged = patch.mode !== undefined && patch.mode !== state.mode;
      state = { ...state, ...patch };
      void saveSettings(state);
      if (signalChanged) controller?.setSignalMode(state.signalMode);
      if (modeChanged) {
        // Highlight only. Cell rebuilds belong to onLayoutChange, which the
        // caller invokes explicitly; rebuilding here raced with it and the
        // loser overwrote the grid with the old layout.
        activeHud()?.setSingleMode(state.mode);
      }
      refreshHud();
    },
    onPanelsChange(layout, panels) {
      state = { ...state, layout, panels: { ...state.panels, [layout]: panels } };
      void saveSettings(state);
      // Same order as onLayoutChange: rebuild cells first, then hand the new
      // canvases to the controller. Handing over stale canvases leaves a panel
      // drawing into an element that is no longer in the document.
      activeHud()?.relayout(layout);
      controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      controller?.setOptionsFor(optionsForMode);
    },
    onLayoutChange(layout: Layout) {
      state = { ...state, layout };
      void saveSettings(state);
      // One pass: push state, rebuild the cells, then hand the new canvases to
      // the controller. Calling setState again afterwards re-synced inputs but
      // also re-ran the mode highlight, which could re-assert the old grid.
      activeHud()?.relayout(layout);
      controller?.setTargets(activeHud()?.panelCanvases() ?? []);
      controller?.setOptionsFor(optionsForMode);
      void saveSettings(state);
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
      activeHud()?.setPerf(0, timer.lastMs, currentTier());
    },
  };
}

/** The panel shown in the page. */
function buildHud(): Hud {
  return new Hud(state, buildHandlers());
}

/** The panel shown in the floating window, when one is open. */
function activeHud(): Hud | null {
  return floatingHud ?? hud;
}

/**
 * Everything that can fail without taking the panel down with it.
 * Called right after the HUD is mounted, so any throw still leaves a visible
 * panel that can explain itself.
 */
function finishEnable(): void {
  const mounted = activeHud()?.hostElement;
  if (!mounted) {
    // enable() was torn down between mount and this call (a fast close, or a
    // second enable racing the first). Nothing to wire up.
    stampTitle('finish-skipped');
    return;
  }

  try {
    unfollowFullscreen = followFullscreen(mounted);

    // Pages that rebuild their DOM after load (YouTube's hydration) detach the
    // host as collateral. Re-attach whenever that happens, and report the count
    // so this failure mode is visible instead of silent.
    guardian = keepAttached(
      mounted,
      () => document.fullscreenElement ?? document.documentElement,
      (n) => {
        reattachCount = n;
      },
    );

    buildController();
    stampTitle('controller-ready');

    probe = new Probe(
    (sample) => activeHud()?.setProbe(formatSample(sample, state.units, effectiveRange)),
    () => ({ matrix: colorInfo.matrix ?? 'bt709', range: effectiveRange }),
  );

  detector = new VideoDetector((video) => {
    loop?.stop();
    loop = null;
    if (probedVideo && probe) probe.disable(probedVideo);
    probedVideo = video;
    if (!video) {
      readability = { kind: 'unknown' };
      activeHud()?.setNotice('No video found on this page.');
      stampTitle('no-video');
      return;
    }
    stampTitle('video-found');
    // Tell the user *why* a scope would be empty, instead of showing a blank
    // panel that looks broken.
    readability = videoReadability(video);
    activeHud()?.setNotice(readabilityNotice(readability, true));
    if (readability.kind === 'readable') probe?.enable(video);
    loop = new FrameLoop(video, onFrame);
    loop.setTargetFps(TIER_DESCRIPTION[currentTier()].fps);
    loop.start();
  });
  detector.start();
    stampTitle(detector.video ? 'detector-video' : 'detector-novideo');
    stampGeometry('geo');
    // Continuous trace: a single sample cannot distinguish "never mounted" from
    // "mounted then removed then re-attached". Each line records connectivity,
    // parent, re-attach count and whether the panel is still enabled.
    // Keep the whole timeline. Overwriting each second destroyed the evidence:
    // by the time the user ran the reader, only the final state remained, and
    // "absent" could mean never-mounted or mounted-then-closed.
    const history: string[] = [];
    const trace = setInterval(() => {
      const h = document.getElementById(HOST_ID);
      const r = h?.getBoundingClientRect();
      const seg =
        (h ? (h.isConnected ? 'conn' : 'detach') : 'ABSENT') +
        (r ? `@${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : '') +
        `,en=${enabled ? 1 : 0},re=${reattachCount},dis=${h ? getComputedStyle(h).display : '-'}`;
      history.push(seg);
      // Keep the last 6 samples; longer than that and the title gets unwieldy.
      stampTitle('trace', history.slice(-6).join(' > '));
      if (history.length >= 10) clearInterval(trace);
    }, 1000);
    if (!detector.video) activeHud()?.setNotice('No video found on this page.');
  } catch (e) {
    // The panel is already on screen, so report here instead of throwing.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    activeHud()?.setNotice(`Scopes failed to start: ${msg}`);
    stampTitle('scopes-failed');
    console.error('[video-scopes] finishEnable failed:', msg);
  }
}

async function disable(): Promise<void> {
  if (!enabled) return;
  // Record the caller: a close the user asked for and one triggered by our own
  // recovery path look identical otherwise.
  const who = (new Error().stack ?? '')
    .split('\n')
    .slice(1, 4)
    .map((l) => l.trim().replace(/^at\s+/, '').split(' ')[0])
    .join('<');
  try {
    lastDisableReason = who;
  } catch {
    // ignore
  }
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
  probedVideo = null;
  activeHud()?.unmount();
  hud = null;
  stampTitle('closed');
  rangeDetector.reset();
  governor = initialGovernorState();

  state = { ...state, visible: false };
  // Closing is an explicit opt-out for the rest of the session: tearing down
  // the GPU work and leaving it off is the whole point.
  try {
    await chrome.storage.session.set({ scopesOn: false });
  } catch {
    // Ignore.
  }
}

function toggle(): void {
  void (enabled ? disable() : enable());
}

/**
 * Reflect state in document.title so the extension's health can be read without
 * a screenshot. Only writes while the HUD exists, and restores on unmount.
 */
function stampTitle(status: string, extra?: string): void {
  const marker = ' [VS:';
  const base = document.title.replace(/ \[VS:[^\]]*\]$/, '');
  document.title = `${base}${marker}${status}${extra ? '|' + extra : ''}]`;
}

/** Dump the panel's geometry into the title so an invisible panel reports why. */
function stampGeometry(tag: string): void {
  const h = document.getElementById(HOST_ID);
  if (!h) {
    stampTitle(`${tag}-nohost`);
    return;
  }
  const r = h.getBoundingClientRect();
  const panel = h.shadowRoot?.querySelector('.panel') as HTMLElement | null;
  const pr = panel?.getBoundingClientRect();
  const cs = getComputedStyle(h);
  // A transform/filter/perspective/contain on an ancestor makes fixed
  // positioning resolve against that ancestor instead of the viewport, which
  // silently moves the panel. YouTube is known to touch these.
  const culprits: string[] = [];
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const s2 = getComputedStyle(el);
    const why: string[] = [];
    if (s2.transform !== 'none') why.push('transform=' + s2.transform);
    if (s2.filter !== 'none') why.push('filter=' + s2.filter);
    if (s2.perspective !== 'none') why.push('perspective');
    if (s2.contain !== 'none') why.push('contain=' + s2.contain);
    if (s2.willChange !== 'auto') why.push('will-change=' + s2.willChange);
    if (why.length) culprits.push(`${el.tagName.toLowerCase()}:${why.join('+')}`);
  }

  const bits = [
    `host=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
    `vh=${window.innerHeight}`,
    `disp=${cs.display}`,
    `vis=${cs.visibility}`,
    `zi=${cs.zIndex}`,
    panel ? `panel=${Math.round(pr!.width)}x${Math.round(pr!.height)}` : 'panel=MISSING',
    `kids=${h.shadowRoot?.children.length ?? 0}`,
    culprits.length ? `CONTEXT:${culprits.join(',')}` : 'ctx=clean',
  ];
  stampTitle(tag, bits.join(','));
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'show-scopes' || msg?.type === 'toggle-scopes') {
    // Deliberately `ensureVisible`, not `toggle`: someone clicking the toolbar
    // icon is asking to see the panel. If it is already mounted they get it
    // re-attached and brought to the front instead of it disappearing.
    ensureVisible();
  }
});

/**
 * Guarantee the panel is on screen. Used by the toolbar icon, whose intent is
 * "show me the scopes", never "hide them".
 */
function ensureVisible(): void {
  if (!enabled) {
    // Enable first, then detach: the HUD must be mounted before it can move.
    void enable().then(() => detachToFloatingWindow());
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
  // Prefer the floating window: it is immune to the page's DOM surgery,
  // stacking contexts and z-index wars, which is what kept making the in-page
  // panel invisible.
  void detachToFloatingWindow();
}

/**
 * Move the panel into an always-on-top window. Falls back to keeping it in the
 * page (and says so) when the API is unavailable.
 */
/**
 * Move the panel into an always-on-top window.
 *
 * The HUD is rebuilt inside that window rather than moved into it. A WebGPU
 * canvas context belongs to the document that configured it, so adopting a
 * canvas into a PiP document kills the context: the panel would appear with a
 * drawn graticule and no trace. Only a HUD created by that document works.
 */
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
      width: Math.min(900, Math.round(window.screen.availWidth * 0.5)),
      height: Math.min(680, Math.round(window.screen.availHeight * 0.72)),
      onClosed: () => {
        floating = null;
        floatingHud?.unmount();
        floatingHud = null;
        controller?.setTargets(activeHud()?.panelCanvases() ?? []);
        stampTitle('returned');
      },
    });

    // Tear down the in-page panel first: leaving it mounted put two panels in the
    // document at once (the page's and the window's), which looked like one panel
    // nested inside another and doubled the GPU work.
    guardian?.stop();
    guardian = null;
    hud?.unmount();
    hud = null;

    // Build a fresh HUD inside the window's document. Its canvases are created
    // there, so their GPU contexts are valid.
    floatingHud = new Hud(
      { ...state, hostPosition: { left: 0, top: 0, right: 0 } },
      buildHandlers(),
    );
    floatingHud.mount(floating.document, { fill: true });

    if (!controller) buildController();
    controller?.setTargets(floatingHud.panelCanvases());
    controller?.setOptionsFor(optionsForMode);
    controller?.resize();

    stampTitle('floating');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    activeHud()?.setNotice(`Floating window failed: ${msg}`);
    guardian?.reattach();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault();
    // Same path as the toolbar icon, so the shortcut and the icon always agree.
    if (enabled) {
      void disable();
    } else {
      ensureVisible();
    }
  }
});

// Nothing starts automatically.
//
// The panel is opt-in: it costs GPU time, allocates textures, and overlays the
// page, so it must only run when the user asks for it. `chrome.storage.session`
// remembers that the user switched it on for THIS browser session, so opening a
// new video tab keeps working without a click, while a cold start is always
// silent.
void (async () => {
  let shouldStart = false;
  try {
    const got = await chrome.storage.session.get('scopesOn');
    shouldStart = got.scopesOn === true;
  } catch {
    // No session storage: stay off. Starting unasked is the worse failure.
    shouldStart = false;
  }

  if (!shouldStart) {
    stampTitle('idle');
    return;
  }

  // Read settings defensively; a storage failure must not block the panel.
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
    stampTitle('enable-failed');
    // enable() mounts the panel first, so this only fires for failures in the
    // mount itself — report visibly in that case.
    showDiagnostic('error', msg);
    console.error('[video-scopes] enable failed:', msg);
  }
})();

// Keep the panel reachable when the page tears down the DOM it lived in.
document.addEventListener('fullscreenchange', () => {
  if (!activeHud()?.mounted) return;
  const host = document.getElementById(HOST_ID);
  if (!host) return;
  const fs = document.fullscreenElement;
  if (fs && host.parentElement !== fs) fs.appendChild(host);
});
