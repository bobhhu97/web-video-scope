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
  /**
   * Per-layout panel assignment, when the user has customised it.
   *
   * Absent means "use the default for that layout". Stored per layout so that
   * customising the 4-up view does not disturb the 3-up one, and so that
   * switching back and forth keeps the user's choice.
   */
  panels: Partial<Record<Layout, ScopeMode[]>>;
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
  panels: {},
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

/** How many panels each layout shows. */
export const LAYOUT_SLOTS: Record<Layout, number> = {
  single: 1,
  pair: 2,
  triple: 3,
  grid: 4,
};

/**
 * The default scopes for a layout.
 *
 * `single` honours the picked scope; the wider layouts use a fixed, useful set so
 * that switching to four-up does not depend on what was selected for the single
 * slot.
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

/**
 * The scopes actually shown for a layout: the user's customisation when it is
 * still the right length, the default otherwise.
 *
 * Length is checked rather than trusted because a stored assignment can outlive a
 * change to `LAYOUT_SLOTS`, and a stale array of the wrong size would build the
 * wrong number of cells.
 */
export function resolvePanels(
  layout: Layout,
  picked: ScopeMode,
  overrides: Partial<Record<Layout, ScopeMode[]>> | undefined,
): ScopeMode[] {
  const custom = overrides?.[layout];
  if (custom && custom.length === LAYOUT_SLOTS[layout]) return [...custom];
  return panelsForLayout(layout, picked);
}

/**
 * Assign a scope to one slot, keeping every slot distinct.
 *
 * The renderer table is keyed by scope mode, so two cells showing the same scope
 * would fight over one renderer — one of them would render nothing. Swapping
 * instead of duplicating also matches what a colourist means when they drag a
 * scope somewhere it already exists.
 */
export function assignSlot(panels: ScopeMode[], slot: number, mode: ScopeMode): ScopeMode[] {
  const next = [...panels];
  const existing = next.indexOf(mode);
  if (existing === slot) return next;
  if (existing >= 0) next[existing] = next[slot]!;
  next[slot] = mode;
  return next;
}
