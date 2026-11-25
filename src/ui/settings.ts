import type { ScopeMode } from '../gpu/scope-renderer';
import type { PrimariesId } from '../core/color/primaries';
import type { RangeMode } from '../core/range-detector';
import type { Unit } from '../core/scale/units';

/**
 * Panel arrangements. `single` shows one scope at full size, `pair` two,
 * `triple` three stacked, `grid` the four-up view.
 */
export type Layout = 'single' | 'pair' | 'triple' | 'grid';

export interface HudState {
  visible: boolean;
  layout: Layout;
  /** Mode shown when layout is 'single'. */
  mode: ScopeMode;
  units: Unit;
  gain: number;
  gamma: number;
  zoom: number;
  rangeMode: RangeMode;
  /** CIE plot coordinate system; unused by the other scopes. */
  coord: 'xy' | 'uv';
  /**
   * 'display' reads the compositor's pixels (cheap, correct for SDR Rec.709).
   * 'raw' reads the decoder's I420 planes (exact code values, needed for HDR).
   */
  signalMode: 'display' | 'raw';
  gamuts: PrimariesId[];
  /** Analysis fps cap; the governor overrides this while unlocked. */
  analysisFps: number;
  /** null = follow the governor, a number = user-pinned quality tier. */
  lockedTier: number | null;
  hostPosition: { left: number | null; top: number; right: number };
}

export const DEFAULT_STATE: HudState = {
  visible: false,
  layout: 'grid',
  mode: 'waveform-luma',
  units: 'ire',
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  rangeMode: 'auto',
  coord: 'xy',
  signalMode: 'display',
  gamuts: ['rec709', 'p3'],
  analysisFps: 30,
  lockedTier: null,
  hostPosition: { left: null, top: 16, right: 16 },
};

const KEY = 'video-scopes:state';

export async function loadSettings(): Promise<HudState> {
  try {
    const got = await chrome.storage.local.get(KEY);
    return { ...DEFAULT_STATE, ...(got[KEY] ?? {}) } as HudState;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveSettings(s: HudState): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: s });
  } catch {
    // Storage can be unavailable (e.g. during extension reload); state is
    // still applied in-memory, so this is not fatal.
  }
}

/** Which panels a layout shows, in grid order. */
/**
 * Which scopes a layout shows.
 *
 * `single` and `pair` honour the user's picked scope; the wider layouts use a
 * fixed, useful set so that switching to four-up does not depend on what was
 * selected for the single slot.
 */
export function panelsForLayout(layout: Layout, picked: ScopeMode): ScopeMode[] {
  switch (layout) {
    case 'grid':
      return ['waveform-rgb', 'waveform-parade', 'vectorscope', 'cie'];
    case 'triple':
      return ['waveform-luma', 'waveform-parade', 'vectorscope'];
    case 'pair':
      return [picked, picked === 'vectorscope' ? 'waveform-parade' : 'vectorscope'];
    case 'single':
      return [picked];
  }
}
