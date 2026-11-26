import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { RangeDetector, sanitizeRangeDiagnosis } from '../src/core/range-detector';
import {
  linearToSrgb,
  recoverBt709SignalFromSrgb,
  resolveDisplayTransferFix,
} from '../src/core/color/transfer';
import { describeSample } from '../src/ui/probe';
import { placeTopLayerOverlayHost } from '../src/content/fullscreen';
import { FalseColorOverlay } from '../src/ui/false-color-overlay';
import { Hud } from '../src/ui/hud';
import { DEFAULT_STATE, type HudState } from '../src/ui/settings';
import { pickMainVideo } from '../src/content/video-detector';
import downscaleWgsl from '../src/gpu/shaders/downscale.wgsl?raw';
import downscaleExternalWgsl from '../src/gpu/shaders/downscale-external.wgsl?raw';
import rawDownscaleWgsl from '../src/gpu/shaders/raw-downscale.wgsl?raw';
import falseColorWgsl from '../src/gpu/shaders/false-color.wgsl?raw';

const limitedWebCodecsInfo = {
  fullRange: false,
  matrix: 'bt709' as const,
  primaries: 'rec709' as const,
  transfer: 'bt709' as const,
  format: 'NV12',
  source: 'webcodecs' as const,
};

describe('sanitizeRangeDiagnosis (fixes bogus "full as limited" warning in display mode)', () => {
  it('suppresses full-treated-as-limited in display signalMode because browser already expanded limited YUV to 0..1 RGB', () => {
    const detector = new RangeDetector(3);
    for (let i = 0; i < 3; i++) {
      detector.push(limitedWebCodecsInfo, {
        p001: 0.002,
        p999: 0.998,
        belowBlack: 0.08,
        aboveWhite: 0.07,
      });
    }
    // Raw detector sees 0..1 distribution vs limited metadata
    expect(detector.current.warning).toBe('full-treated-as-limited');

    // In display mode (auto or manual), it must NEVER warn "full-treated-as-limited"
    const sanitizedAuto = sanitizeRangeDiagnosis(
      detector.current,
      'display',
      'auto',
    );
    expect(sanitizedAuto.warning).toBeNull();
    expect(sanitizedAuto.effective).toBe('limited');
  });

  it('preserves full-treated-as-limited in raw YUV signalMode whenrangeMode is auto or limited', () => {
    const detector = new RangeDetector(3);
    for (let i = 0; i < 3; i++) {
      detector.push(limitedWebCodecsInfo, {
        p001: 0.002,
        p999: 0.998,
        belowBlack: 0.08,
        aboveWhite: 0.07,
      });
    }
    const sanitizedRaw = sanitizeRangeDiagnosis(detector.current, 'raw', 'auto');
    expect(sanitizedRaw.warning).toBe('full-treated-as-limited');

    // Once user explicitly overrides rangeMode to "full", warning is resolved
    const sanitizedManualFull = sanitizeRangeDiagnosis(detector.current, 'raw', 'full');
    expect(sanitizedManualFull.warning).toBeNull();
  });

  it('still warns limited-treated-as-full in display mode when unexpanded legal signal sits in 16..235', () => {
    const fullWebCodecsInfo = { ...limitedWebCodecsInfo, fullRange: true };
    const detector = new RangeDetector(3);
    for (let i = 0; i < 3; i++) {
      detector.push(fullWebCodecsInfo, {
        p001: 0.063,
        p999: 0.92,
        belowBlack: 0,
        aboveWhite: 0,
      });
    }
    expect(detector.current.warning).toBe('limited-treated-as-full');
    expect(sanitizeRangeDiagnosis(detector.current, 'display', 'auto').warning).toBe(
      'limited-treated-as-full',
    );
    // Cleared when user manually sets rangeMode to limited
    expect(sanitizeRangeDiagnosis(detector.current, 'display', 'limited').warning).toBeNull();
  });
});

