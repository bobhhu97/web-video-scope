import { LUMA, chroma, type MatrixId } from '../core/color/matrices';
import { codeToAxis, legalBounds, type RangeSpec } from '../core/scale/quantize';
import { axisToUnit, unitSuffix, type Unit } from '../core/scale/units';

export interface ProbeSample {
  /** Source pixel coordinates. */
  x: number;
  y: number;
  /** 0-255 sRGB as displayed. */
  rgb: [number, number, number];
  /** Code values derived from the active range. */
  code: [number, number, number];
  luma: number;
  cb: number;
  cr: number;
  /** Axis positions 0..1 for drawing crosshairs. */
  axisY: number;
  axisCb: number;
  axisCr: number;
}

/**
 * Compute the probe readout for one pixel. Pure, so it can be unit tested
 * without a video or a canvas.
 */
export function describeSample(
  rgb: [number, number, number],
  x: number,
  y: number,
  matrix: MatrixId,
  range: RangeSpec,
): ProbeSample {
  const c = LUMA[matrix];
  const n: [number, number, number] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const bounds = legalBounds(range);
  const toCode = (v: number): number => bounds.black + (bounds.white - bounds.black) * v;
  const { cb, cr } = chroma(n[0], n[1], n[2], c);
  const luma = c.kr * n[0] + c.kg * n[1] + c.kb * n[2];
  return {
    x,
    y,
    rgb,
    code: [toCode(n[0]), toCode(n[1]), toCode(n[2])],
    luma,
    cb,
    cr,
    axisY: codeToAxis(toCode(luma), range.depth),
    // Chroma is drawn on the vectorscope, where the centre is 0 and the edge is
    // +-0.5, so shift into 0..1.
    axisCb: cb + 0.5,
    axisCr: cr + 0.5,
  };
}

export function formatSample(s: ProbeSample, unit: Unit, range: RangeSpec): string {
  const codeStr = s.code.map((v) => Math.round(v)).join(',');
  const yValue = Math.round(axisToUnit(s.axisY, unit, range));
  const suffix = unitSuffix(unit);
  const unitPart = suffix ? ` ${suffix}` : '';
  return `Y ${yValue}${unitPart} · code ${codeStr} · Cb ${s.cb.toFixed(3)} Cr ${s.cr.toFixed(3)} · (${s.x},${s.y})`;
}

/**
 * Samples a single pixel from the video by drawing it 1:1 into a 1x1 canvas.
 *
 * This reads the *displayed* pixels, so it agrees with what the display-path
 * scopes show. It cannot read a cross-origin video (the canvas would be
 * tainted); callers must report that case rather than showing a wrong value.
 */
export class Probe {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private active = false;
  private lastEmit = 0;

  constructor(
    private readonly onSample: (s: ProbeSample) => void,
    private readonly getState: () => { matrix: MatrixId; range: RangeSpec },
  ) {
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  enable(video: HTMLVideoElement): void {
    if (this.active) return;
    this.active = true;
    video.addEventListener('pointermove', this.handle);
    video.addEventListener('pointerleave', this.handleLeave);
    video.style.cursor = 'crosshair';
  }

  disable(video: HTMLVideoElement): void {
    if (!this.active) return;
    this.active = false;
    video.removeEventListener('pointermove', this.handle);
    video.removeEventListener('pointerleave', this.handleLeave);
    video.style.cursor = '';
  }

  private handleLeave = (): void => {
    this.video?.classList.remove('video-scopes-probing');
  };

  private video: HTMLVideoElement | null = null;

  private handle = (e: PointerEvent): void => {
    // Alt is the probe modifier: it must not interfere with normal playback UI.
    if (!e.altKey) return;
    const video = e.currentTarget as HTMLVideoElement;
    this.video = video;

    // Cap the sampling rate: reading one pixel forces a GPU readback.
    const now = performance.now();
    if (now - this.lastEmit < 60) return;
    this.lastEmit = now;

    const rect = video.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * video.videoWidth);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * video.videoHeight);
    if (x < 0 || y < 0 || x >= video.videoWidth || y >= video.videoHeight) return;

    const ctx = this.ctx;
    if (!ctx) return;
    try {
      ctx.drawImage(video, x, y, 1, 1, 0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      const { matrix, range } = this.getState();
      this.onSample(describeSample([d[0]!, d[1]!, d[2]!], x, y, matrix, range));
    } catch {
      // Cross-origin video: the canvas is tainted. Nothing to report.
    }
  };
}

/** Draw probe crosshairs onto a graticule canvas. */
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
  } else if (mode === 'cie') {
    // The CIE position needs XYZ, which the probe does not carry; mark luma only.
    const cy = plot.top + (1 - sample.axisY) * plot.height;
    ctx.beginPath();
    ctx.moveTo(plot.left, cy);
    ctx.lineTo(plot.left + plot.width, cy);
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
