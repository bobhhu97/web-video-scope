
import type { MatrixId } from './color/matrices';
import type { PrimariesId } from './color/primaries';
import type { LumaStats } from './scopes/stats';

export type TransferId = 'bt709' | 'srgb' | 'pq' | 'hlg' | 'unknown';
export type RangeMode = 'auto' | 'limited' | 'full';
export type RangeWarning = null | 'limited-treated-as-full' | 'full-treated-as-limited';

export interface ColorSpaceInfo {
  fullRange: boolean | null;
  matrix: MatrixId | null;
  primaries: PrimariesId | null;
  transfer: TransferId;
  format: string | null;
  source: 'webcodecs' | 'capture' | 'unknown';
}

export interface RangeDiagnosis {
  effective: 'limited' | 'full';
  warning: RangeWarning;
  confidence: number;
  source: ColorSpaceInfo['source'] | 'heuristic';
}

const LEGAL_LO = 0.045;
const LEGAL_HI = 0.085;
const LEGAL_P999_LO = 0.9;
const LEGAL_P999_HI = 0.94;

export class RangeDetector {
  private consecutive = 0;
  private pendingWarning: RangeWarning = null;
  private locked: RangeWarning = null;
  private last: RangeDiagnosis = {
    effective: 'limited',
    warning: null,
    confidence: 0,
    source: 'unknown',
  };

  constructor(private readonly frameThreshold = 3) {}

  reset(): void {
    this.consecutive = 0;
    this.pendingWarning = null;
    this.locked = null;
  }

  push(info: ColorSpaceInfo, stats: LumaStats): RangeDiagnosis {
    const hasMeta = info.fullRange !== null;
    const effective: 'limited' | 'full' = hasMeta
      ? info.fullRange
        ? 'full'
        : 'limited'
      : this.inferRange(stats);

    const candidate = this.classify(effective, stats);
    if (candidate === this.pendingWarning) {
      this.consecutive += 1;
      if (this.consecutive >= this.frameThreshold) this.locked = candidate;
    } else {
      this.pendingWarning = candidate;
      this.consecutive = candidate === null ? 0 : 1;
      if (candidate === null) this.locked = null;
    }

    const confidence = hasMeta ? 1 : 0.6;
    this.last = {
      effective,
      warning: this.locked,
      confidence,
      source: hasMeta ? info.source : 'heuristic',
    };
    return this.last;
  }

  get current(): RangeDiagnosis {
    return this.last;
  }

  private inferRange(stats: LumaStats): 'limited' | 'full' {
    const looksLegal =
      stats.p001 >= LEGAL_LO && stats.p001 <= LEGAL_HI &&
      stats.p999 >= LEGAL_P999_LO && stats.p999 <= LEGAL_P999_HI;
    return looksLegal ? 'limited' : 'full';
  }

  private classify(effective: 'limited' | 'full', stats: LumaStats): RangeWarning {
    const looksLegal =
      stats.p001 >= LEGAL_LO && stats.p001 <= LEGAL_HI &&
      stats.p999 >= LEGAL_P999_LO && stats.p999 <= LEGAL_P999_HI;
    const looksFull = stats.p001 <= 0.02 && stats.p999 >= 0.98 &&
      (stats.belowBlack > 0.002 || stats.aboveWhite > 0.002);

    if (effective === 'full' && looksLegal) return 'limited-treated-as-full';
    if (effective === 'limited' && looksFull) return 'full-treated-as-limited';
    return null;
  }
}

/**
 * Filter raw range diagnosis against the active sampling path and user range override:
 * - In `'display'` signalMode, Chrome's media compositor already expands limited-range
 *   (`16..235`) YUV streams to `[0.0 .. 1.0]` RGB before WebGPU reads them, so `[0..1]`
 *   occupancy is 100% normal and `'full-treated-as-limited'` must never fire.
 * - If the user has explicitly selected `'limited'` or `'full'` to resolve a mismatch,
 *   suppress the corresponding mismatch warning.
 */
export function sanitizeRangeDiagnosis(
  diagnosis: RangeDiagnosis,
  signalMode: 'display' | 'raw',
  rangeMode: RangeMode,
): RangeDiagnosis {
  let warning = diagnosis.warning;
  if (signalMode === 'display' && warning === 'full-treated-as-limited') {
    warning = null;
  }
  if (rangeMode === 'limited' && warning === 'limited-treated-as-full') {
    warning = null;
  }
  if (rangeMode === 'full' && warning === 'full-treated-as-limited') {
    warning = null;
  }
  return warning === diagnosis.warning ? diagnosis : { ...diagnosis, warning };
}
