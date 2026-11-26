import { LUMA, chroma, type MatrixId } from '../core/color/matrices';
import { linearRgbToXyz, xyzToUV, xyzToXY, type PrimariesId } from '../core/color/primaries';
import {
  SDR_DIFFUSE_WHITE_NITS,
  hlgToNits,
  nitsToHlg,
  nitsToPq,
  pqToNits,
  srgbToLinear,
} from '../core/color/transfer';
import { cieViewportFrame, frameToScreen } from '../core/color/cie-frame';
import {
  insideVectorscopeDisc,
  vectorscopeFrame,
  vectorscopeToScreen,
} from '../core/color/vectorscope-frame';
import { codeToAxis, legalBounds, type RangeSpec } from '../core/scale/quantize';
import { axisToUnit, unitSuffix, type EffectiveTransfer, type Unit } from '../core/scale/units';
import { placeTopLayerOverlayHost, renderedVideoBox } from '../content/fullscreen';
import type { ScopeOptions } from '../gpu/scope-renderer';
import { WAVE_PAD, axisToCanvasX, axisToCanvasY } from './graticule';
import type { Locale } from './i18n';
import type { ProbeDisplayConfig } from './settings';

export interface ProbeSample {
  /** Source pixel coordinates. */
  x: number;
  y: number;
  /** Normalized frame coordinates [0..1] for horizontal Waveform / Parade mapping. */
  normX: number;
  normY: number;
  /** 0-255 sRGB as displayed. */
  rgb: [number, number, number];
  /** 0-1023 10-bit normalized RGB values. */
  rgb10: [number, number, number];
  /** Code values derived from the active range. */
  code: [number, number, number];
  /** #RRGGBB display color hex. */
  hex: string;
  luma: number;
  cb: number;
  cr: number;
  /** IRE value (0..100 for legal SDR span). */
  ire: number;
  /** Luminance in cd/m² (nits), honoring SDR diffuse white or HDR PQ/HLG EOTF. */
  nits: number;
  /** CIE 1931 (x, y) chromaticity coordinates. */
  xy: [number, number];
  /** CIE 1976 (u', v') chromaticity coordinates. */
  uv: [number, number];
  /** Axis positions 0..1 for drawing scope rings. */
  axisY: number;
  axisR: number;
  axisG: number;
  axisB: number;
  axisU: number;
  axisV: number;
  axisCb: number;
  axisCr: number;
}

export interface SampleContext {
  primaries?: PrimariesId;
  effectiveTransfer?: EffectiveTransfer;
  sourceTransfer?: EffectiveTransfer;
  sdrWhiteNits?: number;
  videoWidth?: number;
  videoHeight?: number;
  /** Optional unclamped linear/float RGB [0..1+] from GPU rgba16float readback. */
  floatRgb?: [number, number, number];
}

function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
}

/**
 * Compute the full colorimetry & scope-axis readout for one video pixel.
 * Backward-compatible 5-arg signature preserved for unit tests, with optional
 * HDR / primaries / dimensions context for live Eyedropper inspection.
 */