describe('placeTopLayerOverlayHost (fixes False Color buried behind z-index:2147483647 & html transforms)', () => {
  it('promotes overlay to popover="manual" Top Layer even in normal non-fullscreen mode and avoids redundant re-shows', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const prevDoc = globalThis.document;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    try {
      const host = dom.window.document.createElement('div');
      let open = false;
      const showPopover = vi.fn(() => {
        open = true;
      });
      const hidePopover = vi.fn(() => {
        open = false;
      });
      Object.assign(host, { showPopover, hidePopover });
      const origMatches = host.matches.bind(host);
      host.matches = (sel: string) => (sel === ':popover-open' ? open : origMatches(sel));

      // First placement in normal mode MUST promote to Top Layer via showPopover()
      placeTopLayerOverlayHost(host);
      expect(host.getAttribute('popover')).toBe('manual');
      expect(showPopover).toHaveBeenCalledTimes(1);
      expect(hidePopover).toHaveBeenCalledTimes(0);

      // Subsequent rAF geometry syncs must NOT tear down & re-open an already-open popover!
      placeTopLayerOverlayHost(host);
      placeTopLayerOverlayHost(host);
      expect(showPopover).toHaveBeenCalledTimes(1);
      expect(hidePopover).toHaveBeenCalledTimes(0);

      // Forced restack (e.g. fullscreenchange) cleanly re-promotes to top of Top Layer
      placeTopLayerOverlayHost(host, true);
      expect(hidePopover).toHaveBeenCalledTimes(1);
      expect(showPopover).toHaveBeenCalledTimes(2);
    } finally {
      (globalThis as unknown as { document: Document }).document = prevDoc;
    }
  });
});

describe('FalseColorOverlay ensureGpu concurrency & TrustedTypes-safe legend', () => {
  it('coalesces concurrent ensureGpu() calls into a single shared promise instead of returning false', async () => {
    const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', {
      pretendToBeVisual: true,
    });
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevNav = globalThis.navigator;
    const prevBufUsage = (globalThis as Record<string, unknown>).GPUBufferUsage;

    (globalThis as unknown as { window: Window }).window = dom.window as unknown as Window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08 };

    let resolveAdapter!: (v: unknown) => void;
    const fakeDevice = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBuffer: () => ({ destroy() {} }),
      queue: { writeBuffer() {} },
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        gpu: {
          getPreferredCanvasFormat: () => 'bgra8unorm',
          requestAdapter: () =>
            new Promise((r) => {
              resolveAdapter = r;
            }),
        },
      },
    });

    try {
      const overlay = new FalseColorOverlay();
      overlay.mount();
      const canvas = dom.window.document
        .getElementById('video-scopes-false-color')!
        .shadowRoot!.querySelector('canvas')!;
      (canvas as unknown as { getContext: () => unknown }).getContext = () => ({
        canvas,
        configure() {},
        getCurrentTexture: () => ({ createView: () => ({}) }),
      });

      // Simulate Frame A kicking off ensureGpu() without awaiting, followed immediately by Frame B awaiting ensureGpu()
      const callA = overlay.ensureGpu();
      const callB = overlay.ensureGpu();

      resolveAdapter({
        requestDevice: async () => fakeDevice,
      });

      const [resA, resB] = await Promise.all([callA, callB]);
      expect(resA).toBe(true);
      expect(resB).toBe(true);
      overlay.unmount();
    } finally {
      (globalThis as unknown as { window: Window }).window = prevWin;
      (globalThis as unknown as { document: Document }).document = prevDoc;
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav });
      (globalThis as Record<string, unknown>).GPUBufferUsage = prevBufUsage;
    }
  });
});

