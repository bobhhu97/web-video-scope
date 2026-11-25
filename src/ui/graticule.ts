import { LUMA, SKIN_TONE_ANGLE_DEG, chromaTargets } from '../core/color/matrices';
import { CIE1931_LOCUS, gamutTriangle } from '../core/color/locus';
import { smoothOpenSpline } from '../core/color/spline';
import { linearToSrgb, xyToLinearSrgb } from '../core/color/transfer';
import type { PrimariesId } from '../core/color/primaries';
import { axisToUnit, legalBands, tickValues, unitSuffix } from '../core/scale/units';
import { CIE_BOUNDS } from '../core/scopes/reference';
import type { ScopeOptions } from '../gpu/scope-renderer';

/**
 * Plot margins, in CSS pixels.
 *
 * These were 8/8/16/40, which left only ~161 px of plot height inside a 2x2
 * grid cell (~185 px tall). Ten IRE gridlines in 161 px reads as a solid block,
 * and the outermost labels were clipped by the cell edge. The bottom margin
 * also has to fit the parade's R/G/B captions.
 */
export const WAVE_PAD = { top: 14, right: 10, bottom: 22, left: 44 } as const;

/**
 * The graticule is drawn on a transparent overlay canvas stacked above the GPU
 * density canvas. It must never fill an opaque background — doing so would
 * cover the waveform completely. The panel background comes from CSS.
 */
const GRID = '#1b232b';
const GRID_MAJOR = '#33414d';
const LEGAL = '#5d7f93';
const BAND = 'rgba(255,255,255,0.035)';
const TEXT = '#7d8b96';

/**
 * Axis (0..1 in code space) to canvas y. `zoom` magnifies from the floor so
 * HDR headroom can be inspected without changing the data.
 */
export function axisToCanvasY(axis: number, plotTop: number, plotHeight: number, zoom = 1): number {
  const clamped = Math.min(1, Math.max(0, axis * zoom));
  return plotTop + plotHeight * (1 - clamped);
}

export function canvasYToAxis(y: number, plotTop: number, plotHeight: number, zoom = 1): number {
  const rel = 1 - (y - plotTop) / plotHeight;
  return Math.min(1, Math.max(0, rel)) / zoom;
}

