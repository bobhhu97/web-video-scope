import type {
  HistChannelMode,
  ParadeMode,
  ScopeMode,
  ToneFilter,
  TraceColorMode,
  WaveChannelMode,
} from '../gpu/scope-renderer';
import type { PrecisionMode } from '../gpu/downscale';
import type { MatrixId } from '../core/color/matrices';
import type { PrimariesId } from '../core/color/primaries';
import type { RangeMode } from '../core/range-detector';
import type { HdrMode, Unit } from '../core/scale/units';
import type { Locale } from './i18n';
import { DEFAULT_CAPTURE, type CaptureSettings } from '../core/scopes/capture-plan';

export type Layout = 'single' | 'pair' | 'triple' | 'grid';

export type FalseColorPreset = 'auto' | 'arri' | 'smallhd' | 'spectrum' | 'hdr-nits';

export interface ProbeDisplayConfig {
  /** Show floating value tooltip following the cursor on the video. */
  showTooltip: boolean;
  /** Draw synchronized signal-position rings across all visible scopes. */
  showScopeRings: boolean;
  /** Show 8-bit RGB (0..255). */
  showRgb8: boolean;
  /** Show 10-bit RGB (0..1023). */
  showRgb10: boolean;
  /** Show Luminance (IRE in SDR, cd/m² nits + PQ/HLG % in HDR). */
  showLuma: boolean;
  /** Show CIE 1931 (x, y) chromaticity coordinates. */
  showXy: boolean;
  /** Show CIE 1976 (u', v') chromaticity coordinates. */
  showUv: boolean;
  /** Show Chroma (Cb, Cr) offsets. */
  showYuv: boolean;
  /** Show #RRGGBB hex string. */
  showHex: boolean;
  /** Show source video pixel coordinates (X, Y). */
  showCoords: boolean;
}

export const DEFAULT_PROBE_CONFIG: ProbeDisplayConfig = {
  showTooltip: true,
  showScopeRings: true,
  showRgb8: true,
  showRgb10: true,
  showLuma: true,
  showXy: true,
  showUv: false,
  showYuv: false,
  showHex: false,
  showCoords: true,
};

/**
 * Independent per-cell scope configuration (aligned with DaVinci Resolve Scopes).
 * Each cell in a layout owns its own scope type, channel mix, coloring mode,
 * scale, gain, and cursor pan/zoom viewport.
 */
export interface CellConfig {
  mode: ScopeMode;
  waveChannels: WaveChannelMode;
  paradeMode: ParadeMode;
  histMode: HistChannelMode;
  traceMode: TraceColorMode;
  lowPass: boolean;
  units: Unit;
  gain: number;
  gamma: number;
  barTargets: 0.75 | 1;
  /** Magnify Vectorscope signal trace by 2× around center without zooming graticule/view. */
  vecScale2x?: boolean;
  showSkinLine: boolean;
  toneFilter: ToneFilter;
  coord: 'xy' | 'uv';
  gamuts: PrimariesId[];
  zoom: number;
  panX: number | null;
  panY: number | null;
}

