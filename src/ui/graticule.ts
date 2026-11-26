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
  insideVectorscopeDisc,
  vectorscopeFrame,
  vectorscopeToScreen,
} from '../core/color/vectorscope-frame';
import type { ScopeOptions } from '../gpu/scope-renderer';

export const WAVE_PAD = { top: 14, right: 10, bottom: 22, left: 44 } as const;

const GRID = '#1b232b';
const GRID_MAJOR = '#33414d';
const LEGAL = '#5d7f93';
const BAND = 'rgba(255,255,255,0.035)';
const TEXT = '#7d8b96';
const HDR_REF_WHITE_COLOR = '#6ec8e8';
const NIT_LOW_COLOR = '#38bdf8';
const NIT_HIGH_COLOR = '#fb923c';
const NIT_PEAK_BAND = 'rgba(251, 113, 133, 0.075)';
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

  const nitLow = Math.max(0.01, o.nitLow ?? 100);
  const nitHigh = Math.max(nitLow + 1, o.nitHigh ?? 1000);
  const axisLow = nitsToAxisForTransfer(nitLow, effTransfer, o.range);
  const axisHigh = nitsToAxisForTransfer(nitHigh, effTransfer, o.range);

  // Shade peak exceedance region (> nitHigh) and deep shadow region (< nitLow) when HDR zones active
  if (o.traceMode === 'hdr-zones' || isHdrScale) {
    const yHigh = axisToCanvasY(axisHigh, plotTop, plotH, zoom, panY);
    if (yHigh > plotTop + 1) {
      ctx.fillStyle = NIT_PEAK_BAND;
      ctx.fillRect(plotLeft, plotTop, plotW, Math.min(plotH, yHigh - plotTop));
    }
    if (o.traceMode === 'hdr-zones') {
      const yLow = axisToCanvasY(axisLow, plotTop, plotH, zoom, panY);
      if (yLow < plotTop + plotH - 1) {
        ctx.fillStyle = NIT_SHADOW_BAND;
        ctx.fillRect(plotLeft, Math.max(plotTop, yLow), plotW, plotTop + plotH - Math.max(plotTop, yLow));
      }
    }
  }

  // ITU-R BT.2408 203 nits Reference White line (when not identical to nitLow/nitHigh)
  if (isHdrScale && Math.abs(nitLow - SDR_DIFFUSE_WHITE_NITS) > 8 && Math.abs(nitHigh - SDR_DIFFUSE_WHITE_NITS) > 15) {
    const axisRef = nitsToAxisForTransfer(SDR_DIFFUSE_WHITE_NITS, effTransfer, o.range);
    const relRef = (axisRef - panY) * zoom;
    if (relRef >= 0 && relRef <= 1) {
      const yRef = axisToCanvasY(axisRef, plotTop, plotH, zoom, panY);
      ctx.save();
      ctx.strokeStyle = HDR_REF_WHITE_COLOR;
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(plotLeft, yRef);
      ctx.lineTo(plotLeft + plotW, yRef);
      ctx.stroke();
      ctx.restore();
    }
  }

  // User Low-Nit & High-Nit threshold lines + right-side callout tags
  const thresholds: { axis: number; nits: number; color: string; tag: string }[] = [
    { axis: axisLow, nits: nitLow, color: NIT_LOW_COLOR, tag: formatNitBadge(nitLow) },
    { axis: axisHigh, nits: nitHigh, color: NIT_HIGH_COLOR, tag: `>${formatNitBadge(nitHigh)}` },
  ];

  ctx.save();
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  for (const t of thresholds) {
    const rel = (t.axis - panY) * zoom;
    if (rel < -0.005 || rel > 1.005) continue;
    const y = axisToCanvasY(t.axis, plotTop, plotH, zoom, panY);
    ctx.strokeStyle = t.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const labelW = ctx.measureText(t.tag).width + 6;
    const bx = plotLeft + plotW - labelW - 3;
    const by = Math.min(plotTop + plotH - 11, Math.max(plotTop + 1, y - 5.5));
    ctx.fillStyle = 'rgba(11, 15, 18, 0.82)';
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
      ctx.strokeStyle = '#3b5163';
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
        ctx.strokeStyle = '#486378';
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

  // Dual-Nit threshold vertical lines + peak zone band on Histogram
  if (o.traceMode === 'hdr-zones' || isHdrScale) {
    const nitLow = Math.max(0.01, o.nitLow ?? 100);
    const nitHigh = Math.max(nitLow + 1, o.nitHigh ?? 1000);
    const axisLow = nitsToAxisForTransfer(nitLow, effTransfer, o.range);
    const axisHigh = nitsToAxisForTransfer(nitHigh, effTransfer, o.range);

    const xHigh = axisToCanvasX(axisHigh, plotLeft, plotW, zoom, panX);
    if (xHigh < plotLeft + plotW - 1) {
      ctx.fillStyle = NIT_PEAK_BAND;
      ctx.fillRect(Math.max(plotLeft, xHigh), plotTop, plotLeft + plotW - Math.max(plotLeft, xHigh), plotH);
    }

    for (const t of [
      { axis: axisLow, color: NIT_LOW_COLOR, tag: formatNitBadge(nitLow) },
      { axis: axisHigh, color: NIT_HIGH_COLOR, tag: `>${formatNitBadge(nitHigh)}` },
    ]) {
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
      ctx.fillStyle = t.color;
      ctx.textAlign = x > plotLeft + plotW - 36 ? 'right' : 'left';
      ctx.fillText(t.tag, x + (x > plotLeft + plotW - 36 ? -3 : 3), plotTop + 3);
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
  const { cx, cy, discCx, discCy, radius } = frame;

  ctx.clearRect(0, 0, w, h);

  // Stationary outer bezel circle
  ctx.strokeStyle = GRID_MAJOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(discCx, discCy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Clip inner panned/zoomed rings, crosshairs, targets, and skin line to the disc
  ctx.save();
  ctx.beginPath();
  ctx.arc(discCx, discCy, radius, 0, Math.PI * 2);
  ctx.clip();

  ctx.strokeStyle = GRID_MAJOR;
  const ringR = radius * frame.zoom;
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, ringR * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
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

  for (const t of chromaTargets(c, primaryLevel)) {
    const [px, py] = vectorscopeToScreen(frame, t.cb, t.cr);
    if (!insideVectorscopeDisc(frame, px, py, 12)) continue;
    const s = Math.max(7, Math.min(15, radius * 0.11));
    const accent = TARGET_ACCENT[t.name] ?? '#b8c7d4';
    ctx.strokeStyle = accent;
    drawTargetBrackets(ctx, px, py, s);

    const dx = px - cx;
    const dy = py - cy;
    const len = Math.max(1e-3, Math.hypot(dx, dy));
    const tx = -dy / len;
    const ty = dx / len;
    const lx = px + tx * (s / 2 + 6);
    const ly = py + ty * (s / 2 + 6);
    if (insideVectorscopeDisc(frame, lx, ly, 2)) {
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

  ctx.fillStyle = TEXT;
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const toneTag = o.toneFilter && o.toneFilter !== 'all' ? ` · ${o.toneFilter}` : '';
  ctx.fillText(
    `${o.matrix.toUpperCase()} · ${Math.round(primaryLevel * 100)}% · ${+(o.zoom || 1).toFixed(1)}x${toneTag}`,
    8,
    12,
  );
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

  const frame = cieViewportFrame(w, h, o.coord, o.zoom, o.panX, o.panY, 1);

  // Draw gridlines & numeric ticks first so the horseshoe & gamut triangles stay crisp above the grid
  drawCieAxes(ctx, frame, w, h, o.coord);

  const screen = CIE1931_LOCUS.map((p) => chartToScreenWithFrame(frame, p[0], p[1], o.coord));
  const pts = smoothOpenSpline(screen, locusSubdivisions(screen));

  ctx.save();
  // Clip locus & triangles away from the top header strip (0..20px) when zoomed in
  ctx.beginPath();
  ctx.rect(0, Math.min(20, frame.top - 2), w, Math.max(1, h - Math.min(20, frame.top - 2)));
  ctx.clip();

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.strokeStyle = '#4a5a66';
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
  ctx.strokeStyle = '#e8e8e8';
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
  const stepFor = (span: number): number => {
    for (const s of [0.2, 0.1, 0.05, 0.02, 0.01, 0.005]) {
      if (span / s <= 8) return s;
    }
    return 0.002;
  };
  const stepX = stepFor(spanX);
  const stepY = stepFor(spanY);
  const decimals = Math.max(1, Math.ceil(-Math.log10(Math.min(stepX, stepY))));

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xLabelY = Math.min(h - 11, frame.top + frame.height + 3);
  const firstX = Math.ceil(frame.x0 / stepX) * stepX;
  for (let v = firstX; v <= frame.x1 + 1e-9; v += stepX) {
    const [px] = frameToScreen(frame, v, frame.y0);
    if (px < frame.left - 0.5 || px > frame.left + frame.width + 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(px, frame.top);
    ctx.lineTo(px, frame.top + frame.height);
    ctx.stroke();
    if (px < 12 || px > w - 16) continue;
    ctx.fillStyle = TEXT;
    ctx.fillText(v.toFixed(decimals), px, xLabelY);
  }

  const labelOutside = frame.left >= 22;
  ctx.textAlign = labelOutside ? 'right' : 'left';
  ctx.textBaseline = 'middle';
  const yLabelX = labelOutside ? frame.left - 5 : frame.left + 4;
  const firstY = Math.ceil(frame.y0 / stepY) * stepY;
  const drawnTickYs: number[] = [];
  for (let v = firstY; v <= frame.y1 + 1e-9; v += stepY) {
    const [, py] = frameToScreen(frame, frame.x0, v);
    if (py < frame.top - 0.5 || py > frame.top + frame.height + 0.5) continue;
    ctx.beginPath();
    ctx.moveTo(frame.left, py);
    ctx.lineTo(frame.left + frame.width, py);
    ctx.stroke();
    const clampedY = Math.min(h - 14, Math.max(20, py));
    if (Math.abs(clampedY - py) > 4) continue;
    drawnTickYs.push(clampedY);
    ctx.fillStyle = TEXT;
    ctx.fillText(v.toFixed(decimals), yLabelX, clampedY);
  }

  const hAxisName = coord === 'uv' ? "u'" : 'x';
  const vAxisName = coord === 'uv' ? "v'" : 'y';

  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  if (frame.left + frame.width + 6 <= w - 12) {
    ctx.fillText(hAxisName, frame.left + frame.width + 5, xLabelY);
  }
  if (labelOutside) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Always center v' / y cleanly between the top two drawn tick labels so it has wide breathing room!
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
}
