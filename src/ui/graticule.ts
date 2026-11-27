import { LUMA, SKIN_TONE_ANGLE_DEG, chromaTargets } from '../core/color/matrices';
import { CIE1931_LOCUS, SPECTRAL_WAVELENGTHS, gamutTriangle } from '../core/color/locus';
import { smoothOpenSpline } from '../core/color/spline';
import { SDR_DIFFUSE_WHITE_NITS, linearToSrgb, xyToLinearSrgb } from '../core/color/transfer';
import type { PrimariesId } from '../core/color/primaries';
import {
  formatTickLabel,
  legalBands,
  nitsToAxisForTransfer,
  resolveEffectiveUnit,
  resolveHdrZoneThresholds,
  tickValues,
  unitSuffix,
} from '../core/scale/units';
import {
  cieFrame,
  cieViewportFrame,
  frameToScreen,
  screenToFrame,
  type CieFrame,
} from '../core/color/cie-frame';
import {
  vectorscopeFrame,
  vectorscopeToScreen,
} from '../core/color/vectorscope-frame';
import type { GraticuleTheme, ScopeOptions } from '../gpu/scope-renderer';

export type { GraticuleTheme };

export const WAVE_PAD = { top: 14, right: 10, bottom: 22, left: 44 } as const;

interface Palette {
  grid: string;
  gridMajor: string;
  legal: string;
  band: string;
  text: string;
  tagBg: string;
  statusBg: string;
  midLine: string;
  paradeMid: string;
  locus: string;
  whitePoint: string;
}

/**
 * Screen palette: tuned against the dark HUD panel (#0a0e12).
 * Light palette: dark slate ink so the same graticule reads on a white page,
 * a slide, or a transparent export dropped onto a light document.
 */
const DARK_PALETTE: Palette = {
  grid: '#1b232b',
  gridMajor: '#33414d',
  legal: '#5d7f93',
  band: 'rgba(255,255,255,0.035)',
  text: '#7d8b96',
  tagBg: 'rgba(11, 15, 18, 0.82)',
  statusBg: 'rgba(10, 14, 20, 0.78)',
  midLine: '#3b5163',
  paradeMid: '#486378',
  locus: '#4a5a66',
  whitePoint: '#e8e8e8',
};

const LIGHT_PALETTE: Palette = {
  grid: 'rgba(71, 85, 105, 0.28)',
  gridMajor: 'rgba(51, 65, 85, 0.62)',
  legal: '#64748b',
  band: 'rgba(100, 116, 139, 0.09)',
  text: '#475569',
  tagBg: 'rgba(255, 255, 255, 0.86)',
  statusBg: 'rgba(255, 255, 255, 0.86)',
  midLine: '#94a3b8',
  paradeMid: '#94a3b8',
  locus: '#64748b',
  whitePoint: '#334155',
};

function usePalette(p: Palette): void {
  GRID = p.grid;
  GRID_MAJOR = p.gridMajor;
  LEGAL = p.legal;
  BAND = p.band;
  TEXT = p.text;
  TAG_BG = p.tagBg;
  STATUS_BG = p.statusBg;
  MID_LINE = p.midLine;
  PARADE_MID = p.paradeMid;
  LOCUS_STROKE = p.locus;
  WHITE_POINT = p.whitePoint;
}

/**
 * Run `fn` with one palette installed, restoring the screen palette afterwards
 * even if a draw throws. Used by `drawGraticule`; kept private so callers can
 * never leave the overlay tinted for export.
 */
function withPalette<T>(theme: GraticuleTheme | undefined, fn: () => T): T {
  const prev: Palette = {
    grid: GRID,
    gridMajor: GRID_MAJOR,
    legal: LEGAL,
    band: BAND,
    text: TEXT,
    tagBg: TAG_BG,
    statusBg: STATUS_BG,
    midLine: MID_LINE,
    paradeMid: PARADE_MID,
    locus: LOCUS_STROKE,
    whitePoint: WHITE_POINT,
  };
  usePalette(theme === 'light' ? LIGHT_PALETTE : DARK_PALETTE);
  try {
    return fn();
  } finally {
    usePalette(prev);
  }
}

/**
 * Graticule ink colours.
 *
 * These are `let` bindings rather than `const` because the exporter re-renders
 * one panel off-screen on a light or transparent background: dark grey-on-black
 * ink is invisible there. `drawGraticule` swaps the whole set for the duration
 * of a single synchronous draw (see `withPalette`) and always restores it, so
 * the live overlay never sees the export palette. Every draw entry point is
 * synchronous, so no interleaving is possible.
 */
let GRID = '#1b232b';
let GRID_MAJOR = '#33414d';
let LEGAL = '#5d7f93';
let BAND = 'rgba(255,255,255,0.035)';
let TEXT = '#7d8b96';
/** Chip behind HDR threshold tags, and behind the vectorscope status text. */
let TAG_BG = 'rgba(11, 15, 18, 0.82)';
let STATUS_BG = 'rgba(10, 14, 20, 0.78)';
/** The 50% reference lines and the CIE spectral locus / white point. */
let MID_LINE = '#3b5163';
let PARADE_MID = '#486378';
let LOCUS_STROKE = '#4a5a66';
let WHITE_POINT = '#e8e8e8';
const HDR_REF_WHITE_COLOR = '#facc15';
const NIT_LOW_COLOR = '#38bdf8';
const NIT_WARN_COLOR = '#facc15';
const NIT_HIGH_COLOR = '#f87171';
const NIT_PEAK_BAND = 'rgba(239, 68, 68, 0.085)';
const NIT_WARN_BAND = 'rgba(250, 204, 21, 0.06)';
const NIT_SDR_BAND = 'rgba(52, 211, 153, 0.035)';
const NIT_SHADOW_BAND = 'rgba(56, 189, 248, 0.045)';