export interface HudState {
  visible: boolean;
  /** UI language ('en' | 'zh'). */
  lang: Locale;
  layout: Layout;
  /** Currently focused cell index inside the active layout. */
  activeSlot: number;
  /** Mode shown when layout is 'single' (kept synced with slot 0 of 'single'). */
  mode: ScopeMode;
  /** Global analysis precision mode ('auto' follows governor; others pin resolution). */
  precision: PrecisionMode;
  /** Global dynamic-range / EOTF mode ('auto' switches scales on PQ / HLG metadata). */
  hdrMode: HdrMode;
  /** Manual colour primaries override ('auto' uses decoded frame primaries). */
  primariesMode: 'auto' | PrimariesId;
  /** SDR diffuse reference white in cd/m² (default 203 nits per ITU-R BT.2408). */
  sdrWhiteNits: number;
  /** Lower HDR Nit threshold separating shadows from midtones (default 100 nits). */
  nitLow: number;
  /** Upper HDR Nit threshold marking display peak / highlight clipping (default 1000 nits). */
  nitHigh: number;
  /** Overlay live False Color preview onto the source `<video>`. */
  videoFalseColor: boolean;
  /** Selected false-color profile ('arri' | 'smallhd' | 'spectrum' | 'hdr-nits'). */
  falseColorPreset: FalseColorPreset;
  /** Opacity of the false-color video overlay (0.3..1.0). */
  falseColorOpacity: number;
  /** Whether to display the false-color scale legend over the bottom-left of the video. */
  falseColorLegend: boolean;
  /** Toggleable Eyedropper mode (hover video without holding Alt). */
  eyedropperEnabled: boolean;
  /** Which fields & indicators the Eyedropper displays. */
  probeConfig: ProbeDisplayConfig;
  /** Floating scopes panel opacity (0.55..1.0). */
  panelOpacity: number;
  /** Graticule grid & label brightness multiplier (0.4..1.6). */
  graticuleBrightness: number;
  /** Image export preferences (format, multiplier, background). */
  capture: CaptureSettings;
  /** Global default trace coloring preference set from Settings ('default' | TraceColorMode). */
  defaultTraceMode?: 'default' | TraceColorMode;
  units: Unit;
  gain: number;
  gamma: number;
  zoom: number;
  rangeMode: RangeMode;
  matrixMode: 'auto' | MatrixId;
  barTargets: 0.75 | 1;
  coord: 'xy' | 'uv';
  signalMode: 'display' | 'raw';
  gamuts: PrimariesId[];
  panels: Partial<Record<Layout, ScopeMode[]>>;
  /** Per-layout independent cell configurations. */
  cells: Partial<Record<Layout, CellConfig[]>>;
  analysisFps: number;
  lockedTier: number | null;
  hostPosition: { left: number | null; top: number; right: number };
}

export function supportsHdrZones(mode: ScopeMode): boolean {
  return mode !== 'vectorscope' && mode !== 'cie';
}

export function resolveTraceForMode(
  mode: ScopeMode,
  pref: 'default' | TraceColorMode | undefined,
): TraceColorMode {
  const isScatter = mode === 'vectorscope' || mode === 'cie';
  if (!pref || pref === 'default') {
    return isScatter ? 'colorize' : 'channel';
  }
  if (pref === 'hdr-zones' && !supportsHdrZones(mode)) {
    return 'colorize';
  }
  if (pref === 'colorize' && mode === 'histogram') {
    return 'channel';
  }
  if (pref === 'channel' && isScatter) {
    return 'colorize';
  }
  return pref;
}

export function defaultCellForMode(
  mode: ScopeMode,
  base?: Partial<
    Pick<HudState, 'units' | 'gain' | 'gamma' | 'barTargets' | 'coord' | 'gamuts' | 'defaultTraceMode'>
  >,
): CellConfig {
  return {
    mode,
    waveChannels: mode === 'waveform-rgb' ? 'RGB' : 'Y',
    paradeMode: 'RGB',
    histMode: 'YRGB',
    traceMode: resolveTraceForMode(mode, base?.defaultTraceMode),
    lowPass: false,
    units: base?.units ?? 'auto',
    gain: base?.gain ?? 0.9,
    gamma: base?.gamma ?? 0.9,
    barTargets: base?.barTargets ?? 0.75,
    vecScale2x: false,
    showSkinLine: true,
    toneFilter: 'all',
    coord: base?.coord ?? 'xy',
    gamuts: base?.gamuts ? [...base.gamuts] : ['rec709', 'p3'],
    zoom: 1,
    panX: null,
    panY: null,
  };
}

export const DEFAULT_STATE: HudState = {
  visible: false,
  lang: 'en',
  layout: 'grid',
  activeSlot: 0,
  mode: 'waveform-luma',
  precision: 'auto',
  hdrMode: 'auto',
  primariesMode: 'auto',
  sdrWhiteNits: 203,
  nitLow: 100,
  nitHigh: 1000,
  videoFalseColor: false,
  falseColorPreset: 'auto',
  falseColorOpacity: 0.88,
  falseColorLegend: true,
  eyedropperEnabled: false,
  probeConfig: { ...DEFAULT_PROBE_CONFIG },
  panelOpacity: 0.97,
  graticuleBrightness: 1.0,
  capture: { ...DEFAULT_CAPTURE },
  defaultTraceMode: 'default',
  units: 'auto',
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  rangeMode: 'auto',
  matrixMode: 'auto',
  barTargets: 0.75,
  coord: 'xy',
  signalMode: 'display',
  gamuts: ['rec709', 'p3'],
  panels: {},
  cells: {},
  analysisFps: 30,
  lockedTier: null,
  hostPosition: { left: null, top: 16, right: 16 },
};

