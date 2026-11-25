import type { MatrixId } from '../core/color/matrices';
import type { PrimariesId } from '../core/color/primaries';
import type {
  ColorSpaceInfo,
  RangeDiagnosis,
  RangeMode,
  TransferId,
} from '../core/range-detector';
import type { RangeSpec } from '../core/scale/quantize';

/**
 * Map WebCodecs' string enums onto our own ids. Unknown values become null so
 * the UI can say "unknown" instead of silently assuming Rec.709 and lying.
 */
export function mapMatrix(m: string | null | undefined): MatrixId | null {
  switch (m) {
    case 'bt709':
      return 'bt709';
    case 'smpte170m':
    case 'bt470bg':
      return 'bt601';
    case 'bt2020-ncl':
      return 'bt2020';
    default:
      return null;
  }
}

export function mapPrimaries(p: string | null | undefined): PrimariesId | null {
  switch (p) {
    case 'bt709':
      return 'rec709';
    case 'smpte432':
    case 'display-p3':
      return 'p3';
    case 'bt2020':
      return 'rec2020';
    default:
      return null;
  }
}

export function mapTransfer(t: string | null | undefined): TransferId {
  switch (t) {
    case 'bt709':
      return 'bt709';
    case 'iec61966-2-1':
      return 'srgb';
    case 'pq':
    case 'smpte2084':
      return 'pq';
    case 'hlg':
    case 'arib-std-b67':
      return 'hlg';
    default:
      return 'unknown';
  }
}

export const UNKNOWN_COLOR_SPACE: ColorSpaceInfo = {
  fullRange: null,
  matrix: null,
  primaries: null,
  transfer: 'unknown',
  format: null,
  source: 'unknown',
};

export function normalizeColorSpace(frame: VideoFrame | null): ColorSpaceInfo {
  if (!frame) return UNKNOWN_COLOR_SPACE;
  const cs = frame.colorSpace;
  return {
    fullRange: cs.fullRange ?? null,
    matrix: mapMatrix(cs.matrix),
    primaries: mapPrimaries(cs.primaries),
    transfer: mapTransfer(cs.transfer),
    format: frame.format ?? null,
    source: 'webcodecs',
  };
}

/**
 * Read the decoded colour metadata. Wrapping the element in a VideoFrame is
 * cheap (it references the existing media frame) and exposes the VUI values
 * that the compositor would otherwise hide.
 */
export function readVideoColorSpace(video: HTMLVideoElement): ColorSpaceInfo {
  try {
    const frame = new VideoFrame(video);
    try {
      return normalizeColorSpace(frame);
    } finally {
      frame.close();
    }
  } catch {
    return UNKNOWN_COLOR_SPACE;
  }
}

/** Combine the user's override with the detected/diagnosed range. */
export function applyRangeMode(
  mode: RangeMode,
  info: ColorSpaceInfo,
  diagnosis: RangeDiagnosis,
): RangeSpec {
  const limited =
    mode === 'limited' ? true : mode === 'full' ? false : diagnosis.effective === 'limited';
  // HDR transfers use 10-bit code values; everything else we treat as 8-bit
  // because the compositor hands us 8-bit RGBA.
  const depth: 8 | 10 = info.transfer === 'pq' || info.transfer === 'hlg' ? 10 : 8;
  return { limited, depth };
}