export function axisToCanvasY(
  axis: number,
  plotTop: number,
  plotHeight: number,
  zoom = 1,
  panY = 0,
): number {
  const clamped = Math.min(1, Math.max(0, (axis - panY) * zoom));
  return plotTop + plotHeight * (1 - clamped);
}

export function canvasYToAxis(
  y: number,
  plotTop: number,
  plotHeight: number,
  zoom = 1,
  panY = 0,
): number {
  const rel = 1 - (y - plotTop) / plotHeight;
  return panY + Math.min(1, Math.max(0, rel)) / zoom;
}

export function axisToCanvasX(
  axis: number,
  plotLeft: number,
  plotWidth: number,
  zoom = 1,
  panX = 0,
): number {
  const clamped = Math.min(1, Math.max(0, (axis - panX) * zoom));
  return plotLeft + plotWidth * clamped;
}

function formatNitBadge(nits: number): string {
  if (nits >= 1000) {
    return `${+(nits / 1000).toFixed(nits % 1000 === 0 ? 0 : 1)}k`;
  }
  return `${Math.round(nits)}n`;
}

function drawHdrThresholdLinesY(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions,
  plotLeft: number,
  plotTop: number,
  plotW: number,
  plotH: number,
  zoom: number,
  panY: number,
): void {
  const effTransfer = o.effectiveTransfer ?? 'sdr';
  const effUnit = resolveEffectiveUnit(o.units, effTransfer);
  const isHdrScale = effTransfer !== 'sdr' || effUnit === 'nits' || effUnit === 'hlg';
  const showZones = o.traceMode === 'hdr-zones' || isHdrScale;
  if (!showZones) return;

  const sdrWhite = o.sdrWhiteNits ?? SDR_DIFFUSE_WHITE_NITS;
  const zones = resolveHdrZoneThresholds(o.nitLow ?? 100, o.nitHigh ?? 1000, sdrWhite);
  const nitLow = zones.nitLow;
  const nitHigh = zones.nitHigh;
  const axisLow = nitsToAxisForTransfer(nitLow, effTransfer, o.range, sdrWhite);
  const axisRef =
    zones.nitRef !== null ? nitsToAxisForTransfer(zones.nitRef, effTransfer, o.range, sdrWhite) : null;
  const axisHigh = nitsToAxisForTransfer(nitHigh, effTransfer, o.range, sdrWhite);
  const axisWarnStart = axisRef ?? axisLow;

  const yLow = axisToCanvasY(axisLow, plotTop, plotH, zoom, panY);
  const yWarn = axisToCanvasY(axisWarnStart, plotTop, plotH, zoom, panY);
  const yHigh = axisToCanvasY(axisHigh, plotTop, plotH, zoom, panY);
  const plotBottom = plotTop + plotH;

  // Shade 3–4 luminance zones when HDR zones active (or peak warning band on HDR scales)
  if (o.traceMode === 'hdr-zones' || isHdrScale) {
    if (yHigh > plotTop + 1) {
      ctx.fillStyle = NIT_PEAK_BAND;
      ctx.fillRect(plotLeft, plotTop, plotW, Math.min(plotH, yHigh - plotTop));
    }
    if (o.traceMode === 'hdr-zones') {
      const warnTop = Math.max(plotTop, yHigh);
      const warnBot = Math.min(plotBottom, yWarn);
      if (warnBot - warnTop > 1) {
        ctx.fillStyle = NIT_WARN_BAND;
        ctx.fillRect(plotLeft, warnTop, plotW, warnBot - warnTop);
      }
      if (axisRef !== null) {
        const sdrTop = Math.max(plotTop, yWarn);
        const sdrBot = Math.min(plotBottom, yLow);
        if (sdrBot - sdrTop > 1) {
          ctx.fillStyle = NIT_SDR_BAND;
          ctx.fillRect(plotLeft, sdrTop, plotW, sdrBot - sdrTop);
        }
        if (yLow < plotBottom - 1) {
          ctx.fillStyle = NIT_SHADOW_BAND;
          ctx.fillRect(plotLeft, Math.max(plotTop, yLow), plotW, plotBottom - Math.max(plotTop, yLow));
        }
      } else if (yLow < plotBottom - 1) {
        ctx.fillStyle = NIT_SDR_BAND;
        ctx.fillRect(plotLeft, Math.max(plotTop, yLow), plotW, plotBottom - Math.max(plotTop, yLow));
      }
    }
  }

  // ITU-R BT.2408 SDR Reference White (e.g. 203 nits) line — marks start of Yellow HDR headroom in 4-zone mode
  if (axisRef !== null && (o.traceMode === 'hdr-zones' || isHdrScale)) {
    const relRef = (axisRef - panY) * zoom;
    if (relRef >= 0 && relRef <= 1) {
      const yRef = axisToCanvasY(axisRef, plotTop, plotH, zoom, panY);
      ctx.save();
      ctx.strokeStyle = HDR_REF_WHITE_COLOR;
      ctx.globalAlpha = o.traceMode === 'hdr-zones' ? 0.85 : 0.55;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, yRef);
      ctx.lineTo(plotLeft + plotW, yRef);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Threshold lines + right-side callout tags (Cyan <low, Yellow >203n headroom, Red >peak)
  const lowLineColor = axisRef === null ? NIT_WARN_COLOR : NIT_LOW_COLOR;
  const thresholds: { axis: number; nits: number; color: string; tag: string; optional?: boolean }[] = [
    { axis: axisLow, nits: nitLow, color: lowLineColor, tag: formatNitBadge(nitLow) },
    ...(axisRef !== null && zones.nitRef !== null && o.traceMode === 'hdr-zones'
      ? [{ axis: axisRef, nits: zones.nitRef, color: NIT_WARN_COLOR, tag: formatNitBadge(zones.nitRef), optional: true }]
      : []),
    { axis: axisHigh, nits: nitHigh, color: NIT_HIGH_COLOR, tag: `>${formatNitBadge(nitHigh)}` },
  ];

  ctx.save();
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  const placedYs: number[] = [];
  for (const t of thresholds) {
    const rel = (t.axis - panY) * zoom;
    if (rel < -0.005 || rel > 1.005) continue;
    const y = axisToCanvasY(t.axis, plotTop, plotH, zoom, panY);
    if (!t.optional) {
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (t.optional && placedYs.some((py) => Math.abs(py - y) < 13)) continue;
    placedYs.push(y);

    const labelW = ctx.measureText(t.tag).width + 6;
    const bx = plotLeft + plotW - labelW - 3;
    const by = Math.min(plotTop + plotH - 11, Math.max(plotTop + 1, y - 5.5));
    ctx.fillStyle = TAG_BG;
    ctx.fillRect(bx, by, labelW, 11);
    ctx.fillStyle = t.color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.tag, bx + 3, by + 5.5);
  }
  ctx.restore();
}

export function drawWaveformGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);

  const plotTop = WAVE_PAD.top;
  const plotH = h - WAVE_PAD.top - WAVE_PAD.bottom;
  const plotLeft = WAVE_PAD.left;
  const plotW = w - WAVE_PAD.left - WAVE_PAD.right;
  if (plotW <= 0 || plotH <= 0) return;

  const zoom = Math.max(1, o.zoom || 1);
  const maxPan = Math.max(0, 1 - 1 / zoom);
  const panY = Math.min(maxPan, Math.max(0, o.panY ?? 0));
  const effTransfer = o.effectiveTransfer ?? 'sdr';
  const effUnit = resolveEffectiveUnit(o.units, effTransfer);
  const isHdrScale = effUnit === 'nits' || effUnit === 'hlg';

  if (!isHdrScale) {
    const bands = legalBands(o.range);
    if (bands.footroom[1] > bands.footroom[0]) {
      const y0 = axisToCanvasY(bands.footroom[1], plotTop, plotH, zoom, panY);
      const y1 = axisToCanvasY(bands.footroom[0], plotTop, plotH, zoom, panY);
      if (y1 > y0) {
        ctx.fillStyle = BAND;
        ctx.fillRect(plotLeft, y0, plotW, y1 - y0);
      }
    }
    if (bands.headroom[1] > bands.headroom[0]) {
      const y0 = axisToCanvasY(bands.headroom[1], plotTop, plotH, zoom, panY);
      const y1 = axisToCanvasY(bands.headroom[0], plotTop, plotH, zoom, panY);
      if (y1 > y0) {
        ctx.fillStyle = BAND;
        ctx.fillRect(plotLeft, y0, plotW, y1 - y0);
      }
    }
  }

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const allTicks = tickValues(effUnit, o.range, zoom);
  const visibleTicks = allTicks.filter((a) => {
    const rel = (a - panY) * zoom;
    return rel >= -1e-4 && rel <= 1 + 1e-4;
  });

  const LABEL_LINE_H = 13;
  const maxLabels = Math.max(2, Math.floor(plotH / LABEL_LINE_H));
  const stride = Math.max(1, Math.ceil(visibleTicks.length / maxLabels));

  for (let i = 0; i < visibleTicks.length; i++) {
    const a = visibleTicks[i]!;
    const y = axisToCanvasY(a, plotTop, plotH, zoom, panY);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();

    const isEnd = i === 0 || i === visibleTicks.length - 1;
    if (!isEnd && i % stride !== 0) continue;
    ctx.fillStyle = isEnd ? LEGAL : TEXT;
    ctx.fillText(formatTickLabel(a, effUnit, o.range), plotLeft - 5, y);
  }

  if (!isHdrScale) {
    const bands = legalBands(o.range);
    ctx.strokeStyle = LEGAL;
    ctx.setLineDash([4, 3]);
    for (const a of [bands.footroom[1], bands.headroom[0]]) {
      if (a <= 0 || a >= 1) continue;
      const rel = (a - panY) * zoom;
      if (rel < 0 || rel > 1) continue;
      const y = axisToCanvasY(a, plotTop, plotH, zoom, panY);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotLeft + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  drawHdrThresholdLinesY(ctx, o, plotLeft, plotTop, plotW, plotH, zoom, panY);

  // YUV Waveform zero-chroma 50% centerline reference
  if (o.mode !== 'waveform-parade' && o.waveChannels === 'YUV') {
    const rel50 = (0.5 - panY) * zoom;
    if (rel50 >= 0 && rel50 <= 1) {
      const y50 = axisToCanvasY(0.5, plotTop, plotH, zoom, panY);
      ctx.strokeStyle = MID_LINE;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, y50);
      ctx.lineTo(plotLeft + plotW, y50);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Parade: slice dividers and labels for RGB (3), YRGB (4), or YUV (3).
  if (o.mode === 'waveform-parade') {
    const pm = o.paradeMode ?? 'RGB';
    const labels = pm === 'YRGB' ? ['Y', 'R', 'G', 'B'] : pm === 'YUV' ? ['Y', 'U (Cb)', 'V (Cr)'] : ['R', 'G', 'B'];
    const n = labels.length;
    ctx.strokeStyle = GRID_MAJOR;
    ctx.setLineDash([2, 4]);
    for (let i = 1; i < n; i++) {
      const x = plotLeft + (plotW * i) / n;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotH);
      ctx.stroke();
    }
    // Zero-chroma centerline across U & V slices in YUV Parade
    if (pm === 'YUV') {
      const rel50 = (0.5 - panY) * zoom;
      if (rel50 >= 0 && rel50 <= 1) {
        const y50 = axisToCanvasY(0.5, plotTop, plotH, zoom, panY);
        ctx.strokeStyle = PARADE_MID;
        ctx.beginPath();
        ctx.moveTo(plotLeft + plotW / 3, y50);
        ctx.lineTo(plotLeft + plotW, y50);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    ctx.fillStyle = TEXT;
    for (const [i, label] of labels.entries()) {
      ctx.fillText(label, plotLeft + (plotW * (i + 0.5)) / n, plotTop + plotH + 9);
    }
  }

  ctx.strokeStyle = GRID_MAJOR;
  ctx.strokeRect(plotLeft + 0.5, plotTop + 0.5, plotW - 1, plotH - 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  ctx.fillText(unitSuffix(effUnit), 4, plotTop + 6);
}

export function drawHistogramGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);

  const plotTop = WAVE_PAD.top;
  const plotH = h - WAVE_PAD.top - WAVE_PAD.bottom;
  const plotLeft = WAVE_PAD.left;
  const plotW = w - WAVE_PAD.left - WAVE_PAD.right;
  if (plotW <= 0 || plotH <= 0) return;

  const zoom = Math.max(1, o.zoom || 1);
  const maxPan = Math.max(0, 1 - 1 / zoom);
  const panX = Math.min(maxPan, Math.max(0, o.panX ?? 0));
  const effTransfer = o.effectiveTransfer ?? 'sdr';
  const effUnit = resolveEffectiveUnit(o.units, effTransfer);
  const isHdrScale = effUnit === 'nits' || effUnit === 'hlg';

  // Horizontal density guide lines (25%, 50%, 75%)
  ctx.strokeStyle = GRID;
  for (const frac of [0.25, 0.5, 0.75]) {
    const y = plotTop + plotH * (1 - frac);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();
  }

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = TEXT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('Peak', plotLeft - 5, plotTop + 6);
  ctx.fillText('50%', plotLeft - 5, plotTop + plotH * 0.5);
  ctx.fillText('0', plotLeft - 5, plotTop + plotH - 2);

  // Vertical signal ticks along X
  const allTicks = tickValues(effUnit, o.range, zoom);
  const visibleTicks = allTicks.filter((a) => {
    const rel = (a - panX) * zoom;
    return rel >= -1e-4 && rel <= 1 + 1e-4;
  });
  const maxLabels = Math.max(2, Math.floor(plotW / 38));
  const stride = Math.max(1, Math.ceil(visibleTicks.length / maxLabels));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < visibleTicks.length; i++) {
    const a = visibleTicks[i]!;
    const x = axisToCanvasX(a, plotLeft, plotW, zoom, panX);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotTop + plotH);
    ctx.stroke();

    const isEnd = i === 0 || i === visibleTicks.length - 1;
    if (!isEnd && i % stride !== 0) continue;
    ctx.fillStyle = isEnd ? LEGAL : TEXT;
    ctx.fillText(formatTickLabel(a, effUnit, o.range), x, plotTop + plotH + 4);
  }

  // 3–4 Zone HDR Nit threshold vertical lines + zone bands on Histogram
  if (o.traceMode === 'hdr-zones' || isHdrScale) {
    const sdrWhite = o.sdrWhiteNits ?? SDR_DIFFUSE_WHITE_NITS;
    const zones = resolveHdrZoneThresholds(o.nitLow ?? 100, o.nitHigh ?? 1000, sdrWhite);
    const axisLow = nitsToAxisForTransfer(zones.nitLow, effTransfer, o.range, sdrWhite);
    const axisRef =
      zones.nitRef !== null ? nitsToAxisForTransfer(zones.nitRef, effTransfer, o.range, sdrWhite) : null;
    const axisHigh = nitsToAxisForTransfer(zones.nitHigh, effTransfer, o.range, sdrWhite);
    const axisWarnStart = axisRef ?? axisLow;

    const xLow = axisToCanvasX(axisLow, plotLeft, plotW, zoom, panX);
    const xWarn = axisToCanvasX(axisWarnStart, plotLeft, plotW, zoom, panX);
    const xHigh = axisToCanvasX(axisHigh, plotLeft, plotW, zoom, panX);
    const plotRight = plotLeft + plotW;

    if (xHigh < plotRight - 1) {
      ctx.fillStyle = NIT_PEAK_BAND;
      ctx.fillRect(Math.max(plotLeft, xHigh), plotTop, plotRight - Math.max(plotLeft, xHigh), plotH);
    }
    if (o.traceMode === 'hdr-zones') {
      const warnL = Math.max(plotLeft, xWarn);
      const warnR = Math.min(plotRight, xHigh);
      if (warnR - warnL > 1) {
        ctx.fillStyle = NIT_WARN_BAND;
        ctx.fillRect(warnL, plotTop, warnR - warnL, plotH);
      }
      if (axisRef !== null) {
        const sdrL = Math.max(plotLeft, xLow);
        const sdrR = Math.min(plotRight, xWarn);
        if (sdrR - sdrL > 1) {
          ctx.fillStyle = NIT_SDR_BAND;
          ctx.fillRect(sdrL, plotTop, sdrR - sdrL, plotH);
        }
        if (xLow > plotLeft + 1) {
          ctx.fillStyle = NIT_SHADOW_BAND;
          ctx.fillRect(plotLeft, plotTop, Math.min(plotRight, xLow) - plotLeft, plotH);
        }
      } else if (xLow > plotLeft + 1) {
        ctx.fillStyle = NIT_SDR_BAND;
        ctx.fillRect(plotLeft, plotTop, Math.min(plotRight, xLow) - plotLeft, plotH);
      }
    }

    const lowLineColor = axisRef === null ? NIT_WARN_COLOR : NIT_LOW_COLOR;
    const vLines: { axis: number; color: string; tag: string; showTag: boolean }[] = [
      { axis: axisLow, color: lowLineColor, tag: formatNitBadge(zones.nitLow), showTag: true },
      ...(axisRef !== null && zones.nitRef !== null
        ? [{ axis: axisRef, color: NIT_WARN_COLOR, tag: formatNitBadge(zones.nitRef), showTag: o.traceMode === 'hdr-zones' }]
        : []),
      { axis: axisHigh, color: NIT_HIGH_COLOR, tag: `>${formatNitBadge(zones.nitHigh)}`, showTag: true },
    ];

    for (const t of vLines) {
      const rel = (t.axis - panX) * zoom;
      if (rel < 0 || rel > 1) continue;
      const x = axisToCanvasX(t.axis, plotLeft, plotW, zoom, panX);
      ctx.save();
      ctx.strokeStyle = t.color;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (t.showTag) {
        ctx.fillStyle = t.color;
        ctx.textAlign = x > plotRight - 36 ? 'right' : 'left';
        ctx.fillText(t.tag, x + (x > plotRight - 36 ? -3 : 3), plotTop + 3);
      }
      ctx.restore();
    }
  }

  ctx.strokeStyle = GRID_MAJOR;
  ctx.strokeRect(plotLeft + 0.5, plotTop + 0.5, plotW - 1, plotH - 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = TEXT;
  ctx.fillText(unitSuffix(effUnit), 4, plotTop + plotH + 9);
}

export function chromaToScreen(
  cb: number,
  cr: number,
  size: number,
  zoom: number,
  ox = size / 2,
  oy = size / 2,
): [number, number] {
  return [ox + cb * zoom * size, oy - cr * zoom * size];
}

export function screenToChroma(
  x: number,
  y: number,
  size: number,
  zoom: number,
  ox = size / 2,
  oy = size / 2,
): [number, number] {
  return [(x - ox) / (zoom * size), (oy - y) / (zoom * size)];
}

const TARGET_ACCENT: Record<string, string> = {
  red: '#e69595',
  yellow: '#dfd88e',
  green: '#8dd8a3',
  cyan: '#8ad4df',
  blue: '#93b2e8',
  magenta: '#dc9ae0',
};

function drawTargetBrackets(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
): void {
  const half = size / 2;
  const arm = Math.max(2, size * 0.32);
  ctx.beginPath();
  ctx.moveTo(px - half, py - half + arm);
  ctx.lineTo(px - half, py - half);
  ctx.lineTo(px - half + arm, py - half);

  ctx.moveTo(px + half - arm, py - half);
  ctx.lineTo(px + half, py - half);
  ctx.lineTo(px + half, py - half + arm);

  ctx.moveTo(px + half, py + half - arm);
  ctx.lineTo(px + half, py + half);
  ctx.lineTo(px + half - arm, py + half);

  ctx.moveTo(px - half + arm, py + half);
  ctx.lineTo(px - half, py + half);
  ctx.lineTo(px - half, py + half - arm);
  ctx.stroke();
}

export function drawVectorscopeGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  const w = o.width;
  const h = o.height;
  const frame = vectorscopeFrame(w, h, o.zoom, o.panX ?? 0, o.panY ?? 0);
  const { cx, cy, radius } = frame;
  const ringR = radius * frame.zoom;

  ctx.clearRect(0, 0, w, h);

  // Clip panned/zoomed rings, crosshairs, targets, and skin line to the rectangular cell canvas
  // so the outermost ring zooms outward naturally with the rest of the vectorscope!
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();

  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID;
  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.arc(cx, cy, ringR * frac, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Outermost vectorscope circle scales smoothly with frame.zoom
  ctx.strokeStyle = GRID_MAJOR;
  ctx.lineWidth = 1.15;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - ringR);
  ctx.lineTo(cx, cy + ringR);
  ctx.moveTo(cx - ringR, cy);
  ctx.lineTo(cx + ringR, cy);
  ctx.stroke();

  const c = LUMA[o.matrix];
  const primaryLevel: 0.75 | 1 = o.barTargets === 1 ? 1 : 0.75;

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const boxSize = Math.max(7, Math.min(18, radius * Math.min(1.5, Math.sqrt(frame.zoom)) * 0.11));
  for (const t of chromaTargets(c, primaryLevel)) {
    const [px, py] = vectorscopeToScreen(frame, t.cb, t.cr);
    if (px < -20 || px > w + 20 || py < -20 || py > h + 20) continue;
    const accent = TARGET_ACCENT[t.name] ?? '#b8c7d4';
    ctx.strokeStyle = accent;
    drawTargetBrackets(ctx, px, py, boxSize);

    const dx = px - cx;
    const dy = py - cy;
    const len = Math.max(1e-3, Math.hypot(dx, dy));
    const tx = -dy / len;
    const ty = dx / len;
    const lx = px + tx * (boxSize / 2 + 6);
    const ly = py + ty * (boxSize / 2 + 6);
    if (lx >= 5 && lx <= w - 5 && ly >= 6 && ly <= h - 5) {
      ctx.fillStyle = accent;
      ctx.fillText(t.name[0]!.toUpperCase(), lx, ly);
    }
  }

  if (o.showSkinLine !== false) {
    const ang = (SKIN_TONE_ANGLE_DEG * Math.PI) / 180;
    ctx.strokeStyle = '#d8a06a';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * ringR * 0.98, cy - Math.sin(ang) * ringR * 0.98);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const sigTag = o.vecScale2x ? ' · 2×Sig' : '';
  const zoomTag = frame.zoom > 1.01 ? ` · ${+frame.zoom.toFixed(1)}x` : '';
  const toneTag = o.toneFilter && o.toneFilter !== 'all' ? ` · ${o.toneFilter}` : '';
  const statusText = `${o.matrix.toUpperCase()} · ${Math.round(primaryLevel * 100)}%${sigTag}${zoomTag}${toneTag}`;
  if (frame.zoom > 1.01) {
    const tw = ctx.measureText(statusText).width;
    ctx.fillStyle = STATUS_BG;
    ctx.fillRect(5, 4, tw + 6, 15);
  }
  ctx.fillStyle = TEXT;
  ctx.fillText(statusText, 8, 12);
}