describe('pickMainVideo open Shadow DOM traversal', () => {
  it('finds a visible <video> inside an open Web Component shadowRoot', () => {
    const dom = new JSDOM('<!doctype html><html><body><custom-player></custom-player></body></html>');
    const player = dom.window.document.querySelector('custom-player')!;
    const shadow = player.attachShadow({ mode: 'open' });
    const video = dom.window.document.createElement('video');
    Object.defineProperty(video, 'videoWidth', { value: 1920 });
    Object.defineProperty(video, 'videoHeight', { value: 1080 });
    video.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    shadow.appendChild(video);

    const prevGetCs = globalThis.getComputedStyle;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    try {
      expect(pickMainVideo(dom.window.document)).toBe(video);
    } finally {
      globalThis.getComputedStyle = prevGetCs;
    }
  });

  it('prefers an in-viewport Bilibili player <video> over a larger playing banner <video> scrolled off-screen', () => {
    const dom = new JSDOM(
      '<!doctype html><html><body>' +
        '<video id="banner"></video>' +
        '<div class="bpx-player-video-wrap"><video id="player"></video></div>' +
        '</body></html>',
    );
    const prevWin = globalThis.window;
    const prevGetCs = globalThis.getComputedStyle;
    Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
    Object.defineProperty(dom.window, 'innerHeight', { value: 860, configurable: true });
    (globalThis as unknown as { window: Window }).window = dom.window as unknown as Window;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

    try {
      const banner = dom.window.document.getElementById('banner') as HTMLVideoElement;
      Object.defineProperty(banner, 'videoWidth', { value: 1920 });
      Object.defineProperty(banner, 'videoHeight', { value: 300 });
      Object.defineProperty(banner, 'paused', { value: false });
      banner.getBoundingClientRect = () =>
        ({ left: 0, top: -320, right: 1920, bottom: -20, width: 1920, height: 300, x: 0, y: -320, toJSON: () => ({}) }) as DOMRect;

      const player = dom.window.document.getElementById('player') as HTMLVideoElement;
      Object.defineProperty(player, 'videoWidth', { value: 1920 });
      Object.defineProperty(player, 'videoHeight', { value: 1080 });
      Object.defineProperty(player, 'paused', { value: true });
      player.getBoundingClientRect = () =>
        ({ left: 41, top: 168, right: 921, bottom: 663, width: 880, height: 495, x: 41, y: 168, toJSON: () => ({}) }) as DOMRect;

      expect(pickMainVideo(dom.window.document)).toBe(player);
    } finally {
      (globalThis as unknown as { window: Window }).window = prevWin;
      globalThis.getComputedStyle = prevGetCs;
    }
  });
});

