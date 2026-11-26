import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  hlgToNits,
  linearToSrgb,
  nitsToPq,
  pqToNits,
  recoverSignalRgbFromWebGpu,
  resolveDisplayTransferFix,
  srgbToLinearSigned,
} from '../src/core/color/transfer';
import { Hud } from '../src/ui/hud';
import { describeSample } from '../src/ui/probe';
import { DEFAULT_STATE } from '../src/ui/settings';

/**
 * Simulates Chromium Dawn's `ExternalTexture` / `copyExternalImageToTexture` transform
 * on hardware-decoded HDR (`PQ` / `HLG`) VideoFrames:
 * Dawn treats PQ/HLG transfer as identity on the normalized `[0..1]` code value `E`,
 * multiplies `E` by `M_primaries_to_srgb` (preserving signed `<0` / `>1` floats),
 * and applies signed `linearToSrgb`.
 */
function simulateDawnHdrExternalTexture(
  pqSignal: [number, number, number],
  primaries: 'rec2020' | 'p3' | 'rec709' = 'rec2020',
): [number, number, number] {
  const [r, g, b] = pqSignal;
  let sr = r;
  let sg = g;
  let sb = b;
  if (primaries === 'rec2020') {
    sr = 1.660491 * r - 0.5876411 * g - 0.0728499 * b;
    sg = -0.1245505 * r + 1.1328999 * g - 0.0083494 * b;
    sb = -0.0181508 * r - 0.1005789 * g + 1.1187297 * b;
  } else if (primaries === 'p3') {
    sr = 1.2249402 * r - 0.2249402 * g;
    sg = -0.0420569 * r + 1.0420569 * g;
    sb = -0.0196376 * r - 0.0786361 * g + 1.0982736 * b;
  }
  const encSigned = (v: number): number => {
    const a = Math.abs(v);
    const enc = a <= 0.0031308 ? a * 12.92 : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
    return v < 0 ? -enc : enc;
  };
  return [encSigned(sr), encSigned(sg), encSigned(sb)];
}