export function xyToUv(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (9 * y) / d];
}

export function uvToXy(u: number, v: number): [number, number] {
  const d = 6 * u - 16 * v + 12;
  return [(9 * u) / d, (4 * v) / d];
}

export function xyToScreen(
  x: number,
  y: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom = 1,
  panX?: number | null,
  panY?: number | null,
): [number, number] {
  return frameToScreen(cieFrame(w, h, coord, zoom, panX, panY), x, y);
}

export function screenToXy(
  px: number,
  py: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
  zoom = 1,
  panX?: number | null,
  panY?: number | null,
): [number, number] {
  return screenToFrame(cieFrame(w, h, coord, zoom, panX, panY), px, py);
}

function chartToScreenWithFrame(
  frame: CieFrame,
  x: number,
  y: number,
  coord: 'xy' | 'uv',
): [number, number] {
  if (coord === 'xy') return frameToScreen(frame, x, y);
  const [u, v] = xyToUv(x, y);
  return frameToScreen(frame, u, v);
}

const RED_TAIL_START = 600;
const RED_TAIL_MIX = 0.75;

function gamutSafe(lin: [number, number, number]): [number, number, number] {
  const min = Math.min(lin[0], lin[1], lin[2]);
  if (min >= 0) return lin;
  const max = Math.max(lin[0], lin[1], lin[2]);
  const t = -min / (max - min);
  return [lin[0] * (1 - t) + max * t, lin[1] * (1 - t) + max * t, lin[2] * (1 - t) + max * t];
}