describe('Bilibili real-world False Color fixes (CSS !important isolation, popover fallback, orphan cleanup, and 1-click preset activation)', () => {
  it('uses !important inline styles without all:initial and cleans up stale orphan overlays so Bilibili extensions cannot hide it', () => {
    const dom = new JSDOM('<!doctype html><html><body><video id="v"></video></body></html>', {
      pretendToBeVisual: true,
    });
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    const prevGetCs = globalThis.getComputedStyle;
    Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true });
    Object.defineProperty(dom.window, 'innerHeight', { value: 860, configurable: true });
    (globalThis as unknown as { window: Window }).window = dom.window as unknown as Window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);

    try {
      // Simulate stale orphan left behind by a reloaded extension instance
      const orphan = dom.window.document.createElement('div');
      orphan.id = 'video-scopes-false-color';
      dom.window.document.documentElement.appendChild(orphan);

      const v = dom.window.document.getElementById('v') as HTMLVideoElement;
      Object.defineProperty(v, 'videoWidth', { value: 1920 });
      Object.defineProperty(v, 'videoHeight', { value: 1080 });
      v.getBoundingClientRect = () =>
        ({ left: 40, top: 160, right: 920, bottom: 655, width: 880, height: 495, x: 40, y: 160, toJSON: () => ({}) }) as DOMRect;

      const overlay = new FalseColorOverlay();
      overlay.mount();
      // Force geometry sync via encode with enabled:true (before GPU ready, legend still renders!)
      overlay.encode(
        {} as GPUCommandEncoder,
        v,
        {
          texture: { createView: () => ({}) } as unknown as GPUTexture,
          view: {} as unknown as GPUTextureView,
          format: 'rgba16float',
          width: 640,
          height: 360,
        },
        {
          enabled: true,
          preset: 'arri',
          opacity: 0.88,
          showLegend: true,
          lang: 'zh',
          sdrWhiteNits: 203,
          nitLow: 100,
          nitHigh: 1000,
          matrix: 'bt709',
          range: { limited: true, depth: 8 },
          signalKind: 'display',
          sourceTransfer: 'sdr',
          effectiveTransfer: 'sdr',
        },
      );

      const hosts = dom.window.document.querySelectorAll('#video-scopes-false-color');
      expect(hosts.length).toBe(1);
      const host = hosts[0] as HTMLElement;
      expect(host.style.cssText.includes('all: initial')).toBe(false);
      expect(host.style.getPropertyPriority('display')).toBe('important');
      expect(host.style.getPropertyPriority('visibility')).toBe('important');
      expect(host.style.getPropertyPriority('opacity')).toBe('important');
      expect(host.style.getPropertyPriority('position')).toBe('important');
      expect(host.style.getPropertyPriority('left')).toBe('important');
      expect(host.style.getPropertyPriority('top')).toBe('important');
      expect(host.style.getPropertyPriority('width')).toBe('important');
      expect(host.style.getPropertyPriority('height')).toBe('important');
      expect(host.shadowRoot?.querySelector('.legend')?.textContent).toContain('ARRI');

      overlay.unmount();
    } finally {
      (globalThis as unknown as { window: Window }).window = prevWin;
      (globalThis as unknown as { document: Document }).document = prevDoc;
      globalThis.getComputedStyle = prevGetCs;
    }
  });

  it('removes [popover] attribute if showPopover() throws so UA [popover]:not(:popover-open) never hides the overlay', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const prevDoc = globalThis.document;
    (globalThis as unknown as { document: Document }).document = dom.window.document;
    try {
      const host = dom.window.document.createElement('div');
      Object.assign(host, {
        showPopover: () => {
          throw new Error('InvalidStateError');
        },
      });
      const origMatches = host.matches.bind(host);
      host.matches = (sel: string) => (sel === ':popover-open' ? false : origMatches(sel));

      placeTopLayerOverlayHost(host);
      expect(host.hasAttribute('popover')).toBe(false);
    } finally {
      (globalThis as unknown as { document: Document }).document = prevDoc;
    }
  });

  it('auto-enables videoFalseColor when selecting a preset in #fc-preset or #set-fc-preset and exposes #set-fc-enable in Global Settings', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    (globalThis as unknown as { window: Window }).window = dom.window as unknown as Window;
    (globalThis as unknown as { document: Document }).document = dom.window.document;

    try {
      const patches: Array<Partial<HudState>> = [];
      let currentState: HudState = { ...DEFAULT_STATE, visible: true, lang: 'zh', videoFalseColor: false };
      const hud = new Hud(currentState, {
        onStateChange(p) {
          patches.push(p);
          currentState = { ...currentState, ...p };
        },
        onCellChange() {},
        onCellsReplace() {},
        onLayoutChange() {},
        onPanelsChange() {},
        onClose() {},
        onOpenPip() {},
        onToggleLock() {},
      });
      hud.mount(dom.window.document, { fill: true });
      const root = dom.window.document.getElementById('video-scopes-host')!.shadowRoot!;

      // Selecting ARRI in toolbar #fc-preset while videoFalseColor is false MUST turn videoFalseColor ON!
      const fcPreset = root.getElementById('fc-preset') as HTMLSelectElement;
      fcPreset.value = 'arri';
      fcPreset.dispatchEvent(new dom.window.Event('change'));

      expect(currentState.falseColorPreset).toBe('arri');
      expect(currentState.videoFalseColor).toBe(true);
      expect(root.getElementById('false-color-btn')?.getAttribute('aria-pressed')).toBe('true');

      // Global settings modal MUST also provide an explicit #set-fc-enable checkbox synced with videoFalseColor!
      root.getElementById('settings-btn')?.dispatchEvent(new dom.window.MouseEvent('click'));
      const setFcEnable = root.getElementById('set-fc-enable') as HTMLInputElement | null;
      expect(setFcEnable).not.toBeNull();
      expect(setFcEnable?.checked).toBe(true);

      // Unchecking #set-fc-enable turns False Color OFF
      setFcEnable!.checked = false;
      setFcEnable!.dispatchEvent(new dom.window.Event('change'));
      expect(currentState.videoFalseColor).toBe(false);
      expect(root.getElementById('false-color-btn')?.getAttribute('aria-pressed')).toBe('false');

      // Selecting SmallHD in #set-fc-preset inside settings also auto-enables videoFalseColor!
      const setFcPreset = root.getElementById('set-fc-preset') as HTMLSelectElement;
      setFcPreset.value = 'smallhd';
      setFcPreset.dispatchEvent(new dom.window.Event('change'));
      expect(currentState.falseColorPreset).toBe('smallhd');
      expect(currentState.videoFalseColor).toBe(true);
      expect(setFcEnable?.checked).toBe(true);

      hud.unmount();
    } finally {
      (globalThis as unknown as { window: Window }).window = prevWin;
      (globalThis as unknown as { document: Document }).document = prevDoc;
    }
  });

  it('maps WebGPU top NDC (y=+1) to top texture UV (v=0) across all downscale & false-color shaders so False Color is never upside-down', () => {
    for (const [name, code] of [
      ['downscale.wgsl', downscaleWgsl],
      ['downscale-external.wgsl', downscaleExternalWgsl],
      ['raw-downscale.wgsl', rawDownscaleWgsl],
      ['false-color.wgsl', falseColorWgsl],
    ] as const) {
      expect(code, `${name} must use (1.0 - pts[i].y) * 0.5 for WebGPU Y-down UV`).toContain(
        '(1.0 - pts[i].y) * 0.5',
      );
      expect(code, `${name} must NOT invert Y with (pts[i].y + 1.0) * 0.5`).not.toContain(
        '(pts[i].y + 1.0) * 0.5',
      );
    }
  });

  it('recovers exact 40.2 IRE BT.709 signal from WebGPU sRGB re-encoding and uses pure Luma Y so 38–42 IRE always colors green', () => {
    // Exact pixel from user screenshot: RGB 8b = (104, 103, 94) -> 40.2 IRE · 27.3n
    const sample = describeSample([104, 103, 94], 593, 1460, 'bt709', { limited: true, depth: 8 });
    expect(sample.ire).toBeCloseTo(40.22, 1);
    expect(sample.nits).toBeCloseTo(27.3, 1);

    // 1. macOS Chromium BT709_APPLE (gamma 1.9609375) -> sRGB inflates 40.2 IRE to ~44.6 IRE
    expect(resolveDisplayTransferFix('bt709', 'MacIntel')).toBe(1);
    const macSrgbR = linearToSrgb(Math.pow(104 / 255, 1.9609375));
    const macSrgbG = linearToSrgb(Math.pow(103 / 255, 1.9609375));
    const macSrgbB = linearToSrgb(Math.pow(94 / 255, 1.9609375));
    const inflatedMacIre = (0.2126 * macSrgbR + 0.7152 * macSrgbG + 0.0722 * macSrgbB) * 100;
    expect(inflatedMacIre).toBeGreaterThan(44); // Explains why it previously missed 38–42%!

    const recR = recoverBt709SignalFromSrgb(macSrgbR, 1);
    const recG = recoverBt709SignalFromSrgb(macSrgbG, 1);
    const recB = recoverBt709SignalFromSrgb(macSrgbB, 1);
    const recoveredMacIre = (0.2126 * recR + 0.7152 * recG + 0.0722 * recB) * 100;
    expect(recoveredMacIre).toBeCloseTo(sample.ire, 2);
    expect(recoveredMacIre).toBeGreaterThanOrEqual(38);
    expect(recoveredMacIre).toBeLessThanOrEqual(42);

    // 2. Windows/Linux Chromium ITU-R BT.709 -> sRGB inflates 40.2 IRE to ~45.5 IRE
    expect(resolveDisplayTransferFix('bt709', 'Win32')).toBe(2);
    const ituLin = (v: number) => Math.pow((v + 0.0992968) / 1.0992968, 1 / 0.45);
    const winSrgbG = linearToSrgb(ituLin(103 / 255));
    expect(recoverBt709SignalFromSrgb(winSrgbG, 2)).toBeCloseTo(103 / 255, 4);

    // 3. sRGB / unknown stay pass-through (mode 0); HDR PQ/HLG select Dawn inverse-gamut mode (3/4/5)
    expect(resolveDisplayTransferFix('srgb', 'MacIntel')).toBe(0);
    expect(resolveDisplayTransferFix('unknown', 'MacIntel')).toBe(0);
    expect(resolveDisplayTransferFix('pq', 'MacIntel')).toBe(3);
    expect(resolveDisplayTransferFix('hlg', 'MacIntel')).toBe(3);
    expect(resolveDisplayTransferFix('pq', 'MacIntel', 'p3')).toBe(4);
    expect(resolveDisplayTransferFix('pq', 'MacIntel', 'rec709')).toBe(5);

    // 4. false-color.wgsl uses pure Luma `ireNorm = y;` (no max(r,g,b)*0.992 distortion on warm/skin tones)
    expect(falseColorWgsl).toContain('ireNorm = y;');
    expect(falseColorWgsl).not.toContain('0.992');
  });
});