describe('Chromium Dawn HDR ExternalTexture signal recovery & WebGL2 RGBA16F Eyedropper', () => {
  it('losslessly recovers exact [0..1] PQ/HLG codes from Dawn BT.2020 external textures (including out-of-gamut reds)', () => {
    const mode = resolveDisplayTransferFix('pq', 'MacIntel', 'rec2020');
    expect(mode).toBe(3);

    // 1. Exact measured values from YouTube "White Clipping 4K UHD HDR 10 T.V. Calibration"
    //    694-nit bar (71.2% PQ, 10-bit limited code 688):
    //    Dawn rgba16float output measured in ego-browser: [0.85835, 0.86197, 0.85938]
    const rec694 = recoverSignalRgbFromWebGpu([0.85835, 0.86197, 0.85938], mode);
    expect(rec694[0]).toBeCloseTo(0.71, 2);
    expect(rec694[1]).toBeCloseTo(0.713, 2);
    expect(rec694[2]).toBeCloseTo(0.71, 2);
    const yCode = 0.2627 * rec694[0] + 0.678 * rec694[1] + 0.0593 * rec694[2];
    expect(pqToNits(yCode)).toBeGreaterThan(685);
    expect(pqToNits(yCode)).toBeLessThan(702);

    // 2. Full calibration sweep (94 nits .. 4000 nits neutral & pure BT.2020 saturated colors)
    const testNits = [35, 94, 155, 203, 516, 694, 1011, 1419, 4000];
    for (const targetNits of testNits) {
      const pq = nitsToPq(targetNits);
      const dawnOut = simulateDawnHdrExternalTexture([pq, pq, pq], 'rec2020');
      const recovered = recoverSignalRgbFromWebGpu(dawnOut, mode);
      expect(recovered[0]).toBeCloseTo(pq, 5);
      expect(recovered[1]).toBeCloseTo(pq, 5);
      expect(recovered[2]).toBeCloseTo(pq, 5);
      expect(pqToNits(recovered[1])).toBeCloseTo(targetNits, 0);
    }

    // 3. Pure BT.2020 1000-nit red (produces negative G/B and >1.0 R in Dawn's sRGB output!)
    //    Matches Bilibili HDR10 test frame measured in ego-browser: [1.100265, -0.337719, -0.094620]
    const pq1000 = nitsToPq(1000); // ~0.7518
    const dawnPureRed = simulateDawnHdrExternalTexture([pq1000, 0, 0], 'rec2020');
    expect(dawnPureRed[0]).toBeGreaterThan(1.09);
    expect(dawnPureRed[1]).toBeLessThan(-0.33);
    expect(dawnPureRed[2]).toBeLessThan(-0.09);
    expect(srgbToLinearSigned(dawnPureRed[1])).toBeLessThan(0);

    const recRed = recoverSignalRgbFromWebGpu(dawnPureRed, mode);
    expect(recRed[0]).toBeCloseTo(pq1000, 4);
    expect(recRed[1]).toBeCloseTo(0, 4);
    expect(recRed[2]).toBeCloseTo(0, 4);
    expect(pqToNits(recRed[0])).toBeCloseTo(1000, 0);
  });

  it('recovers Display-P3 and BT.709 HDR streams via modes 4 and 5', () => {
    const modeP3 = resolveDisplayTransferFix('pq', 'MacIntel', 'p3');
    expect(modeP3).toBe(4);
    const dawnP3 = simulateDawnHdrExternalTexture([0.75, 0.2, 0.05], 'p3');
    const recP3 = recoverSignalRgbFromWebGpu(dawnP3, modeP3);
    expect(recP3[0]).toBeCloseTo(0.75, 5);
    expect(recP3[1]).toBeCloseTo(0.2, 5);
    expect(recP3[2]).toBeCloseTo(0.05, 5);

    const mode709 = resolveDisplayTransferFix('hlg', 'Win32', 'rec709');
    expect(mode709).toBe(5);
    const dawn709: [number, number, number] = [
      linearToSrgb(0.82),
      linearToSrgb(0.5),
      linearToSrgb(0.1),
    ];
    const rec709 = recoverSignalRgbFromWebGpu(dawn709, mode709);
    expect(rec709[0]).toBeCloseTo(0.82, 5);
    expect(rec709[1]).toBeCloseTo(0.5, 5);
    expect(rec709[2]).toBeCloseTo(0.1, 5);
    expect(hlgToNits(rec709[0])).toBeGreaterThan(300);
  });

  it('Eyedropper describeSample computes exact 694 nits (71.2% PQ) & 10-bit code 688 instead of SDR-tonemapped 3189 nits', () => {
    // User screenshot reproduction on YouTube White Clipping 4K HDR10 (694 nit / 71.2% / code 688):
    // - 2D Canvas SDR tone-mapped display pixel was [238, 245, 240]
    // - WebGL2 RGBA16F readback at (1665, 1404) is [0.7095, 0.7134, 0.7095] (~0.7121 luma)
    const sample = describeSample(
      [238, 245, 240],
      1665,
      1404,
      'bt2020',
      { limited: true, depth: 10 },
      {
        primaries: 'rec2020',
        sourceTransfer: 'pq',
        effectiveTransfer: 'pq',
        sdrWhiteNits: 203,
        videoWidth: 3840,
        videoHeight: 2160,
        hdrSignalRgb: [0.7095, 0.7134, 0.7095],
      },
    );

    // 1. Exact nits (~693-694 nits, NOT 3189 nits!)
    expect(Math.round(sample.nits)).toBeGreaterThanOrEqual(692);
    expect(Math.round(sample.nits)).toBeLessThanOrEqual(695);

    // 2. Exact PQ percentage (~71.2% PQ, NOT 88% PQ!)
    expect(sample.axisY * 100).toBeCloseTo(71.2, 1);

    // 3. Exact 10-bit Limited Range code (~688, NOT 955/983/963!)
    expect(sample.rgb10[0]).toBeGreaterThanOrEqual(685);
    expect(sample.rgb10[0]).toBeLessThanOrEqual(689);
    expect(sample.rgb10[1]).toBeGreaterThanOrEqual(687);
    expect(sample.rgb10[1]).toBeLessThanOrEqual(690);

    // 4. Neutral D65 white chromaticity (~0.3127, 0.3290)
    expect(sample.xy[0]).toBeCloseTo(0.31, 1);
    expect(sample.xy[1]).toBeCloseTo(0.33, 1);

    // 5. Safety fallback: if WebGL2 is unavailable (hdrSignalRgb undefined), never feed
    //    SDR tone-mapped [238, 245, 240] into pqToNits() (which previously yielded 3189 nits!)
    const fallbackSample = describeSample(
      [238, 245, 240],
      1665,
      1404,
      'bt2020',
      { limited: true, depth: 10 },
      {
        primaries: 'rec2020',
        sourceTransfer: 'pq',
        effectiveTransfer: 'pq',
        sdrWhiteNits: 203,
      },
    );
    expect(fallbackSample.nits).toBeLessThanOrEqual(203);
  });

  it('protects #video-scopes-host with !important inline styles against aggressive html > div { display:none !important; width:0 !important } rules', () => {
    const dom = new JSDOM('<!doctype html><html><head><style>html > div { display: none !important; visibility: hidden !important; opacity: 0 !important; width: 0 !important; height: 0 !important; }</style></head><body></body></html>');
    const hud = new Hud(DEFAULT_STATE, {
      onStateChange() {},
      onCellChange() {},
      onCellsReplace() {},
      onLayoutChange() {},
      onPanelsChange() {},
      onClose() {},
      onOpenPip() {},
      onToggleLock() {},
    });
    hud.mount(dom.window.document);
    const host = dom.window.document.getElementById('video-scopes-host')!;
    expect(host).toBeTruthy();
    expect(host.style.getPropertyPriority('display')).toBe('important');
    expect(host.style.getPropertyPriority('visibility')).toBe('important');
    expect(host.style.getPropertyPriority('opacity')).toBe('important');
    expect(host.style.getPropertyPriority('position')).toBe('important');
    expect(host.style.getPropertyPriority('width')).toBe('important');
    expect(host.style.getPropertyPriority('height')).toBe('important');
    expect(dom.window.getComputedStyle(host).display).toBe('block');
    expect(dom.window.getComputedStyle(host).visibility).toBe('visible');
    expect(dom.window.getComputedStyle(host).width).toBe('780px');
    expect(dom.window.getComputedStyle(host).height).toBe('560px');
    hud.unmount();
  });
});