function locusHue(x: number, y: number, wavelength: number): string {
  const normalise = ([r, g, b]: [number, number, number]): [number, number, number] => {
    const peak = Math.max(r, g, b, 1e-6);
    return [
      Math.min(1, Math.max(0, r / peak)),
      Math.min(1, Math.max(0, g / peak)),
      Math.min(1, Math.max(0, b / peak)),
    ];
  };

  let rgb = normalise(gamutSafe(xyToLinearSrgb([x, y])));

  const tail = Math.min(1, Math.max(0, (wavelength - RED_TAIL_START) / (700 - RED_TAIL_START)));
  if (tail > 0) {
    const violet = normalise(gamutSafe(xyToLinearSrgb([CIE1931_LOCUS[0]![0], CIE1931_LOCUS[0]![1]])));
    const mixed = rgb.map((c, k) => c + (violet[k]! - c) * tail * RED_TAIL_MIX) as [
      number,
      number,
      number,
    ];
    rgb = normalise(mixed);
  }

  const enc = (v: number): number => Math.round(linearToSrgb(Math.min(1, Math.max(0, v))) * 255);
  return `rgb(${enc(rgb[0])},${enc(rgb[1])},${enc(rgb[2])})`;
}

function locusSubdivisions(screen: readonly (readonly [number, number])[]): number {
  let longest = 0;
  for (let i = 1; i < screen.length; i++) {
    const a = screen[i - 1]!;
    const b = screen[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > longest) longest = len;
  }
  return Math.max(6, Math.min(24, Math.ceil(longest / 3)));
}