export function describeSample(
  rgb: [number, number, number],
  x: number,
  y: number,
  matrix: MatrixId,
  range: RangeSpec,
  ctx: SampleContext = {},
): ProbeSample {
  const c = LUMA[matrix];
  const primaries: PrimariesId = ctx.primaries ?? (matrix === 'bt2020' ? 'rec2020' : 'rec709');
  const effTr: EffectiveTransfer = ctx.effectiveTransfer ?? 'sdr';
  const srcTr: EffectiveTransfer = ctx.sourceTransfer ?? 'sdr';
  const sdrWhite = ctx.sdrWhiteNits ?? SDR_DIFFUSE_WHITE_NITS;

  const fn: [number, number, number] = ctx.floatRgb ?? [
    rgb[0] / 255,
    rgb[1] / 255,
    rgb[2] / 255,
  ];
  const nClamped: [number, number, number] = [
    Math.min(1, Math.max(0, fn[0])),
    Math.min(1, Math.max(0, fn[1])),
    Math.min(1, Math.max(0, fn[2])),
  ];

  const bounds = legalBounds(range);
  const toCode = (v: number): number => bounds.black + (bounds.white - bounds.black) * v;
  const { cb, cr } = chroma(nClamped[0], nClamped[1], nClamped[2], c);
  const luma = c.kr * nClamped[0] + c.kg * nClamped[1] + c.kb * nClamped[2];

  let axisR = codeToAxis(toCode(nClamped[0]), range.depth);
  let axisG = codeToAxis(toCode(nClamped[1]), range.depth);
  let axisB = codeToAxis(toCode(nClamped[2]), range.depth);
  let axisY = codeToAxis(toCode(luma), range.depth);

  let linRgb: [number, number, number];
  let nits: number;

  if (srcTr !== 'sdr' && ctx.floatRgb) {
    // Extended float sRGB from HDR VideoFrame: linear 1.0 = sdrWhite nits
    const lr = Math.max(0, srgbToLinear(fn[0]));
    const lg = Math.max(0, srgbToLinear(fn[1]));
    const lb = Math.max(0, srgbToLinear(fn[2]));
    linRgb = [lr, lg, lb];
    const nR = lr * sdrWhite;
    const nG = lg * sdrWhite;
    const nB = lb * sdrWhite;
    nits = c.kr * nR + c.kg * nG + c.kb * nB;
    if (effTr === 'pq') {
      axisR = nitsToPq(nR);
      axisG = nitsToPq(nG);
      axisB = nitsToPq(nB);
      axisY = c.kr * axisR + c.kg * axisG + c.kb * axisB;
    } else if (effTr === 'hlg') {
      axisR = nitsToHlg(nR);
      axisG = nitsToHlg(nG);
      axisB = nitsToHlg(nB);
      axisY = c.kr * axisR + c.kg * axisG + c.kb * axisB;
    }
  } else if (effTr === 'pq') {
    const nR = pqToNits(axisR);
    const nG = pqToNits(axisG);
    const nB = pqToNits(axisB);
    nits = pqToNits(axisY);
    linRgb = [nR / sdrWhite, nG / sdrWhite, nB / sdrWhite];
  } else if (effTr === 'hlg') {
    const nR = hlgToNits(axisR);
    const nG = hlgToNits(axisG);
    const nB = hlgToNits(axisB);
    nits = hlgToNits(axisY);
    linRgb = [nR / sdrWhite, nG / sdrWhite, nB / sdrWhite];
  } else {
    linRgb = [
      Math.max(0, srgbToLinear(nClamped[0])),
      Math.max(0, srgbToLinear(nClamped[1])),
      Math.max(0, srgbToLinear(nClamped[2])),
    ];
    nits = (c.kr * linRgb[0] + c.kg * linRgb[1] + c.kb * linRgb[2]) * sdrWhite;
  }

  const xyz = linearRgbToXyz(linRgb, primaries);
  const sum = xyz[0] + xyz[1] + xyz[2];
  const xy: [number, number] = sum > 1e-6 ? xyzToXY(xyz) : [0.3127, 0.329];
  const uv: [number, number] = sum > 1e-6 ? xyzToUV(xyz) : [0.1978, 0.4683];

  const vw = Math.max(1, ctx.videoWidth ?? 1);
  const vh = Math.max(1, ctx.videoHeight ?? 1);
  const ire = luma * 100;

  return {
    x,
    y,
    normX: ctx.videoWidth ? Math.min(1, Math.max(0, (x + 0.5) / vw)) : 0.5,
    normY: ctx.videoHeight ? Math.min(1, Math.max(0, (y + 0.5) / vh)) : 0.5,
    rgb,
    rgb10: [
      Math.round(nClamped[0] * 1023),
      Math.round(nClamped[1] * 1023),
      Math.round(nClamped[2] * 1023),
    ],
    code: [toCode(nClamped[0]), toCode(nClamped[1]), toCode(nClamped[2])],
    hex: `#${toHexByte(rgb[0])}${toHexByte(rgb[1])}${toHexByte(rgb[2])}`,
    luma,
    cb,
    cr,
    ire,
    nits,
    xy,
    uv,
    axisY,
    axisR,
    axisG,
    axisB,
    axisU: Math.min(1, Math.max(0, 0.5 + cb)),
    axisV: Math.min(1, Math.max(0, 0.5 + cr)),
    axisCb: cb + 0.5,
    axisCr: cr + 0.5,
  };
}