export function drawWaveformGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  // o.width / o.height are CSS pixels; the 2D context already carries a DPR transform.
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);

  const plotTop = WAVE_PAD.top;
  const plotH = h - WAVE_PAD.top - WAVE_PAD.bottom;
  const plotLeft = WAVE_PAD.left;
  const plotW = w - WAVE_PAD.left - WAVE_PAD.right;
  if (plotW <= 0 || plotH <= 0) return;

  const bands = legalBands(o.range);
  if (bands.footroom[1] > bands.footroom[0]) {
    const y0 = axisToCanvasY(bands.footroom[1], plotTop, plotH, o.zoom);
    const y1 = axisToCanvasY(bands.footroom[0], plotTop, plotH, o.zoom);
    ctx.fillStyle = BAND;
    ctx.fillRect(plotLeft, y0, plotW, y1 - y0);
  }
  if (bands.headroom[1] > bands.headroom[0]) {
    const y0 = axisToCanvasY(bands.headroom[1], plotTop, plotH, o.zoom);
    const y1 = axisToCanvasY(bands.headroom[0], plotTop, plotH, o.zoom);
    ctx.fillStyle = BAND;
    ctx.fillRect(plotLeft, y0, plotW, y1 - y0);
  }

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  // Every gridline is drawn; labels are decimated by a stride chosen from the
  // available height, never dropped arbitrarily. A fixed minimum gap silently
  // produced an unlabelled scale whenever the plot was short.
  const ticks = tickValues(o.units, o.range);
  const LABEL_LINE_H = 13;
  const maxLabels = Math.max(2, Math.floor(plotH / LABEL_LINE_H));
  const stride = Math.max(1, Math.ceil(ticks.length / maxLabels));

  for (let i = 0; i < ticks.length; i++) {
    const a = ticks[i]!;
    const y = axisToCanvasY(a, plotTop, plotH, o.zoom);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();

    // Always label the first and last tick (0 and 100 IRE), then every stride.
    const isEnd = i === 0 || i === ticks.length - 1;
    if (!isEnd && i % stride !== 0) continue;
    ctx.fillStyle = isEnd ? LEGAL : TEXT;
    ctx.fillText(String(Math.round(axisToUnit(a, o.units, o.range))), plotLeft - 5, y);
  }

  ctx.strokeStyle = LEGAL;
  ctx.setLineDash([4, 3]);
  for (const a of [bands.footroom[1], bands.headroom[0]]) {
    if (a <= 0 || a >= 1) continue;
    const y = axisToCanvasY(a, plotTop, plotH, o.zoom);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Parade: draw the slice dividers so the three panels read as separate scopes.
  if (o.mode === 'waveform-parade') {
    ctx.strokeStyle = GRID_MAJOR;
    ctx.setLineDash([2, 4]);
    for (let i = 1; i < 3; i++) {
      const x = plotLeft + (plotW * i) / 3;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, plotTop + plotH);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'center';
    ctx.fillStyle = TEXT;
    for (const [i, label] of ['R', 'G', 'B'].entries()) {
      ctx.fillText(label, plotLeft + (plotW * (i + 0.5)) / 3, plotTop + plotH + 9);
    }
  }

  ctx.strokeStyle = GRID_MAJOR;
  ctx.strokeRect(plotLeft + 0.5, plotTop + 0.5, plotW - 1, plotH - 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  ctx.fillText(unitSuffix(o.units), 4, plotTop + 6);
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

export function drawVectorscopeGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  const w = o.width;
  const h = o.height;
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const radius = (size / 2) * o.zoom;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = GRID_MAJOR;
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.stroke();

  const c = LUMA[o.matrix];
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (const level of [1, 0.75]) {
    const targets = chromaTargets(c, level);
    ctx.strokeStyle = level === 0.75 ? '#a8b3bd' : '#5a6470';
    for (const t of targets) {
      const [px, py] = chromaToScreen(t.cb, t.cr, size, o.zoom, cx, cy);
      if (Math.hypot(px - cx, py - cy) > radius + 2) continue;
      const s = Math.max(4, Math.min(16, t.radius * o.zoom * size * 0.14));
      ctx.strokeRect(px - s / 2, py - s / 2, s, s);
      if (level === 0.75) {
        ctx.fillStyle = '#a8b3bd';
        ctx.fillText(t.name[0]!.toUpperCase(), px + s / 2 + 2, py);
      }
    }
  }

  const ang = (SKIN_TONE_ANGLE_DEG * Math.PI) / 180;
  ctx.strokeStyle = '#d8a06a';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * radius * 0.95, cy - Math.sin(ang) * radius * 0.95);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = TEXT;
  ctx.textAlign = 'left';
  ctx.fillText(
    `${o.matrix.toUpperCase()} · ${o.zoom}x${o.range.limited ? ' · limited' : ' · full'}`,
    8,
    14,
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
): [number, number] {
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  return [((x - x0) / (x1 - x0)) * w, h - ((y - y0) / (y1 - y0)) * h];
}

export function screenToXy(
  px: number,
  py: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
): [number, number] {
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  return [x0 + (px / w) * (x1 - x0), y0 + ((h - py) / h) * (y1 - y0)];
}

function chartToScreen(
  x: number,
  y: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
): [number, number] {
  return coord === 'xy' ? xyToScreen(x, y, w, h, 'xy') : xyToScreen(...xyToUv(x, y), w, h, 'uv');
}

/**
 * Colour for one point on the locus.
 *
 * Spectral colours are outside sRGB, so a straight per-channel clamp destroys the
 * hue ramp: clamping collapsed 65 samples onto 21 distinct colours, with three
 * long pure runs (380-455 magenta, 515-550 green, 610-700 red). Drawn as a 3 px
 * stroke that reads as three flat facets joined by hard corners, which is exactly
 * the "the horseshoe has straight edges" report — the geometry was fine, the
 * colour was not.
 *
 * Normalising by the brightest channel instead preserves the hue and only scales
 * brightness. The locus outline is a reference curve, not a colour sample, so
 * dropping luminance is harmless and keeps every 5 nm step a distinct colour.
 */
function locusHue(x: number, y: number): string {
  const lin = xyToLinearSrgb([x, y]);
  const peak = Math.max(lin[0], lin[1], lin[2], 1e-6);
  const enc = (v: number): number => Math.round(linearToSrgb(Math.min(1, Math.max(0, v / peak))) * 255);
  return `rgb(${enc(lin[0])},${enc(lin[1])},${enc(lin[2])})`;
}

/**
 * Subdivisions per locus segment so no drawn segment exceeds ~3 px.
 *
 * Chosen by measurement: at 550x287 a 5 nm table with 6 subdivisions still turns
 * 6.5 degrees at the worst vertex, which is visible. 10 subdivisions brings that
 * to 4.2 degrees and 3 px segments, where the polyline is no longer readable as
 * straight edges.
 */
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

  // Draw the locus through a spline rather than as chords. The table is 5 nm, so
  // the vertices are already close, but the green to blue corner turns hard
  // enough that even those chords read as a corner. Subdivision is chosen from
  // the longest on-screen segment so the curve is equally smooth in a 275 px
  // grid cell and a 1100 px single view; a fixed count was either jagged or
  // wasteful depending on panel size.
  const screen = CIE1931_LOCUS.map((p) => chartToScreen(p[0], p[1], w, h, o.coord));
  const pts = smoothOpenSpline(screen, locusSubdivisions(screen));

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  // No fill. This canvas is stacked above the data canvas, so any opaque fill
  // here hides the point cloud — which is exactly how the CIE panel came to look
  // empty while its data layer was drawing correctly. Same rule the waveform
  // graticule follows.
  ctx.strokeStyle = '#4a5a66';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Colour the outline by wavelength, continuously.
  //
  // Two earlier attempts both read as "straight edges" even though the geometry
  // was right (measured deviation from the true 1 nm locus: 0.15 css px):
  //   - one 3 px stroke per 3 px segment, round caps: the caps bulge a semicircle
  //     past every joint, scalloping the outer edge with a 3 px period
  //   - one flat colour per 5 nm table entry: 65 hard hue steps along the arc,
  //     which the eye reads as flat facets
  //
  // So: keep short segments, but use butt caps and extend each one by half the
  // line width along its own tangent. Consecutive quads then overlap exactly
  // instead of leaving notches, and the hue can vary per segment.
  // 2 CSS px: the outline is a reference curve, and a thicker stroke turns each
  // 5 nm colour step into a visible block, which is what "hard edges" looked like.
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
    // Interpolate the wavelength, then the hue, so the ramp is smooth.
    const t = i / perSegment;
    const k = Math.min(CIE1931_LOCUS.length - 1, Math.floor(t));
    const k2 = Math.min(CIE1931_LOCUS.length - 1, k + 1);
    const f = Math.min(1, Math.max(0, t - k));
    const a = CIE1931_LOCUS[k]!;
    const b = CIE1931_LOCUS[k2]!;
    ctx.strokeStyle = locusHue(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
    ctx.beginPath();
    ctx.moveTo(x0 - ux * half, y0 - uy * half);
    ctx.lineTo(x1 + ux * half, y1 + uy * half);
    ctx.stroke();
  }

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const GAMUT_COLOR: Record<PrimariesId, string> = {
    rec709: '#7fa8d8',
    p3: '#d8c07f',
    rec2020: '#d87f7f',
  };
  const GAMUT_LABEL: Record<PrimariesId, string> = {
    rec709: 'Rec.709',
    p3: 'P3',
    rec2020: 'Rec.2020',
  };
  for (const id of o.gamuts) {
    const tri = gamutTriangle(id).map((p) => chartToScreen(p[0], p[1], w, h, o.coord));
    ctx.beginPath();
    tri.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = GAMUT_COLOR[id];
    ctx.lineWidth = 1;
    ctx.stroke();
    const [lx, ly] = tri[1]!;
    ctx.fillStyle = GAMUT_COLOR[id];
    ctx.fillText(GAMUT_LABEL[id], lx + 4, ly);
  }

  const white = o.coord === 'xy' ? ([0.3127, 0.329] as const) : xyToUv(0.3127, 0.329);
  const [wx, wy] = xyToScreen(white[0], white[1], w, h, o.coord);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(wx - 5, wy);
  ctx.lineTo(wx + 5, wy);
  ctx.moveTo(wx, wy - 5);
  ctx.lineTo(wx, wy + 5);
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.fillText(
    `D65 · ${o.coord === 'xy' ? 'CIE 1931 xy' : "CIE 1976 u'v'"} · ${o.primaries}`,
    8,
    14,
  );
}

/**
 * Single entry point used by the controller. Dispatch keeps the caller
 * ignorant of which graticule implementation a mode needs.
 */
export function drawGraticule(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions,
  gamuts: readonly PrimariesId[] = ['rec709'],
): void {
  switch (o.mode) {
    case 'vectorscope':
      drawVectorscopeGraticule(ctx, o);
      break;
    case 'cie':
      drawCieGraticule(ctx, { ...o, gamuts: [...gamuts] });
      break;
    default:
      drawWaveformGraticule(ctx, o);
  }
}