export function drawCieGraticule(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions & { gamuts: PrimariesId[] },
): void {
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);

  // dpr stays 1 here on purpose: this canvas is drawn in CSS pixels (the caller
  // already applied `setTransform(dpr, ...)`), so the padding must be measured in
  // CSS pixels too. The GPU renderer works in device pixels and passes its own
  // dpr; both paths land on the same visual padding.
  const frame = cieViewportFrame(w, h, o.coord, o.zoom, o.panX, o.panY, 1);

  // Draw gridlines & numeric ticks first so the horseshoe & gamut triangles stay crisp above the grid
  drawCieAxes(ctx, frame, w, h, o.coord);

  const screen = CIE1931_LOCUS.map((p) => chartToScreenWithFrame(frame, p[0], p[1], o.coord));
  const pts = smoothOpenSpline(screen, locusSubdivisions(screen));

  ctx.save();
  // Clip locus, gamut triangles, and white-point crosshair strictly to the plot frame
  // so they stay 100% aligned inside the coordinate grid box and never cross axis labels!
  ctx.beginPath();
  ctx.rect(frame.left, frame.top, frame.width, frame.height);
  ctx.clip();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.strokeStyle = LOCUS_STROKE;
  ctx.lineWidth = 1;
  ctx.stroke();

  const lw = 2;
  const half = lw / 2;
  ctx.lineWidth = lw;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  const perSegment = pts.length > 1 ? (pts.length - 1) / (CIE1931_LOCUS.length - 1) : 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) continue;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const t = i / perSegment;
    const k = Math.min(CIE1931_LOCUS.length - 1, Math.floor(t));
    const k2 = Math.min(CIE1931_LOCUS.length - 1, k + 1);
    const f = Math.min(1, Math.max(0, t - k));
    const a = CIE1931_LOCUS[k]!;
    const b = CIE1931_LOCUS[k2]!;
    const wavelength = SPECTRAL_WAVELENGTHS[k]! + (SPECTRAL_WAVELENGTHS[k2]! - SPECTRAL_WAVELENGTHS[k]!) * f;
    ctx.strokeStyle = locusHue(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, wavelength);
    ctx.beginPath();
    ctx.moveTo(x0 - ux * half, y0 - uy * half);
    ctx.lineTo(x1 + ux * half, y1 + uy * half);
    ctx.stroke();
  }

  const GAMUT_COLOR: Record<PrimariesId, string> = {
    rec709: '#7fa8d8',
    p3: '#d8c07f',
    rec2020: '#d87f7f',
  };
  const GAMUT_LEGEND_COLOR: Record<PrimariesId, string> = {
    rec709: '#a4cdfa',
    p3: '#f0d890',
    rec2020: '#f29c9c',
  };
  const GAMUT_LABEL: Record<PrimariesId, string> = {
    rec709: '709',
    p3: 'P3',
    rec2020: '2020',
  };
  for (const id of o.gamuts) {
    const tri = gamutTriangle(id).map((p) => chartToScreenWithFrame(frame, p[0], p[1], o.coord));
    ctx.beginPath();
    tri.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = GAMUT_COLOR[id];
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  const white = o.coord === 'xy' ? ([0.3127, 0.329] as const) : xyToUv(0.3127, 0.329);
  const [wx, wy] = frameToScreen(frame, white[0], white[1]);
  ctx.strokeStyle = WHITE_POINT;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(wx - 5, wy);
  ctx.lineTo(wx + 5, wy);
  ctx.moveTo(wx, wy - 5);
  ctx.lineTo(wx, wy + 5);
  ctx.stroke();
  ctx.restore();

  // Top header strip (y = 11, strictly above frame.top >= 28):
  // Left: illuminant + chart mode + primaries + zoom; Right: color-coded gamut legend!
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  const headerLeft =
    `D65 · ${o.coord === 'xy' ? 'CIE 1931 xy' : "CIE 1976 u'v'"} · ${o.primaries}` +
    (o.zoom > 1.01 ? ` · ${+o.zoom.toFixed(1)}x` : '');
  ctx.fillText(headerLeft, 8, 11);

  const headerLeftEnd = 8 + ctx.measureText(headerLeft).width + 12;
  let legendX = w - 8;
  ctx.textAlign = 'right';
  for (let i = o.gamuts.length - 1; i >= 0; i--) {
    const id = o.gamuts[i]!;
    const item = `─ ${GAMUT_LABEL[id]}`;
    const iw = ctx.measureText(item).width;
    if (legendX - iw < headerLeftEnd) break;
    ctx.fillStyle = GAMUT_LEGEND_COLOR[id];
    ctx.fillText(item, legendX, 11);
    legendX -= iw + 8;
  }
}