export function formatSample(s: ProbeSample, unit: Unit, range: RangeSpec): string {
  const codeStr = s.code.map((v) => Math.round(v)).join(',');
  const effUnit = unit === 'auto' ? 'ire' : unit;
  const yValue = Math.round(axisToUnit(s.axisY, effUnit, range));
  const suffix = unitSuffix(effUnit);
  const unitPart = suffix ? ` ${suffix}` : '';
  return `Y ${yValue}${unitPart} · code ${codeStr} · Cb ${s.cb.toFixed(3)} Cr ${s.cr.toFixed(3)} · (${s.x},${s.y})`;
}

// ---------------------------------------------------------------------------
// Floating Cursor Readout Tooltip (#video-scopes-cursor-probe)
// ---------------------------------------------------------------------------

const TOOLTIP_ID = 'video-scopes-cursor-probe';

function setTipImp(el: HTMLElement, prop: string, val: string): void {
  el.style.setProperty(prop, val, 'important');
}

export class CursorProbeTooltip {
  private host: HTMLDivElement | null = null;
  private card: HTMLDivElement | null = null;
  private visible = false;

  private ensureMounted(forceRestack = false): void {
    if (this.host) {
      placeTopLayerOverlayHost(this.host, forceRestack);
      return;
    }
    for (const stale of Array.from(document.querySelectorAll(`#${TOOLTIP_ID}`))) {
      stale.remove();
    }
    const host = document.createElement('div');
    host.id = TOOLTIP_ID;
    const baseProps: Array<[string, string]> = [
      ['position', 'fixed'],
      ['inset', 'auto'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['background', 'transparent'],
      ['left', '0px'],
      ['top', '0px'],
      ['pointer-events', 'none'],
      ['z-index', '2147483647'],
      ['overflow', 'visible'],
      ['visibility', 'visible'],
      ['opacity', '1'],
      ['transform', 'none'],
      ['filter', 'none'],
      ['max-width', 'none'],
      ['max-height', 'none'],
    ];
    for (const [k, v] of baseProps) {
      setTipImp(host, k, v);
    }
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .card {
        background: rgba(11, 15, 20, 0.92);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 6px;
        padding: 6px 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(8px);
        font: 10.5px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #e2ecf5;
        min-width: 148px;
        white-space: nowrap;
      }
      .top {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 3px; padding-bottom: 3px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }
      .swatch {
        width: 11px; height: 11px; border-radius: 2px;
        border: 1px solid rgba(255, 255, 255, 0.45); flex: 0 0 auto;
      }
      .row { display: flex; justify-content: space-between; gap: 10px; }
      .k { color: #7f93a4; }
      .v { color: #eef6fc; font-weight: 500; }
      .v.hdr { color: #7dd3fc; }
      .r { color: #ff7b7b; } .g { color: #6ee787; } .b { color: #79b8ff; }
    `;
    const card = document.createElement('div');
    card.className = 'card';
    shadow.appendChild(style);
    shadow.appendChild(card);

    this.host = host;
    this.card = card;
    placeTopLayerOverlayHost(host, true);
  }

  show(
    clientX: number,
    clientY: number,
    s: ProbeSample,
    cfg: ProbeDisplayConfig,
    effTransfer: EffectiveTransfer,
    lang: Locale,
  ): void {
    if (!cfg.showTooltip) {
      this.hide();
      return;
    }
    const wasHidden = !this.visible;
    this.ensureMounted(wasHidden);
    if (!this.host || !this.card) return;

    const doc = this.card.ownerDocument;
    const zh = lang === 'zh';
    const topBits: string[] = [];
    if (cfg.showCoords) topBits.push(`(${s.x}, ${s.y})`);
    if (cfg.showHex) topBits.push(s.hex);

    const rowNodes: HTMLDivElement[] = [];
    const addTextRow = (label: string, valText: string, hdr = false): void => {
      const r = doc.createElement('div');
      r.className = 'row';
      const k = doc.createElement('span');
      k.className = 'k';
      k.textContent = label;
      const v = doc.createElement('span');
      v.className = hdr ? 'v hdr' : 'v';
      v.textContent = valText;
      r.append(k, v);
      rowNodes.push(r);
    };
    const addRgbRow = (label: string, vals: [number, number, number]): void => {
      const r = doc.createElement('div');
      r.className = 'row';
      const k = doc.createElement('span');
      k.className = 'k';
      k.textContent = label;
      const v = doc.createElement('span');
      v.className = 'v';
      const sr = doc.createElement('span');
      sr.className = 'r';
      sr.textContent = String(vals[0]);
      const sg = doc.createElement('span');
      sg.className = 'g';
      sg.textContent = String(vals[1]);
      const sb = doc.createElement('span');
      sb.className = 'b';
      sb.textContent = String(vals[2]);
      v.append(sr, doc.createTextNode(' '), sg, doc.createTextNode(' '), sb);
      r.append(k, v);
      rowNodes.push(r);
    };

    if (cfg.showRgb8) addRgbRow('RGB 8b', s.rgb);
    if (cfg.showRgb10) addRgbRow('RGB 10b', s.rgb10);
    if (cfg.showLuma) {
      const nitsStr = s.nits >= 100 ? `${Math.round(s.nits)}` : s.nits.toFixed(1);
      if (effTransfer !== 'sdr') {
        const sigPct = Math.round(s.axisY * 100);
        const trTag = effTransfer === 'pq' ? 'PQ' : 'HLG';
        addTextRow(zh ? '亮度' : 'Luma', `${nitsStr} nits (${sigPct}% ${trTag})`, true);
      } else {
        addTextRow(zh ? '亮度' : 'Luma', `${s.ire.toFixed(1)} IRE · ${nitsStr}n`, false);
      }
    }
    if (cfg.showXy) {
      addTextRow('CIE xy', `${s.xy[0].toFixed(4)}, ${s.xy[1].toFixed(4)}`);
    }
    if (cfg.showUv) {
      addTextRow("CIE u'v'", `${s.uv[0].toFixed(4)}, ${s.uv[1].toFixed(4)}`);
    }
    if (cfg.showYuv) {
      const cbStr = (s.cb >= 0 ? '+' : '') + s.cb.toFixed(3);
      const crStr = (s.cr >= 0 ? '+' : '') + s.cr.toFixed(3);
      addTextRow('Cb / Cr', `${cbStr}, ${crStr}`);
    }

    if (topBits.length === 0 && rowNodes.length === 0) {
      this.hide();
      return;
    }

    this.card.textContent = '';
    const top = doc.createElement('div');
    top.className = 'top';
    const swatch = doc.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = s.hex;
    const headTxt = doc.createElement('span');
    headTxt.textContent = topBits.length ? topBits.join(' · ') : zh ? '当前像素' : 'Pixel';
    top.append(swatch, headTxt);
    this.card.appendChild(top);
    for (const rn of rowNodes) {
      this.card.appendChild(rn);
    }

    setTipImp(this.host, 'display', 'block');
    setTipImp(this.host, 'visibility', 'visible');
    setTipImp(this.host, 'opacity', '1');
    this.visible = true;

    // Smart edge-aware positioning so tooltip never leaves the viewport
    const cardW = this.card.offsetWidth || 180;
    const cardH = this.card.offsetHeight || 96;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = clientX + 16;
    let topPx = clientY + 16;
    if (left + cardW + 8 > vw) left = Math.max(8, clientX - cardW - 14);
    if (topPx + cardH + 8 > vh) topPx = Math.max(8, clientY - cardH - 14);
    const rawZoom = Number((this.host as unknown as { currentCSSZoom?: number }).currentCSSZoom);
    const z = Number.isFinite(rawZoom) && rawZoom > 0.05 ? rawZoom : 1;
    setTipImp(this.host, 'left', `${Math.round(left / z)}px`);
    setTipImp(this.host, 'top', `${Math.round(topPx / z)}px`);
  }

  hide(): void {
    this.visible = false;
    if (this.host) {
      setTipImp(this.host, 'display', 'none');
    }
  }

  destroy(): void {
    if (this.host) {
      const anyHost = this.host as HTMLElement & { hidePopover?: () => void };
      try {
        anyHost.hidePopover?.();
      } catch {
        // Ignore
      }
      this.host.remove();
      this.host = null;
      this.card = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Synchronized Scope Ring Marker Drawing (renders onto per-cell canvas.marker)
// ---------------------------------------------------------------------------

function drawRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  strokeColor: string,
  radius = 5.5,
): void {
  // Dark outer contrast halo so the ring pops clearly over dense bright white traces
  ctx.beginPath();
  ctx.arc(x, y, radius + 1.2, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.88)';
  ctx.lineWidth = 2.6;
  ctx.stroke();

  // Crisp colored / white target ring
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.7;
  ctx.stroke();

  // Subtle center pip
  ctx.beginPath();
  ctx.arc(x, y, 1.3, 0, Math.PI * 2);
  ctx.fillStyle = strokeColor;
  ctx.fill();
}

/**
 * Draw synchronized Eyedropper ring(s) onto a scope cell's `canvas.marker`
 * (`w` and `h` in CSS pixels, matching `drawGraticule`).
 */
export function drawScopeProbeRings(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions,
  sample: ProbeSample | null,
): void {
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);
  if (!sample) return;

  const zoom = Math.max(1, o.zoom || 1);
  const maxPan = Math.max(0, 1 - 1 / zoom);
  const panX = Math.min(maxPan, Math.max(0, o.panX ?? 0));
  const panY = Math.min(maxPan, Math.max(0, o.panY ?? 0));

  ctx.save();

  if (o.mode === 'vectorscope') {
    const vf = vectorscopeFrame(w, h, zoom, o.panX ?? 0, o.panY ?? 0);
    const [px, py] = vectorscopeToScreen(vf, sample.cb, sample.cr);
    if (insideVectorscopeDisc(vf, px, py, 2)) {
      drawRing(ctx, px, py, '#ffdf6b', 6);
    }
    ctx.restore();
    return;
  }

  if (o.mode === 'cie') {
    const cf = cieViewportFrame(w, h, o.coord, zoom, o.panX, o.panY, 1);
    const pt = o.coord === 'uv' ? sample.uv : sample.xy;
    const [px, py] = frameToScreen(cf, pt[0], pt[1]);
    if (px >= 4 && px <= w - 4 && py >= 18 && py <= h - 4) {
      drawRing(ctx, px, py, '#ffdf6b', 6);
    }
    ctx.restore();
    return;
  }

  const plotL = WAVE_PAD.left;
  const plotT = WAVE_PAD.top;
  const plotW = Math.max(8, w - WAVE_PAD.left - WAVE_PAD.right);
  const plotH = Math.max(8, h - WAVE_PAD.top - WAVE_PAD.bottom);

  ctx.beginPath();
  ctx.rect(plotL - 2, plotT - 2, plotW + 4, plotH + 4);
  ctx.clip();

  if (o.mode === 'histogram') {
    const hm = o.histMode ?? 'YRGB';
    const items: Array<[number, string, number]> =
      hm === 'Y'
        ? [[sample.axisY, '#ffdf6b', 0.5]]
        : hm === 'RGB'
          ? [
              [sample.axisR, '#ff6b6b', 0.35],
              [sample.axisG, '#51cf66', 0.5],
              [sample.axisB, '#5c9eff', 0.65],
            ]
          : hm === 'YUV'
            ? [
                [sample.axisY, '#f1f5f9', 0.35],
                [sample.axisU, '#38bdf8', 0.5],
                [sample.axisV, '#f472b6', 0.65],
              ]
            : [
                [sample.axisY, '#f8fafc', 0.28],
                [sample.axisR, '#ff6b6b', 0.44],
                [sample.axisG, '#51cf66', 0.60],
                [sample.axisB, '#5c9eff', 0.76],
              ];

    for (const [axisVal, col, yFrac] of items) {
      const norm = (axisVal - panX) * zoom;
      if (norm < 0 || norm > 1) continue;
      const px = axisToCanvasX(axisVal, plotL, plotW, zoom, panX);
      ctx.beginPath();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.moveTo(px, plotT);
      ctx.lineTo(px, plotT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      drawRing(ctx, px, plotT + plotH * yFrac, col, 4.5);
    }
    ctx.restore();
    return;
  }

  // Waveform & Parade: horizontal axis tracks video X (`sample.normX`)
  const normVisX = (sample.normX - panX) * zoom;
  if (normVisX < 0 || normVisX > 1) {
    ctx.restore();
    return;
  }

  const drawAt = (px: number, axisVal: number, color: string, r = 5.2): void => {
    const normVisY = (axisVal - panY) * zoom;
    if (normVisY < -0.02 || normVisY > 1.02) return;
    const py = axisToCanvasY(axisVal, plotT, plotH, zoom, panY);
    drawRing(ctx, px, py, color, r);
  };

  if (o.mode === 'waveform-parade') {
    const pm = o.paradeMode ?? 'RGB';
    const slices: Array<[number, string]> =
      pm === 'YRGB'
        ? [
            [sample.axisY, '#f8fafc'],
            [sample.axisR, '#ff6b6b'],
            [sample.axisG, '#51cf66'],
            [sample.axisB, '#5c9eff'],
          ]
        : pm === 'YUV'
          ? [
              [sample.axisY, '#f8fafc'],
              [sample.axisU, '#38bdf8'],
              [sample.axisV, '#f472b6'],
            ]
          : [
              [sample.axisR, '#ff6b6b'],
              [sample.axisG, '#51cf66'],
              [sample.axisB, '#5c9eff'],
            ];
    const sliceW = plotW / slices.length;
    for (let s = 0; s < slices.length; s++) {
      const [val, color] = slices[s]!;
      const px = plotL + s * sliceW + normVisX * sliceW;
      drawAt(px, val, color, 5.0);
    }
  } else {
    // Waveform
    const px = plotL + normVisX * plotW;
    const wc = o.waveChannels ?? (o.mode === 'waveform-rgb' ? 'RGB' : 'Y');
    if (wc === 'Y') {
      drawAt(px, sample.axisY, '#ffdf6b', 5.8);
    } else if (wc === 'R') {
      drawAt(px, sample.axisR, '#ff6b6b', 5.8);
    } else if (wc === 'G') {
      drawAt(px, sample.axisG, '#51cf66', 5.8);
    } else if (wc === 'B') {
      drawAt(px, sample.axisB, '#5c9eff', 5.8);
    } else if (wc === 'RGB') {
      drawAt(px, sample.axisR, '#ff6b6b', 5.0);
      drawAt(px, sample.axisG, '#51cf66', 5.0);
      drawAt(px, sample.axisB, '#5c9eff', 5.0);
    } else if (wc === 'YUV') {
      drawAt(px, sample.axisY, '#f8fafc', 5.0);
      drawAt(px, sample.axisU, '#38bdf8', 5.0);
      drawAt(px, sample.axisV, '#f472b6', 5.0);
    } else {
      // YRGB
      drawAt(px, sample.axisY, '#f8fafc', 5.2);
      drawAt(px, sample.axisR, '#ff6b6b', 4.8);
      drawAt(px, sample.axisG, '#51cf66', 4.8);
      drawAt(px, sample.axisB, '#5c9eff', 4.8);
    }
  }

  ctx.restore();
}

/** Legacy helper kept for backward compatibility. */
export function drawProbeCrosshair(
  ctx: CanvasRenderingContext2D,
  mode: 'waveform-luma' | 'waveform-rgb' | 'waveform-parade' | 'vectorscope' | 'cie',
  sample: ProbeSample,
  plot: { left: number; top: number; width: number; height: number },
): void {
  const color = '#ffcf6e';
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);

  if (mode === 'vectorscope') {
    const cx = plot.left + sample.axisCb * plot.width;
    const cy = plot.top + (1 - sample.axisCr) * plot.height;
    ctx.beginPath();
    ctx.moveTo(plot.left, cy);
    ctx.lineTo(plot.left + plot.width, cy);
    ctx.moveTo(cx, plot.top);
    ctx.lineTo(cx, plot.top + plot.height);
    ctx.stroke();
  } else {
    const cy = plot.top + (1 - sample.axisY) * plot.height;
    ctx.beginPath();
    ctx.moveTo(plot.left, cy);
    ctx.lineTo(plot.left + plot.width, cy);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Interactive Eyedropper / Pixel Probe Controller
// ---------------------------------------------------------------------------

export interface ProbeRuntimeState {
  eyedropperEnabled: boolean;
  matrix: MatrixId;
  primaries: PrimariesId;
  range: RangeSpec;
  effectiveTransfer: EffectiveTransfer;
  sourceTransfer: EffectiveTransfer;
  sdrWhiteNits: number;
  hudHostId: string;
}

/**
 * Samples the pixel under the mouse cursor across the rendered `<video>` box.
 * Works through player control overlays and false-color overlays via window-level
 * capture listeners, activating when `eyedropperEnabled` is ON or `Alt` is held.
 */
export class Probe {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private pqCanvas: HTMLCanvasElement | null = null;
  private pqCtx: CanvasRenderingContext2D | null | undefined = undefined;
  private video: HTMLVideoElement | null = null;
  private active = false;
  private lastEmit = 0;
  private lastClientX = -1;
  private lastClientY = -1;
  private cursorApplied = false;

  constructor(
    private readonly onSample: (s: ProbeSample | null, clientX: number, clientY: number) => void,
    private readonly getState: () => ProbeRuntimeState,
  ) {
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  enable(video: HTMLVideoElement): void {
    this.video = video;
    if (this.active) return;
    this.active = true;
    window.addEventListener('pointermove', this.handleMove, { capture: true, passive: true });
    window.addEventListener('scroll', this.handleScroll, { capture: true, passive: true });
    document.addEventListener('mouseleave', this.handleClear);
    window.addEventListener('blur', this.handleClear);
    window.addEventListener('keyup', this.handleKeyUp, { passive: true });
    this.syncVideoCursor();
  }

  disable(video?: HTMLVideoElement): void {
    if (video && this.video === video) {
      this.restoreVideoCursor();
      this.video = null;
    } else if (!video) {
      this.restoreVideoCursor();
      this.video = null;
    }
    if (!this.active) return;
    this.active = false;
    window.removeEventListener('pointermove', this.handleMove, true);
    window.removeEventListener('scroll', this.handleScroll, true);
    document.removeEventListener('mouseleave', this.handleClear);
    window.removeEventListener('blur', this.handleClear);
    window.removeEventListener('keyup', this.handleKeyUp);
    this.onSample(null, 0, 0);
  }

  syncMode(): void {
    this.syncVideoCursor();
    const st = this.getState();
    if (!st.eyedropperEnabled) {
      this.onSample(null, 0, 0);
    } else if (this.lastClientX >= 0 && this.lastClientY >= 0) {
      this.sampleAt(this.lastClientX, this.lastClientY, true);
    }
  }

  /** Refresh readout if video frame updates while mouse is held steady over the picture. */
  refreshAtLastPointer(): void {
    if (!this.active || this.lastClientX < 0 || this.lastClientY < 0) return;
    const st = this.getState();
    if (!st.eyedropperEnabled) return;
    const now = performance.now();
    if (now - this.lastEmit < 90) return;
    this.sampleAt(this.lastClientX, this.lastClientY, false);
  }

  private syncVideoCursor(): void {
    if (!this.video) return;
    const want = this.getState().eyedropperEnabled;
    if (want && !this.cursorApplied) {
      this.video.style.cursor = 'crosshair';
      this.cursorApplied = true;
    } else if (!want && this.cursorApplied) {
      this.video.style.cursor = '';
      this.cursorApplied = false;
    }
  }

  private restoreVideoCursor(): void {
    if (this.video && this.cursorApplied) {
      this.video.style.cursor = '';
    }
    this.cursorApplied = false;
  }

  private handleClear = (): void => {
    this.lastClientX = -1;
    this.lastClientY = -1;
    this.onSample(null, 0, 0);
  };

  private handleKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Alt' && !this.getState().eyedropperEnabled) {
      this.onSample(null, 0, 0);
    }
  };

  private handleScroll = (): void => {
    if (this.getState().eyedropperEnabled && this.lastClientX >= 0) {
      this.sampleAt(this.lastClientX, this.lastClientY, false);
    }
  };

  private handleMove = (e: PointerEvent): void => {
    const st = this.getState();
    this.syncVideoCursor();

    if (!st.eyedropperEnabled && !e.altKey) {
      return;
    }

    // Ignore pointer events over our own Scopes HUD panel
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const node of path) {
      if (node instanceof HTMLElement && node.id === st.hudHostId) {
        this.onSample(null, 0, 0);
        return;
      }
    }

    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

    const now = performance.now();
    if (now - this.lastEmit < 28) return;
    this.sampleAt(e.clientX, e.clientY, true);
  };

  private sampleAt(clientX: number, clientY: number, fromMove: boolean): void {
    const video = this.video;
    if (!video || !this.ctx) return;

    const box = renderedVideoBox(video);
    if (!box) {
      this.onSample(null, 0, 0);
      return;
    }

    if (
      clientX < box.left ||
      clientX > box.left + box.width ||
      clientY < box.top ||
      clientY > box.top + box.height
    ) {
      if (fromMove) this.onSample(null, 0, 0);
      return;
    }

    const u = (clientX - box.left) / box.width;
    const v = (clientY - box.top) / box.height;
    const x = Math.min(video.videoWidth - 1, Math.max(0, Math.floor(box.cropX + u * box.cropW)));
    const y = Math.min(video.videoHeight - 1, Math.max(0, Math.floor(box.cropY + v * box.cropH)));

    this.lastEmit = performance.now();
    try {
      const st = this.getState();
      this.ctx.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
      const d = this.ctx.getImageData(0, 0, 1, 1).data;

      // For true HDR VideoFrames on Chromium, sample via a rec2100-pq 2D canvas when supported
      // so getImageData preserves true >203-nit HDR highlights instead of SDR tone-mapping!
      let hdrFloatRgb: [number, number, number] | undefined;
      if (st.sourceTransfer !== 'sdr') {
        if (this.pqCtx === undefined) {
          try {
            this.pqCanvas = document.createElement('canvas');
            this.pqCanvas.width = 1;
            this.pqCanvas.height = 1;
            this.pqCtx = this.pqCanvas.getContext('2d', {
              colorSpace: 'rec2100-pq' as PredefinedColorSpace,
              willReadFrequently: true,
            });
          } catch {
            this.pqCtx = null;
          }
        }
        if (this.pqCtx) {
          this.pqCtx.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
          const pq = this.pqCtx.getImageData(0, 0, 1, 1).data;
          const sdrW = st.sdrWhiteNits || SDR_DIFFUSE_WHITE_NITS;
          // Convert true PQ nits into linear extended-sRGB units (1.0 = sdrWhiteNits)
          const linR = pqToNits(pq[0]! / 255) / sdrW;
          const linG = pqToNits(pq[1]! / 255) / sdrW;
          const linB = pqToNits(pq[2]! / 255) / sdrW;
          // Pass via floatRgb using linear->extended-srgb encoding expected by srgbToLinear
          const toExtSrgb = (l: number): number =>
            l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
          hdrFloatRgb = [toExtSrgb(linR), toExtSrgb(linG), toExtSrgb(linB)];
        }
      }

      const sample = describeSample([d[0]!, d[1]!, d[2]!], x, y, st.matrix, st.range, {
        primaries: st.primaries,
        effectiveTransfer: st.effectiveTransfer,
        sourceTransfer: st.sourceTransfer,
        sdrWhiteNits: st.sdrWhiteNits,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        floatRgb: hdrFloatRgb,
      });
      this.onSample(sample, clientX, clientY);
    } catch {
      // Cross-origin tainted video: avoid throwing or displaying stale numbers
      this.onSample(null, 0, 0);
    }
  }
}