const KEY = 'video-scopes:state';

export async function loadSettings(): Promise<HudState> {
  try {
    const got = await chrome.storage.local.get(KEY);
    const raw = (got[KEY] ?? {}) as Partial<HudState>;
    return {
      ...DEFAULT_STATE,
      ...raw,
      probeConfig: { ...DEFAULT_PROBE_CONFIG, ...(raw.probeConfig ?? {}) },
      capture: { ...DEFAULT_CAPTURE, ...(raw.capture ?? {}) },
      cells: raw.cells ?? {},
      panels: raw.panels ?? {},
    };
  } catch {
    return {
      ...DEFAULT_STATE,
      probeConfig: { ...DEFAULT_PROBE_CONFIG },
      capture: { ...DEFAULT_CAPTURE },
    };
  }
}

export async function saveSettings(s: HudState): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEY]: s });
  } catch {
    // Storage can be unavailable during reload; in-memory state still applies.
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
 * Resolve the full per-cell configurations for `layout`, migrating seamlessly
 * from `panels` or default layout modes when `cells[layout]` is not yet stored.
 */
export function resolveCells(state: HudState, layout: Layout = state.layout): CellConfig[] {
  const expected = LAYOUT_SLOTS[layout];
  const stored = state.cells?.[layout];
  const fallbackModes = resolvePanels(layout, state.mode, state.panels);

  if (stored && stored.length === expected) {
    return stored.map((c, i) => {
      const mode = c.mode ?? fallbackModes[i]!;
      const merged: CellConfig = {
        ...defaultCellForMode(mode, state),
        ...c,
        gamuts: Array.isArray(c.gamuts) && c.gamuts.length > 0 ? [...c.gamuts] : [...state.gamuts],
      };
      if (!supportsHdrZones(mode) && merged.traceMode === 'hdr-zones') {
        merged.traceMode = 'colorize';
      }
      return merged;
    });
  }

  return fallbackModes.map((m) => defaultCellForMode(m, state));
}

/**
 * Assign a scope to one slot, swapping when the requested mode already occupies
 * another slot (matches `panel-assignment.test.ts` and Resolve drag-swap UX).
 */
export function assignSlot(panels: ScopeMode[], slot: number, mode: ScopeMode): ScopeMode[] {
  const next = [...panels];
  const existing = next.indexOf(mode);
  if (existing === slot) return next;
  if (existing >= 0) next[existing] = next[slot]!;
  next[slot] = mode;
  return next;
}

/** Swap or assign a `CellConfig` slot when changing scope via the cell header tag. */
export function assignCellSlot(
  cells: CellConfig[],
  slot: number,
  mode: ScopeMode,
  baseState?: HudState,
  allowDuplicate = false,
): CellConfig[] {
  const next = cells.map((c) => ({ ...c, gamuts: [...c.gamuts] }));
  const cur = next[slot];
  if (!cur) return next;

  const isBothWave =
    (cur.mode === 'waveform-luma' || cur.mode === 'waveform-rgb') &&
    (mode === 'waveform-luma' || mode === 'waveform-rgb');
  if (cur.mode === mode || isBothWave) {
    next[slot] = {
      ...cur,
      mode,
      waveChannels:
        mode === 'waveform-rgb' ? (cur.waveChannels === 'Y' ? 'RGB' : cur.waveChannels) : cur.waveChannels,
    };
    return next;
  }

  if (!allowDuplicate) {
    const existing = next.findIndex((c, idx) => idx !== slot && c.mode === mode);
    if (existing >= 0) {
      const displaced = next[slot]!;
      next[slot] = next[existing]!;
      next[existing] = displaced;
      return next;
    }
  }

  const fresh = defaultCellForMode(mode, baseState);
  // Only carry HDR Nit zone coloring across scopes that actually display luminance/code levels
  if (cur.traceMode === 'hdr-zones' && supportsHdrZones(mode)) {
    fresh.traceMode = 'hdr-zones';
  }
  next[slot] = fresh;
  return next;
}