function drawCieAxes(
  ctx: CanvasRenderingContext2D,
  frame: CieFrame,
  w: number,
  h: number,
  coord: 'xy' | 'uv' = 'xy',
): void {
  const spanX = frame.x1 - frame.x0;
  const spanY = frame.y1 - frame.y0;
  const minSpan = Math.min(spanX, spanY);
  const stepFor = (span: number): number => {
    for (const s of [0.2, 0.1, 0.05, 0.02, 0.01, 0.005]) {
      if (span / s <= 6) return s;
    }
    return 0.002;
  };
  // Equal step on X and Y guarantees every grid cell is a true 1:1 square at every zoom!
  const step = stepFor(minSpan);
  const decimals = Math.max(1, Math.ceil(-Math.log10(step)));

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.lineWidth = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xLabelY = Math.min(h - 11, frame.top + frame.height + 3);
  const firstX = Math.ceil((frame.x0 - 1e-9) / step) * step;
  let lastLabelRight = -Infinity;
  for (let v = firstX; v <= frame.x1 + 1e-9; v += step) {
    const cleanV = Math.abs(v) < 1e-9 ? 0 : v;
    const [px] = frameToScreen(frame, cleanV, frame.y0);
    if (px < frame.left - 0.5 || px > frame.left + frame.width + 0.5) continue;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(px, frame.top);
    ctx.lineTo(px, frame.top + frame.height);
    ctx.stroke();

    if (cleanV < -1e-6 || cleanV > 1.0 + 1e-6) continue;
    if (px < frame.left + 2 || px > w - 18) continue;
    const txt = cleanV.toFixed(decimals);
    const halfW = ctx.measureText(txt).width * 0.5 + 3;
    if (px - halfW < lastLabelRight) continue;
    lastLabelRight = px + halfW;
    ctx.fillStyle = TEXT;
    ctx.fillText(txt, px, xLabelY);
  }

  const labelOutside = frame.left >= 22;
  ctx.textAlign = labelOutside ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  const yLabelX = labelOutside ? frame.left - 5 : frame.left + 4;
  const firstY = Math.ceil((frame.y0 - 1e-9) / step) * step;
  const drawnTickYs: number[] = [];
  for (let v = firstY; v <= frame.y1 + 1e-9; v += step) {
    const cleanV = Math.abs(v) < 1e-9 ? 0 : v;
    const [, py] = frameToScreen(frame, frame.x0, cleanV);
    if (py < frame.top - 0.5 || py > frame.top + frame.height + 0.5) continue;
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(frame.left, py);
    ctx.lineTo(frame.left + frame.width, py);
    ctx.stroke();

    if (cleanV < -1e-6 || cleanV > 1.0 + 1e-6) continue;
    const clampedY = Math.min(h - 14, Math.max(20, py));
    if (Math.abs(clampedY - py) > 4) continue;
    drawnTickYs.push(clampedY);
    ctx.fillStyle = TEXT;
    ctx.fillText(cleanV.toFixed(decimals), yLabelX, clampedY);
  }

  const hAxisName = coord === 'uv' ? "u'" : 'x';
  const vAxisName = coord === 'uv' ? "v'" : 'y';

  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (frame.left + frame.width + 4 <= w - 10) {
    ctx.fillText(hAxisName, frame.left + frame.width + 4, xLabelY);
  }
  if (labelOutside) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let vNameY = frame.top + 18;
    if (drawnTickYs.length >= 2) {
      const sorted = [...drawnTickYs].sort((a, b) => a - b);
      vNameY = (sorted[0]! + sorted[1]!) / 2;
    } else if (drawnTickYs.length === 1) {
      vNameY = drawnTickYs[0]! + 18;
    }
    if (vNameY >= 24 && vNameY <= h - 18) {
      ctx.fillText(vAxisName, yLabelX, vNameY);
    }
  }
}

export function drawGraticule(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions,
  gamuts: readonly PrimariesId[] = ['rec709'],
): void {
  withPalette(o.graticuleTheme, () => {
    const effectiveGamuts = o.gamuts && o.gamuts.length > 0 ? o.gamuts : gamuts;
    const bright = Math.max(0.35, Math.min(1.6, o.graticuleBrightness ?? 1));
    ctx.save();
    if (Math.abs(bright - 1) > 0.02) {
      ctx.globalAlpha = Math.min(1, bright);
    }
    switch (o.mode) {
      case 'vectorscope':
        drawVectorscopeGraticule(ctx, o);
        break;
      case 'cie':
        drawCieGraticule(ctx, { ...o, gamuts: [...effectiveGamuts] });
        break;
      case 'histogram':
        drawHistogramGraticule(ctx, o);
        break;
      default:
        drawWaveformGraticule(ctx, o);
    }
    ctx.restore();
  });
}
