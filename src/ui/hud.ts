import { cieViewportFrame, zoomCieViewportAt } from '../core/color/cie-frame';
import type { PrimariesId } from '../core/color/primaries';
import { clampVectorscopePan, vectorscopeFrame, zoomVectorscopeAt } from '../core/color/vectorscope-frame';
import type { ColorSpaceInfo, RangeDiagnosis } from '../core/range-detector';
import type { QualityTier } from '../core/perf-governor';
import type { HdrMode } from '../core/scale/units';
import type { PrecisionMode } from '../gpu/downscale';
import type {
  HistChannelMode,
  ParadeMode,
  ScopeMode,
  ToneFilter,
  TraceColorMode,
  WaveChannelMode,
} from '../gpu/scope-renderer';
import { WAVE_PAD } from './graticule';
import { t, type I18nStrings, type Locale } from './i18n';
import { pipSupported } from './pip';
import {
  DEFAULT_PROBE_CONFIG,
  DEFAULT_STATE,
  assignCellSlot,
  defaultCellForMode,
  resolveCells,
  resolveTraceForMode,
  supportsHdrZones,
  type CellConfig,
  type FalseColorPreset,
  type HudState,
  type Layout,
  type ProbeDisplayConfig,
} from './settings';
import {
  DEFAULT_CAPTURE,
  effectiveBackground,
  planCapture,
  type CaptureSettings,
} from '../core/scopes/capture-plan';

export interface PanelTargets {
  slot: number;
  mode: ScopeMode;
  gpu: HTMLCanvasElement;
  grat: HTMLCanvasElement;
  marker?: HTMLCanvasElement;
}

interface TrustedTypePolicyLike {
  createHTML: (s: string) => unknown;
}
interface TrustedTypesFactoryLike {
  createPolicy: (name: string, rules: { createHTML: (s: string) => string }) => TrustedTypePolicyLike;
}

const trustedPolicies = new WeakMap<object, TrustedTypePolicyLike | null>();

function setTrustedHtml(target: Element | ShadowRoot, html: string): void {
  const doc = target.ownerDocument ?? document;
  const win = (doc.defaultView ?? window) as Window & { trustedTypes?: TrustedTypesFactoryLike };
  const tt = win?.trustedTypes;
  if (tt && typeof tt.createPolicy === 'function') {
    let policy = trustedPolicies.get(win);
    if (policy === undefined) {
      for (const name of ['video-scopes-ui', 'default']) {
        try {
          policy = tt.createPolicy(name, { createHTML: (s) => s });
          break;
        } catch {
          policy = null;
        }
      }
      trustedPolicies.set(win, policy ?? null);
    }
    if (policy) {
      (target as unknown as { innerHTML: unknown }).innerHTML = policy.createHTML(html);
      return;
    }
  }
  target.innerHTML = html;
}

export interface HudHandlers {
  onStateChange(patch: Partial<HudState>): void;
  onCellChange(layout: Layout, slot: number, patch: Partial<CellConfig>): void;
  onCellsReplace(layout: Layout, cells: CellConfig[]): void;
  onLayoutChange(layout: Layout): void;
  onPanelsChange(layout: Layout, panels: ScopeMode[]): void;
  onResetAll?(): void;
  onResize?(): void;
  onClose(): void;
  onOpenPip(): void;
  onToggleLock(): void;
  /** Save the given panel (or the active one) as an image. */
  onCapture?(slot: number): void;
}

const HOST_ID = 'video-scopes-host';

function layoutClass(layout: Layout): string {
  return layout === 'grid' ? 'quad' : layout;
}

function isWaveMode(m: ScopeMode): boolean {
  return m === 'waveform-luma' || m === 'waveform-rgb';
}

function pickerOptionsHtml(cellMode: ScopeMode, s: I18nStrings): string {
  const waveVal: ScopeMode = cellMode === 'waveform-rgb' ? 'waveform-rgb' : 'waveform-luma';
  const entries: [ScopeMode, string][] = [
    [waveVal, s.scopeWaveform],
    ['waveform-parade', s.scopeParade],
    ['histogram', s.scopeHistogram],
    ['vectorscope', s.modeVector],
    ['cie', s.modeCie],
  ];
  return entries.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
}

const STYLE = `
  :host { all: initial; }

  .panel {
    position: relative;
    display: flex; flex-direction: column;
    height: 100%; min-height: 0;
    font: 11px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #c2cfd8; background: rgba(10, 14, 18, var(--panel-alpha, 0.97));
    border: 1px solid #ffffff1f; border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 12px 36px rgba(0,0,0,0.55);
  }

  /* ---- Top Window Bar -------------------------------------------------- */
  header {
    display: flex; align-items: center; gap: 5px; flex: 0 0 auto;
    padding: 3px 7px; background: #12181f;
    cursor: move; user-select: none;
    border-bottom: 1px solid #ffffff14;
  }
  header .title { color: #e2edf5; font-weight: 600; letter-spacing: 0.02em; font-size: 11px; white-space: nowrap; }
  header .spacer { flex: 1; min-width: 4px; }

  .badge {
    padding: 1px 6px; border-radius: 999px; background: #1b242e;
    color: #93a8b8; white-space: nowrap; font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .badge.ok { background: #142b1f; color: #7ce0a3; }
  .badge.warn { background: #3b2810; color: #f6c16b; }
  .badge.hdr { background: #2d1b2e; color: #f59be0; border: 1px solid #f59be033; }
  .badge.hdr.alert { background: #3b1822; color: #ff859d; border-color: #ff6b8b55; }
  .badge.locked { background: #16263d; color: #8ab8f0; }
  .badge.mono { font-variant-numeric: tabular-nums; cursor: pointer; }

  button {
    font: 10.5px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #cfe0ea; background: #17212b;
    border: 1px solid #ffffff1e; border-radius: 4px;
    padding: 0 6px; cursor: pointer;
  }
  button:hover { background: #21303f; border-color: #ffffff36; }
  button[aria-pressed="true"], button.active {
    background: #1d3d59; border-color: #5591c4; color: #e5f3ff;
  }
  button.fc-on {
    background: #3d2230; border-color: #f43f5e; color: #fecdd3;
  }
  button.eyedropper-on {
    background: #173b34; border-color: #34d399; color: #d1fae5;
  }
  button.icon-btn {
    padding: 0 5px; min-width: 22px; font-size: 10.5px;
  }

  /* ---- Resolve Studio Toolbar ------------------------------------------ */
  nav.bar {
    display: flex; flex-wrap: wrap; gap: 3px 5px; align-items: center; flex: 0 0 auto;
    padding: 3px 6px; background: #0e1318;
    border-bottom: 1px solid #ffffff12;
  }
  nav.bar .grp { display: flex; gap: 2px; align-items: center; flex: 0 0 auto; }
  nav.bar .sep { width: 1px; height: 15px; background: #ffffff1a; flex: 0 0 auto; }
  nav.bar .bar-spacer { flex: 1 1 auto; min-width: 2px; }
  nav.bar button { white-space: nowrap; min-width: 24px; padding: 0 5px; height: 20px; }
  #layouts button {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; min-width: 24px; height: 20px; padding: 0;
  }
  #layouts button svg {
    width: 13px; height: 13px; display: block; pointer-events: none;
  }
  #modes button[aria-pressed="true"],
  #modes button.scope-active {
    background: #143a27;
    border-color: #34d399;
    color: #d1fae5;
    box-shadow: inset 0 0 0 1px rgba(52, 211, 153, 0.18);
  }
  #modes button[aria-pressed="true"]:hover,
  #modes button.scope-active:hover {
    background: #1a4b33;
    border-color: #6ee7b7;
  }
  nav.bar select {
    width: auto; font-size: 10px; padding: 1px 4px; height: 20px;
    background: #151e27; color: #cfe0ea; border: 1px solid #ffffff22; border-radius: 4px;
  }

  /* ---- Scope Grid & Per-Cell Resolve Chrome ---------------------------- */
  .grid {
    flex: 1 1 auto; min-height: 0;
    display: grid; gap: 3px; padding: 3px;
    background: #06090c;
  }
  .grid.single { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  .grid.pair { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
  .grid.quad { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .grid.triple { grid-template-columns: 1fr; grid-template-rows: repeat(3, 1fr); }

  .cell {
    position: relative; min-width: 0; min-height: 0;
    display: flex; flex-direction: column;
    background: #0c1016; border: 1px solid #ffffff12; border-radius: 4px;
    overflow: hidden;
  }
  .cell[data-active="true"] {
    border-color: #4b82b066;
  }

  .cell-bar {
    display: flex; align-items: center; gap: 3px; flex: 0 0 20px; height: 20px;
    padding: 0 4px; background: #11171f; border-bottom: 1px solid #ffffff10;
    z-index: 3; overflow-x: auto; scrollbar-width: none; user-select: none;
  }
  .cell-bar::-webkit-scrollbar { display: none; }
  .cell-bar .cell-spacer { flex: 1 1 auto; min-width: 2px; }

  .cell select.tag {
    font: 10px/1.2 -apple-system, BlinkMacSystemFont, "PingFang SC", ui-monospace, monospace;
    color: #d5e4ef; background: #18232f;
    border: 1px solid #ffffff24; border-radius: 3px;
    padding: 1px 3px; width: auto; max-width: 82px; cursor: pointer; flex: 0 0 auto;
  }
  .cell select.tag:hover { border-color: #6599c4; }

  .cell-pills {
    display: flex; gap: 2px; align-items: center; flex: 0 0 auto;
  }
  .pill {
    font: 9.5px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 1px 4px; border-radius: 3px;
    background: transparent; color: #7f93a3;
    border: 1px solid transparent; cursor: pointer; min-width: 0;
  }
  .pill:hover { color: #d4e4f0; background: #ffffff0f; }
  .pill.on {
    color: #e6f4ff; background: #1e3b56; border-color: #4f87b5;
  }
  .pill.nit-on {
    color: #ffd9e2; background: #441c2c; border-color: #f43f5e88;
  }
  .pill.zoom-reset {
    color: #8ad4ff; background: #152b3d; border-color: #38bdf855;
  }

  .cell-gear {
    font-size: 10px; line-height: 1; padding: 2px 4px;
    background: transparent; border-color: transparent; color: #8ba0b0; flex: 0 0 auto;
  }
  .cell-gear:hover, .cell-gear.open {
    color: #e6f3ff; background: #1e354a; border-color: #4e80ab;
  }

  .cell-stage {
    position: relative; flex: 1 1 auto; min-height: 0; min-width: 0;
    touch-action: none; cursor: crosshair;
  }
  .cell-stage.zoomed { cursor: grab; }
  .cell-stage.dragging { cursor: grabbing; }
  .cell-stage canvas {
    position: absolute; inset: 0; width: 100%; height: 100%; display: block;
  }
  .cell-stage canvas.grat, .cell-stage canvas.marker { pointer-events: none; }

  /* ---- Per-Cell Resolve Settings Popover ------------------------------- */
  .cell-popover {
    position: absolute; top: 22px; right: 4px; z-index: 10;
    width: min(244px, calc(100% - 8px)); max-height: calc(100% - 26px);
    overflow-y: auto; padding: 7px 8px;
    background: rgba(14, 20, 27, 0.96); backdrop-filter: blur(8px);
    border: 1px solid #4d7ea888; border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.65);
    display: grid; gap: 5px;
    font: 10px/1.35 -apple-system, BlinkMacSystemFont, "PingFang SC", ui-monospace, monospace;
  }
  .cell-popover[hidden] { display: none !important; }
  .pop-row {
    display: grid; grid-template-columns: 62px 1fr; gap: 5px; align-items: center;
  }
  .pop-row > span { color: #8ba0b0; }
  .pop-checks { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .pop-checks label { display: inline-flex; gap: 3px; align-items: center; cursor: pointer; color: #bfd0dc; }
  .pop-actions {
    display: flex; gap: 3px; justify-content: space-between; align-items: center;
    padding-top: 3px; border-top: 1px solid #ffffff12;
  }
  .pop-zoom-grp { display: flex; gap: 2px; }
  .pop-zoom-grp button { padding: 0 5px; font-size: 9.5px; }

  /* ---- Global Settings Modal Sheet ------------------------------------- */
  .settings-backdrop {
    position: absolute; inset: 0; z-index: 30;
    background: rgba(4, 7, 10, 0.62);
    backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: 12px;
  }
  .settings-backdrop[hidden] { display: none !important; }
  .settings-sheet {
    width: min(520px, 100%);
    max-height: 100%;
    display: flex; flex-direction: column;
    background: #10161e;
    border: 1px solid #4d7ea877;
    border-radius: 8px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.72);
    overflow: hidden;
  }
  .settings-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 12px; background: #151e28;
    border-bottom: 1px solid #ffffff14;
    font-weight: 600; color: #e6f1f8; font-size: 11.5px;
  }
  .settings-body {
    padding: 10px 12px; overflow-y: auto;
    display: grid; gap: 10px;
    font-size: 10.5px;
  }
  .sec {
    background: #0b1016; border: 1px solid #ffffff12;
    border-radius: 6px; padding: 8px 10px;
    display: grid; gap: 6px;
  }
  .sec-title {
    color: #8ab8e6; font-weight: 600; font-size: 10.5px;
    padding-bottom: 3px; border-bottom: 1px solid #ffffff0f;
  }
  .set-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
    gap: 6px 12px; align-items: center;
  }
  .set-field {
    display: grid; grid-template-columns: 94px 1fr; gap: 6px; align-items: center;
  }
  .set-field > span { color: #95aab9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .set-hint { color: #6f8291; font-size: 10px; line-height: 1.45; }
  .set-hint:empty { display: none; }
  .seg-btns { display: inline-flex; gap: 3px; }
  .check-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
    gap: 5px 10px;
  }
  .check-grid label {
    display: inline-flex; align-items: center; gap: 5px;
    color: #c6d6e2; cursor: pointer; user-select: none;
  }
  .settings-foot {
    display: flex; justify-content: space-between; align-items: center;
    padding: 7px 12px; background: #141c25; border-top: 1px solid #ffffff14;
  }
  .btn-danger {
    color: #fecdd3; background: #361923; border-color: #f43f5e66;
  }
  .btn-danger:hover { background: #4c2130; border-color: #fb7185; }

  /* ---- Global Signal & HDR Nit Thresholds Strip ------------------------ */
  details.options {
    flex: 0 0 auto; background: #0e1318;
    border-top: 1px solid #ffffff14;
    max-height: 40%; overflow-y: auto; scrollbar-width: none;
  }
  details.options::-webkit-scrollbar { display: none; }
  details.options > summary {
    padding: 2px 8px; cursor: pointer; color: #8ea3b0;
    font: 10px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", ui-monospace, monospace;
    list-style: none; user-select: none; display: flex; align-items: center; gap: 6px;
  }
  details.options > summary::-webkit-details-marker { display: none; }
  details.options > summary::before { content: '▸'; font-size: 9px; }
  details.options[open] > summary::before { content: '▾'; font-size: 9px; }
  details.options > summary .sum-hint { color: #647887; margin-left: auto; font-size: 9.5px; }

  .opts {
    display: grid; gap: 4px 8px; padding: 3px 8px 7px;
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    align-items: center;
  }
  .opts label {
    display: grid; grid-template-columns: auto 1fr; gap: 4px;
    align-items: center; color: #8ea3b0; font: 10px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  select, input[type=number] {
    font: 10px/1.3 -apple-system, BlinkMacSystemFont, "PingFang SC", ui-monospace, monospace;
    color: #cfe0ea; background: #16202a;
    border: 1px solid #ffffff22; border-radius: 4px;
    padding: 1px 3px; width: 100%; min-width: 0; box-sizing: border-box;
  }
  input[type=range] { width: 100%; min-width: 0; accent-color: #4e87b8; margin: 0; }

  .hdr-strip {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 4px 8px 6px; border-top: 1px solid #ffffff0d;
    font: 10px/1.3 -apple-system, BlinkMacSystemFont, "PingFang SC", ui-monospace, monospace; color: #9db2c0;
  }
  .hdr-strip input[type=number] { width: 58px; }
  .hdr-strip .nit-lo { border-color: #38bdf866; color: #bae6fd; }
  .hdr-strip .nit-hi { border-color: #fb923c88; color: #fed7aa; }

  .notice {
    flex: 0 0 auto; margin: 0; padding: 3px 8px;
    font: 10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #3a2a12; color: #f0c070;
    border-bottom: 1px solid #ffffff10;
  }

  .resize-grip {
    position: absolute; right: 0; bottom: 0; width: 14px; height: 14px;
    cursor: nwse-resize; z-index: 60; touch-action: none;
    background: linear-gradient(135deg, transparent 52%, #7f95a666 52%, #7f95a666 64%, transparent 64%, transparent 76%, #7f95a699 76%);
    border-bottom-right-radius: 6px;
  }
  .resize-grip:hover {
    background: linear-gradient(135deg, transparent 52%, #34d399aa 52%, #34d399aa 64%, transparent 64%, transparent 76%, #34d399dd 76%);
  }
`;

export class Hud {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private doc: Document | null = null;
  private isFill = false;
  private resizeObserver: ResizeObserver | null = null;
  private targets: PanelTargets[] = [];
  private openPopoverSlot: number | null = null;
  private settingsOpen = false;
  private renderedLang: Locale = 'en';
  private state: HudState;
  private readonly handlers: HudHandlers;

  constructor(initial: HudState, handlers: HudHandlers) {
    this.state = initial;
    this.renderedLang = initial.lang ?? 'en';
    this.handlers = handlers;
  }

  get mounted(): boolean {
    return this.host !== null;
  }

  get hostElement(): HTMLElement | null {
    return this.host;
  }

  private i18n(): I18nStrings {
    return t(this.state.lang ?? 'en');
  }

  mount(doc: Document = document, opts: { fill?: boolean } = {}): void {
    if (this.host) return;
    this.isFill = !!opts.fill;
    for (const stale of Array.from(doc.querySelectorAll(`#${HOST_ID}`))) {
      stale.remove();
    }
    const host = doc.createElement('div');
    host.id = HOST_ID;
    const imp = (prop: string, val: string): void => {
      host.style.setProperty(prop, val, 'important');
    };
    imp('display', 'block');
    imp('visibility', 'visible');
    imp('opacity', '1');
    imp('margin', '0');
    imp('padding', '0');
    imp('border', '0');
    imp('background', 'transparent');
    imp('box-sizing', 'border-box');
    imp('overflow', 'hidden');
    if (opts.fill) {
      imp('position', 'absolute');
      imp('inset', '0');
      imp('width', '100%');
      imp('height', '100%');
      imp('min-width', '320px');
      imp('min-height', '240px');
      imp('z-index', '1');
    } else {
      imp('position', 'fixed');
      imp('top', '16px');
      imp('right', '16px');
      imp('left', 'auto');
      imp('bottom', 'auto');
      imp('width', '780px');
      imp('height', '560px');
      imp('min-width', '340px');
      imp('min-height', '260px');
      imp('z-index', '2147483646');
    }

    const root = host.attachShadow({ mode: 'open' });
    this.renderedLang = this.state.lang ?? 'en';
    setTrustedHtml(root, this.template());

    this.host = host;
    this.root = root;
    this.doc = doc;
    if (!opts.fill) this.applyPosition();
    (doc.documentElement ?? doc.body).appendChild(host);

    this.buildCells();
    this.wire();
    this.syncInputs();

    const win = doc.defaultView ?? window;
    const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const grid = root.querySelector('.grid');
    if (typeof RO === 'function' && grid) {
      this.resizeObserver = new RO(() => this.handlers.onResize?.());
      this.resizeObserver.observe(grid);
    }
  }

  unmount(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.host) {
      const anyHost = this.host as HTMLElement & { hidePopover?: () => void };
      try {
        anyHost.hidePopover?.();
      } catch {
        // Ignore
      }
      this.host.remove();
    }
    this.host = null;
    this.root = null;
    this.targets = [];
    this.openPopoverSlot = null;
    this.settingsOpen = false;
  }

  panelCanvases(): PanelTargets[] {
    return [...this.targets];
  }

  setState(state: HudState): void {
    const prevLang = this.renderedLang;
    const { layout: _layout, mode: _mode, ...rest } = state;
    this.state = { ...this.state, ...rest };
    if (!this.isFill) this.applyPosition();
    if ((this.state.lang ?? 'en') !== prevLang) {
      this.renderedLang = this.state.lang ?? 'en';
      this.applyLocalization();
    }
    this.syncInputs();
    this.syncModeButtons();
    this.refreshCellChrome();
    if (this.settingsOpen) this.syncSettingsModal();
  }

  relayout(layout: Layout): void {
    if (!this.root) return;
    this.state = { ...this.state, layout };
    const grid = this.root.querySelector('.grid') as HTMLElement | null;
    if (!grid) return;
    grid.className = `grid ${layoutClass(layout)}`;
    this.openPopoverSlot = null;
    this.buildCells(layout);
    this.syncModeButtons();
    this.syncInputs();
  }

  setSingleMode(mode: ScopeMode): void {
    this.state = { ...this.state, mode };
    this.syncModeButtons();
    if (this.state.layout === 'single') {
      const grid = this.root?.querySelector('.grid') as HTMLElement | null;
      if (grid) {
        grid.className = 'grid single';
        this.buildCells('single');
      }
    }
  }

  setColorInfo(info: ColorSpaceInfo): void {
    const el = this.root?.getElementById('cs');
    if (!el) return;
    const range = info.fullRange === null ? 'range?' : info.fullRange ? 'full' : 'limited';
    const primOverride =
      this.state.primariesMode && this.state.primariesMode !== 'auto'
        ? this.state.primariesMode.toUpperCase()
        : null;
    const prim = primOverride ?? (info.primaries ? info.primaries.toUpperCase() : null);
    const inferredMatrix =
      info.matrix ??
      (info.primaries === 'rec2020'
        ? 'bt2020'
        : info.primaries === 'rec709' || info.transfer === 'srgb' || info.transfer === 'bt709'
          ? 'bt709'
          : '?');
    const mat = (
      this.state.matrixMode && this.state.matrixMode !== 'auto'
        ? this.state.matrixMode
        : inferredMatrix
    ).toUpperCase();
    const parts = [prim && prim !== 'REC709' ? `${prim}/${mat}` : mat, `src:${range}`, info.transfer];
    if (info.format) parts.push(info.format);
    el.textContent = parts.join(' · ');
    const isHdr = info.transfer === 'pq' || info.transfer === 'hlg' || info.primaries === 'rec2020';
    el.className = `badge ${isHdr ? 'hdr' : ''}`;
    el.title = 'Decoded video VUI metadata / active color space override.';
  }

  setDiagnosis(
    d: RangeDiagnosis & { effectiveAxisLabel?: string },
    hdrStats?: { highPct: number; maxNits: number; active: boolean; nitHigh: number },
  ): void {
    const status = this.root?.getElementById('status');
    const warn = this.root?.getElementById('warn');
    const hdrEl = this.root?.getElementById('hdr-stat');
    if (status) {
      const label = d.effectiveAxisLabel ?? d.effective;
      status.textContent = `axis:${label}`;
      status.className = `badge ${d.effective === 'full' ? 'ok' : ''}`;
    }
    if (warn) {
      if (d.warning) {
        warn.hidden = false;
        warn.textContent =
          d.warning === 'limited-treated-as-full' ? '⚠ limited as full' : '⚠ full as limited';
        warn.title = d.warning;
      } else {
        warn.hidden = true;
      }
    }
    if (hdrEl) {
      if (hdrStats?.active) {
        hdrEl.hidden = false;
        const pct = hdrStats.highPct >= 10 ? hdrStats.highPct.toFixed(0) : hdrStats.highPct.toFixed(1);
        hdrEl.textContent = `Max ${Math.round(hdrStats.maxNits)}n · >${Math.round(hdrStats.nitHigh)}n ${pct}%`;
        hdrEl.className = `badge hdr ${hdrStats.highPct > 0.05 ? 'alert' : ''}`;
      } else {
        hdrEl.hidden = true;
      }
    }
  }

  setPerf(
    fps: number,
    gpuMs: number | null,
    tier: QualityTier,
    upload?: 'external' | 'copy' | 'raw',
    dims?: { width: number; height: number } | null,
  ): void {
    const el = this.root?.getElementById('perf');
    if (!el) return;
    const pinned = this.state.precision !== 'auto' || this.state.lockedTier !== null;
    const parts = [`${Math.round(fps)}fps`];
    if (gpuMs !== null) parts.push(`${gpuMs.toFixed(1)}ms`);
    if (upload === 'external') parts.push('0copy');
    else if (upload) parts.push(upload);
    if (dims) parts.push(`${dims.height}p`);
    else parts.push(pinned ? `lock` : `t${tier}`);
    el.textContent = parts.join(' ');
    el.className = `badge mono ${pinned ? 'locked' : ''}`;
  }

  setNotice(text: string | null): void {
    const el = this.root?.getElementById('notice');
    if (!el) return;
    el.hidden = text === null;
    if (text !== null) el.textContent = text;
  }

  setProbe(text: string | null): void {
    const el = this.root?.getElementById('probe');
    if (!el) return;
    el.hidden = text === null;
    if (text !== null) el.textContent = text;
  }

  private applyPosition(): void {
    if (!this.host || this.isFill) return;
    const { left, top, right } = this.state.hostPosition;
    this.host.style.setProperty('top', `${top}px`, 'important');
    if (left === null) {
      this.host.style.setProperty('left', 'auto', 'important');
      this.host.style.setProperty('right', `${right}px`, 'important');
    } else {
      this.host.style.setProperty('left', `${left}px`, 'important');
      this.host.style.setProperty('right', 'auto', 'important');
    }
  }

  private renderToolbarModesHtml(): string {
    const s = this.i18n();
    const items: { mode: ScopeMode; label: string; title: string }[] = [
      { mode: 'waveform-luma', label: s.modeWave, title: s.scopeWaveform },
      { mode: 'waveform-parade', label: s.modeParade, title: s.scopeParade },
      { mode: 'histogram', label: s.modeHist, title: s.scopeHistogram },
      { mode: 'vectorscope', label: s.modeVector, title: s.scopeVector },
      { mode: 'cie', label: s.modeCie, title: s.scopeCie },
    ];
    return items
      .map((m) => `<button data-mode="${m.mode}" type="button" title="${m.title}">${m.label}</button>`)
      .join('');
  }

  private renderLayoutsHtml(): string {
    const s = this.i18n();
    const items: { layout: Layout; icon: string; title: string }[] = [
      {
        layout: 'single',
        title: s.layout1,
        icon: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.25"><rect x="1.5" y="2" width="11" height="10" rx="1.2"/></svg>`,
      },
      {
        layout: 'pair',
        title: s.layout2,
        icon: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.2"><rect x="1.3" y="2" width="4.8" height="10" rx="1"/><rect x="7.9" y="2" width="4.8" height="10" rx="1"/></svg>`,
      },
      {
        layout: 'triple',
        title: s.layout3,
        icon: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.15"><rect x="1.5" y="1.4" width="11" height="2.7" rx="0.7"/><rect x="1.5" y="5.65" width="11" height="2.7" rx="0.7"/><rect x="1.5" y="9.9" width="11" height="2.7" rx="0.7"/></svg>`,
      },
      {
        layout: 'grid',
        title: s.layout4,
        icon: `<svg viewBox="0 0 14 14" aria-hidden="true" fill="currentColor" fill-opacity="0.16" stroke="currentColor" stroke-width="1.2"><rect x="1.3" y="1.5" width="4.8" height="4.6" rx="0.9"/><rect x="7.9" y="1.5" width="4.8" height="4.6" rx="0.9"/><rect x="1.3" y="7.9" width="4.8" height="4.6" rx="0.9"/><rect x="7.9" y="7.9" width="4.8" height="4.6" rx="0.9"/></svg>`,
      },
    ];
    return items
      .map(
        (l) =>
          `<button data-layout="${l.layout}" type="button" title="${l.title}" aria-label="${l.title}" aria-pressed="false">${l.icon}</button>`,
      )
      .join('');
  }

  private renderSettingsSheetHtml(): string {
    const s = this.i18n();
    const lang = this.state.lang ?? 'en';
    const pc = this.state.probeConfig ?? DEFAULT_PROBE_CONFIG;
    return `
      <div class="settings-sheet" role="dialog" aria-label="${s.settingsTitle}">
        <div class="settings-head">
          <span>⚙ ${s.settingsTitle}</span>
          <button id="settings-close" type="button" class="icon-btn">✕</button>
        </div>
        <div class="settings-body">
          <div class="sec">
            <div class="sec-title">${s.secGeneral}</div>
            <div class="set-grid">
              <div class="set-field">
                <span>${s.lblLanguage}</span>
                <div class="seg-btns">
                  <button type="button" data-set-lang="en" class="${lang === 'en' ? 'active' : ''}">English</button>
                  <button type="button" data-set-lang="zh" class="${lang === 'zh' ? 'active' : ''}">简体中文</button>
                </div>
              </div>
              <div class="set-field">
                <span>${s.lblPanelOpacity}</span>
                <input id="set-panel-opacity" type="range" min="0.55" max="1" step="0.02" value="${this.state.panelOpacity ?? 0.97}">
              </div>
              <div class="set-field">
                <span>${s.lblGratBright}</span>
                <input id="set-grat-bright" type="range" min="0.35" max="1.6" step="0.05" value="${this.state.graticuleBrightness ?? 1}">
              </div>
              <div class="set-field">
                <span>${s.lblTraceColoring}</span>
                <select id="set-trace-mode">
                  <option value="default">${s.traceDefault}</option>
                  <option value="colorize">${s.traceColorize}</option>
                  <option value="monochrome">${s.traceMono}</option>
                  <option value="green">${s.traceGreen}</option>
                  <option value="hdr-zones">${s.traceHdrZones}</option>
                </select>
              </div>
            </div>
          </div>

          <div class="sec">
            <div class="sec-title">${s.secColorSpace}</div>
            <div class="set-grid">
              <div class="set-field">
                <span>${s.lblPrimaries}</span>
                <select id="set-primaries">
                  <option value="auto">${s.autoDetect}</option>
                  <option value="rec709">Rec.709 / sRGB</option>
                  <option value="p3">Display P3</option>
                  <option value="rec2020">Rec.2020</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblTransfer}</span>
                <select id="set-hdr-mode">
                  <option value="auto">${s.autoDetect}</option>
                  <option value="sdr">SDR (BT.1886 / sRGB)</option>
                  <option value="pq">HDR PQ (ST 2084)</option>
                  <option value="hlg">HDR HLG (BT.2100)</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblMatrix}</span>
                <select id="set-matrix">
                  <option value="auto">${s.autoDetect}</option>
                  <option value="bt709">BT.709</option>
                  <option value="bt601">BT.601</option>
                  <option value="bt2020">BT.2020 NCL</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblRange}</span>
                <select id="set-range">
                  <option value="auto">${s.autoDetect}</option>
                  <option value="limited">Limited (16–235)</option>
                  <option value="full">Full (0–255)</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblSignalPath}</span>
                <select id="set-signal">
                  <option value="display">${s.signalDisplay}</option>
                  <option value="raw">${s.signalRaw}</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblSdrWhite}</span>
                <select id="set-sdr-white">
                  <option value="203">203 nits (ITU BT.2408)</option>
                  <option value="100">100 nits (Mastering)</option>
                  <option value="300">300 nits (Bright)</option>
                </select>
              </div>
            </div>
          </div>

          <div class="sec">
            <div class="sec-title">${s.secEyedropper}</div>
            <div class="check-grid">
              <label><input type="checkbox" data-probe-cfg="showScopeRings" ${pc.showScopeRings ? 'checked' : ''}> ${s.probeShowRings}</label>
              <label><input type="checkbox" data-probe-cfg="showTooltip" ${pc.showTooltip ? 'checked' : ''}> ${s.probeShowTooltip}</label>
              <label><input type="checkbox" data-probe-cfg="showRgb8" ${pc.showRgb8 ? 'checked' : ''}> ${s.probeRgb8}</label>
              <label><input type="checkbox" data-probe-cfg="showRgb10" ${pc.showRgb10 ? 'checked' : ''}> ${s.probeRgb10}</label>
              <label><input type="checkbox" data-probe-cfg="showLuma" ${pc.showLuma ? 'checked' : ''}> ${s.probeLuma}</label>
              <label><input type="checkbox" data-probe-cfg="showXy" ${pc.showXy ? 'checked' : ''}> ${s.probeXy}</label>
              <label><input type="checkbox" data-probe-cfg="showUv" ${pc.showUv ? 'checked' : ''}> ${s.probeUv}</label>
              <label><input type="checkbox" data-probe-cfg="showYuv" ${pc.showYuv ? 'checked' : ''}> ${s.probeYuv}</label>
              <label><input type="checkbox" data-probe-cfg="showHex" ${pc.showHex ? 'checked' : ''}> ${s.probeHex}</label>
              <label><input type="checkbox" data-probe-cfg="showCoords" ${pc.showCoords ? 'checked' : ''}> ${s.probeCoords}</label>
            </div>
          </div>

          <div class="sec">
            <div class="sec-title">${s.secFalseColor}</div>
            <div class="check-grid">
              <label><input type="checkbox" id="set-fc-enable" ${this.state.videoFalseColor ? 'checked' : ''}> ${s.lblFcEnable}</label>
              <label><input type="checkbox" id="set-fc-legend" ${this.state.falseColorLegend !== false ? 'checked' : ''}> ${s.lblFcLegend}</label>
            </div>
            <div class="set-grid">
              <div class="set-field">
                <span>${s.lblFcPreset}</span>
                <select id="set-fc-preset">
                  <option value="auto">${s.fcPresetAuto}</option>
                  <option value="arri">${s.fcPresetArri}</option>
                  <option value="smallhd">${s.fcPresetSmallHd}</option>
                  <option value="spectrum">${s.fcPresetSpectrum}</option>
                  <option value="hdr-nits">${s.fcPresetHdr}</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblFcOpacity}</span>
                <input id="set-fc-opacity" type="range" min="0.3" max="1" step="0.04" value="${this.state.falseColorOpacity ?? 0.88}">
              </div>
            </div>
          </div>
          <div class="sec">
            <div class="sec-title">${s.secCapture}</div>
            <div class="set-grid">
              <div class="set-field">
                <span>${s.lblCaptureFormat}</span>
                <select id="set-capture-format">
                  <option value="png">PNG</option>
                  <option value="jpeg">JPEG</option>
                  <option value="webp">WebP</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblCaptureScale}</span>
                <select id="set-capture-scale">
                  <option value="1">1×</option>
                  <option value="2">2×</option>
                  <option value="3">3×</option>
                  <option value="4">4×</option>
                  <option value="match">${s.captureScaleMatch}</option>
                </select>
              </div>
              <div class="set-field">
                <span>${s.lblCaptureBackground}</span>
                <select id="set-capture-background">
                  <option value="transparent">${s.bgTransparent}</option>
                  <option value="panel">${s.bgPanel}</option>
                  <option value="white">${s.bgWhite}</option>
                </select>
              </div>
            </div>
            <div class="set-hint" id="capture-size-hint"></div>
            <button id="capture-now-btn" type="button" class="active">${s.btnCapture}</button>
            <div class="set-hint">${s.captureAccuracyHint}</div>
          </div>
        </div>
        <div class="settings-foot">
          <button id="reset-all-btn" type="button" class="btn-danger">${s.btnResetAll}</button>
          <button id="settings-done-btn" type="button" class="active">${s.btnDone}</button>
        </div>
      </div>
    `;
  }

  private template(): string {
    const s = this.i18n();
    const showPip = !this.isFill && pipSupported();
    const langToggleText = (this.state.lang ?? 'en') === 'zh' ? 'EN' : '中文';
    return `
      <style>${STYLE}</style>
      <div class="panel" style="--panel-alpha:${this.state.panelOpacity ?? 0.97}">
        <header>
          <span class="title" id="hdr-title">${s.appTitle}</span>
          <span class="badge" id="status">axis:–</span>
          <span class="badge" id="cs">–</span>
          <span class="badge warn" id="warn" hidden></span>
          <span class="badge hdr" id="hdr-stat" hidden></span>
          <span class="spacer"></span>
          <span class="badge mono" id="perf" title="Click to toggle governor lock">–</span>
          ${showPip ? `<button id="pip-btn" type="button" class="icon-btn" title="${s.pipTitle}">⧉</button>` : ''}
          <button id="capture-btn" type="button" class="icon-btn" title="${s.btnCapture}">📷</button>
          <button id="lang-btn" type="button" class="icon-btn" title="Switch Language / 切换中英文">${langToggleText}</button>
          <button id="settings-btn" type="button" class="icon-btn" aria-pressed="false" title="${s.settingsTitle}">⚙</button>
          <button id="close" type="button" class="icon-btn" title="${s.closeTitle}">✕</button>
        </header>

        <div class="notice" id="notice" hidden></div>
        <div class="notice" id="probe" hidden></div>

        <nav class="bar">
          <span class="grp" id="layouts">${this.renderLayoutsHtml()}</span>
          <span class="sep"></span>
          <span class="grp" id="modes">${this.renderToolbarModesHtml()}</span>
          <span class="bar-spacer"></span>
          <span class="grp">
            <button id="eyedropper-btn" type="button" aria-pressed="false" title="${s.eyedropperTitle}">⊕ ${s.eyedropper}</button>
            <button id="false-color-btn" type="button" aria-pressed="false" title="${s.falseColorTitle}">◐ ${this.state.videoFalseColor ? s.falseColorOn : s.falseColor}</button>
            <select id="fc-preset" title="${s.lblFcPreset}">
              <option value="auto">${s.fcAuto}</option>
              <option value="arri">${s.fcArri}</option>
              <option value="smallhd">${s.fcSmallHd}</option>
              <option value="spectrum">${s.fcSpectrum}</option>
              <option value="hdr-nits">${s.fcHdrNits}</option>
            </select>
            <select id="precision" title="Analysis resolution & GPU precision">
              <option value="auto">${s.precAuto}</option>
              <option value="low">${s.precLow}</option>
              <option value="default">${s.precStd}</option>
              <option value="high">${s.precHigh}</option>
              <option value="ultra">${s.precUltra}</option>
              <option value="native">${s.precNative}</option>
              <option value="full">${s.precFull}</option>
            </select>
            <select id="hdr-mode" title="Dynamic range & scale (Auto switches to HDR Nits on PQ/HLG)">
              <option value="auto">${s.hdrAuto}</option>
              <option value="sdr">SDR</option>
              <option value="pq">HDR PQ</option>
              <option value="hlg">HDR HLG</option>
            </select>
          </span>
        </nav>

        <div class="grid ${layoutClass(this.state.layout)}"></div>

        <div class="settings-backdrop" id="settings-backdrop" hidden>
          ${this.renderSettingsSheetHtml()}
        </div>

        <details class="options">
          <summary>
            <span id="drawer-title">${s.signalHdrSection}</span>
            <span class="sum-hint" id="nit-summary">100n / 1000n · ${s.wheelZoomHint}</span>
          </summary>
          <div class="hdr-strip">
            <span id="lbl-hdr-zones">${s.hdrNitZones}</span>
            <label title="Shadow / Midtone boundary in cd/m² (nits)"><span id="lbl-nit-low">${s.lowNit}</span>
              <input id="nit-low" class="nit-lo" type="number" min="0.1" max="4000" step="1" value="100">
            </label>
            <label title="Display peak / Highlight clipping warning in cd/m² (nits)"><span id="lbl-nit-peak">${s.peakNit}</span>
              <input id="nit-high" class="nit-hi" type="number" min="10" max="10000" step="10" value="1000">
            </label>
            <button id="preset-100-1000" type="button" title="4-Zone: <100n Blue · 100–203n Green · 203–1000n Yellow · >1000n Red">100/1k</button>
            <button id="preset-203-1000" type="button" title="3-Zone: ≤203n Green · 203–1000n Yellow · >1000n Red">203/1k</button>
            <button id="preset-203-4000" type="button" title="3-Zone: ≤203n Green · 203–4000n Yellow · >4000n Red">203/4k</button>
            <button id="zone-all-btn" type="button" title="${s.zoneColorAllTitle}">${s.zoneColorAll}</button>
          </div>
          <div class="opts">
            <label>signal
              <select id="signal">
                <option value="display">display</option>
                <option value="raw">raw YUV</option>
              </select>
            </label>
            <label>range
              <select id="range">
                <option value="auto">auto</option>
                <option value="limited">limited</option>
                <option value="full">full</option>
              </select>
            </label>
            <label title="Colour matrix">matrix
              <select id="matrix">
                <option value="auto">auto</option>
                <option value="bt709">BT.709</option>
                <option value="bt601">BT.601</option>
                <option value="bt2020">BT.2020</option>
              </select>
            </label>
            <label>layout
              <select id="layout">
                <option value="single">1 · single</option>
                <option value="pair">2 · side by side</option>
                <option value="triple">3 · stacked</option>
                <option value="grid">4 · grid</option>
              </select>
            </label>
            <label title="Scale units for focused cell">units
              <select id="units">
                <option value="auto">Auto</option>
                <option value="ire">IRE</option>
                <option value="nits">nits (PQ)</option>
                <option value="hlg">HLG nits</option>
                <option value="code8">8-bit</option>
                <option value="code10">10-bit</option>
                <option value="mv">mV</option>
              </select>
            </label>
            <label title="Vectorscope colour-bar target amplitude">bars
              <select id="bars">
                <option value="0.75">75%</option>
                <option value="1">100%</option>
              </select>
            </label>
            <label title="CIE coordinate system for focused cell">CIE
              <select id="coord">
                <option value="xy">1931 xy</option>
                <option value="uv">1976 u'v'</option>
              </select>
            </label>
            <label title="Gain for focused cell">gain
              <input id="gain" type="range" min="0.2" max="3" step="0.1">
            </label>
            <label title="Zoom for focused cell">zoom
              <input id="zoom" type="range" min="1" max="16" step="0.5">
            </label>
          </div>
        </details>
        ${this.isFill ? '' : '<div class="resize-grip" id="resize-grip" aria-hidden="true"></div>'}
      </div>`;
  }

  /** Re-apply translated UI labels in-place without tearing down WebGPU canvases! */
  private applyLocalization(): void {
    const root = this.root;
    if (!root) return;
    const s = this.i18n();
    const setText = (id: string, text: string): void => {
      const el = root.getElementById(id);
      if (el) el.textContent = text;
    };

    setText('hdr-title', s.appTitle);
    setText('lang-btn', (this.state.lang ?? 'en') === 'zh' ? 'EN' : '中文');
    setText('eyedropper-btn', `⊕ ${s.eyedropper}`);
    setText('false-color-btn', `◐ ${this.state.videoFalseColor ? s.falseColorOn : s.falseColor}`);
    setText('drawer-title', s.signalHdrSection);
    setText('lbl-hdr-zones', s.hdrNitZones);
    setText('lbl-nit-low', s.lowNit);
    setText('lbl-nit-peak', s.peakNit);
    setText('zone-all-btn', s.zoneColorAll);

    const modesEl = root.getElementById('modes');
    if (modesEl) {
      setTrustedHtml(modesEl, this.renderToolbarModesHtml());
      this.wireModeButtons();
    }
    const layoutsEl = root.getElementById('layouts');
    if (layoutsEl) {
      setTrustedHtml(layoutsEl, this.renderLayoutsHtml());
      this.wireLayoutButtons();
    }

    const fcSel = root.getElementById('fc-preset') as HTMLSelectElement | null;
    if (fcSel) {
      const cur = fcSel.value;
      setTrustedHtml(
        fcSel,
        `
        <option value="auto">${s.fcAuto}</option>
        <option value="arri">${s.fcArri}</option>
        <option value="smallhd">${s.fcSmallHd}</option>
        <option value="spectrum">${s.fcSpectrum}</option>
        <option value="hdr-nits">${s.fcHdrNits}</option>`,
      );
      fcSel.value = cur;
    }

    const precSel = root.getElementById('precision') as HTMLSelectElement | null;
    if (precSel) {
      const cur = precSel.value;
      setTrustedHtml(
        precSel,
        `
        <option value="auto">${s.precAuto}</option>
        <option value="low">${s.precLow}</option>
        <option value="default">${s.precStd}</option>
        <option value="high">${s.precHigh}</option>
        <option value="ultra">${s.precUltra}</option>
        <option value="native">${s.precNative}</option>
        <option value="full">${s.precFull}</option>`,
      );
      precSel.value = cur;
    }

    const hdrSel = root.getElementById('hdr-mode') as HTMLSelectElement | null;
    if (hdrSel) {
      const cur = hdrSel.value;
      setTrustedHtml(
        hdrSel,
        `
        <option value="auto">${s.hdrAuto}</option>
        <option value="sdr">SDR</option>
        <option value="pq">HDR PQ</option>
        <option value="hlg">HDR HLG</option>`,
      );
      hdrSel.value = cur;
    }

    const backdrop = root.getElementById('settings-backdrop');
    if (backdrop) {
      setTrustedHtml(backdrop, this.renderSettingsSheetHtml());
      this.wireSettingsSheet();
      this.syncSettingsModal();
    }

    this.syncModeButtons();
    this.refreshCellChrome(true);
  }

  private renderCellPillsHtml(cell: CellConfig): string {
    // Coloring (Clr / B&W / Nit / Grn) is intentionally configured inside Settings (⚙)
    // rather than inline beside signal modes, so users never confuse coloring with signal channel selection.
    if (isWaveMode(cell.mode)) {
      const ch = cell.waveChannels ?? (cell.mode === 'waveform-rgb' ? 'RGB' : 'Y');
      return (['Y', 'RGB', 'YRGB', 'YUV'] as WaveChannelMode[])
        .map((c) => `<button type="button" class="pill ${ch === c ? 'on' : ''}" data-wave="${c}">${c}</button>`)
        .join('');
    }
    if (cell.mode === 'waveform-parade') {
      const pm = cell.paradeMode ?? 'RGB';
      return (['RGB', 'YRGB', 'YUV'] as ParadeMode[])
        .map((p) => `<button type="button" class="pill ${pm === p ? 'on' : ''}" data-parade="${p}">${p}</button>`)
        .join('');
    }
    if (cell.mode === 'histogram') {
      const hm = cell.histMode ?? 'YRGB';
      return (['Y', 'RGB', 'YRGB', 'YUV'] as HistChannelMode[])
        .map((h) => `<button type="button" class="pill ${hm === h ? 'on' : ''}" data-hist="${h}">${h}</button>`)
        .join('');
    }
    if (cell.mode === 'vectorscope') {
      const b75 = (cell.barTargets ?? 0.75) === 0.75;
      const s2x = !!cell.vecScale2x;
      const skin = cell.showSkinLine !== false;
      const s = this.i18n();
      return (
        `<button type="button" class="pill ${b75 ? 'on' : ''}" data-bars="0.75">75%</button>` +
        `<button type="button" class="pill ${!b75 ? 'on' : ''}" data-bars="1">100%</button>` +
        `<button type="button" class="pill ${s2x ? 'on' : ''}" data-act="zoom2x" title="${s.vecSignal2xTitle}">2×</button>` +
        `<button type="button" class="pill ${skin ? 'on' : ''}" data-act="skin" title="Skin Tone I-line">Skin</button>`
      );
    }
    const xy = cell.coord === 'xy';
    const gSet = new Set(cell.gamuts);
    return (
      `<button type="button" class="pill ${xy ? 'on' : ''}" data-coord="xy">xy</button>` +
      `<button type="button" class="pill ${!xy ? 'on' : ''}" data-coord="uv">u'v'</button>` +
      `<button type="button" class="pill ${gSet.has('rec709') ? 'on' : ''}" data-gamut="rec709">709</button>` +
      `<button type="button" class="pill ${gSet.has('p3') ? 'on' : ''}" data-gamut="p3">P3</button>` +
      `<button type="button" class="pill ${gSet.has('rec2020') ? 'on' : ''}" data-gamut="rec2020">2020</button>`
    );
  }

  /** Return ONLY trace coloring options that actually apply to this scope mode! */
  private traceOptionsForMode(mode: ScopeMode, s: I18nStrings): [TraceColorMode, string][] {
    if (mode === 'vectorscope' || mode === 'cie') {
      return [
        ['colorize', s.traceColorize],
        ['green', s.traceGreen],
        ['monochrome', s.traceMono],
      ];
    }
    if (mode === 'histogram') {
      return [
        ['channel', s.traceChannel],
        ['monochrome', s.traceMono],
        ['hdr-zones', s.traceHdrZones],
        ['green', s.traceGreen],
      ];
    }
    return [
      ['channel', s.traceChannel],
      ['colorize', s.traceColorize],
      ['monochrome', s.traceMono],
      ['hdr-zones', s.traceHdrZones],
      ['green', s.traceGreen],
    ];
  }

  private renderPopoverHtml(cell: CellConfig, slot: number): string {
    const s = this.i18n();
    const traceOpts = this.traceOptionsForMode(cell.mode, s);

    let specificRows = '';
    if (isWaveMode(cell.mode)) {
      const ch = cell.waveChannels ?? (cell.mode === 'waveform-rgb' ? 'RGB' : 'Y');
      specificRows = `
        <div class="pop-row"><span>${s.popChannels}</span>
          <select data-pop="waveChannels">
            ${(['Y', 'RGB', 'YRGB', 'YUV', 'R', 'G', 'B'] as WaveChannelMode[])
              .map((v) => `<option value="${v}" ${ch === v ? 'selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </div>
        <div class="pop-row"><span>${s.popFilter}</span>
          <div class="pop-checks"><label><input type="checkbox" data-pop="lowPass" ${cell.lowPass ? 'checked' : ''}> ${s.popLowPass}</label></div>
        </div>`;
    } else if (cell.mode === 'waveform-parade') {
      specificRows = `
        <div class="pop-row"><span>${s.popParade}</span>
          <select data-pop="paradeMode">
            ${(['RGB', 'YRGB', 'YUV'] as ParadeMode[])
              .map((v) => `<option value="${v}" ${cell.paradeMode === v ? 'selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </div>
        <div class="pop-row"><span>${s.popFilter}</span>
          <div class="pop-checks"><label><input type="checkbox" data-pop="lowPass" ${cell.lowPass ? 'checked' : ''}> ${s.popLowPass}</label></div>
        </div>`;
    } else if (cell.mode === 'histogram') {
      specificRows = `
        <div class="pop-row"><span>${s.popChannels}</span>
          <select data-pop="histMode">
            ${(['Y', 'RGB', 'YRGB', 'YUV'] as HistChannelMode[])
              .map((v) => `<option value="${v}" ${cell.histMode === v ? 'selected' : ''}>${v}</option>`)
              .join('')}
          </select>
        </div>`;
    } else if (cell.mode === 'vectorscope') {
      specificRows = `
        <div class="pop-row"><span>${s.popTargets}</span>
          <select data-pop="barTargets">
            <option value="0.75" ${cell.barTargets === 0.75 ? 'selected' : ''}>75% SMPTE</option>
            <option value="1" ${cell.barTargets === 1 ? 'selected' : ''}>100% Full</option>
          </select>
        </div>
        <div class="pop-row"><span>${s.popTones}</span>
          <select data-pop="toneFilter">
            ${(
              [
                ['all', s.toneAll],
                ['shadows', s.toneShadows],
                ['midtones', s.toneMidtones],
                ['highlights', s.toneHighlights],
              ] as [ToneFilter, string][]
            )
              .map(([v, l]) => `<option value="${v}" ${cell.toneFilter === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
        </div>
        <div class="pop-row"><span>${s.popOverlay}</span>
          <div class="pop-checks">
            <label><input type="checkbox" data-pop="showSkinLine" ${cell.showSkinLine !== false ? 'checked' : ''}> ${s.skinLine}</label>
            <label title="${s.vecSignal2xTitle}"><input type="checkbox" data-pop="vecScale2x" ${cell.vecScale2x ? 'checked' : ''}> ${s.vecSignal2x}</label>
          </div>
        </div>`;
    } else if (cell.mode === 'cie') {
      const g = new Set(cell.gamuts);
      specificRows = `
        <div class="pop-row"><span>${s.popChart}</span>
          <select data-pop="coord">
            <option value="xy" ${cell.coord === 'xy' ? 'selected' : ''}>CIE 1931 xy</option>
            <option value="uv" ${cell.coord === 'uv' ? 'selected' : ''}>CIE 1976 u'v'</option>
          </select>
        </div>
        <div class="pop-row"><span>${s.popGamuts}</span>
          <div class="pop-checks">
            <label><input type="checkbox" data-pop-gamut="rec709" ${g.has('rec709') ? 'checked' : ''}>709</label>
            <label><input type="checkbox" data-pop-gamut="p3" ${g.has('p3') ? 'checked' : ''}>P3</label>
            <label><input type="checkbox" data-pop-gamut="rec2020" ${g.has('rec2020') ? 'checked' : ''}>2020</label>
          </div>
        </div>`;
    }

    const showScale = supportsHdrZones(cell.mode);
    const scaleRow = showScale
      ? `<div class="pop-row"><span>${s.popScale}</span>
          <select data-pop="units">
            <option value="auto" ${cell.units === 'auto' ? 'selected' : ''}>Auto (SDR/HDR)</option>
            <option value="ire" ${cell.units === 'ire' ? 'selected' : ''}>IRE</option>
            <option value="nits" ${cell.units === 'nits' ? 'selected' : ''}>HDR PQ (nits)</option>
            <option value="hlg" ${cell.units === 'hlg' ? 'selected' : ''}>HDR HLG (nits)</option>
            <option value="code8" ${cell.units === 'code8' ? 'selected' : ''}>8-bit Code</option>
            <option value="code10" ${cell.units === 'code10' ? 'selected' : ''}>10-bit Code</option>
            <option value="mv" ${cell.units === 'mv' ? 'selected' : ''}>mV</option>
          </select>
        </div>`
      : '';

    const z = cell.zoom || 1;
    const z1 = Math.abs(z - 1) < 0.05;
    const z2 = Math.abs(z - 2) < 0.08;
    const z4 = Math.abs(z - 4) < 0.1;

    return `
      <div class="pop-row"><span>${s.popScope} #${slot + 1}</span>
        <select data-pop="duplicateScope" title="Set this cell's scope independently (allows duplicates)">
          <option value="waveform" ${isWaveMode(cell.mode) ? 'selected' : ''}>${s.scopeWaveform}</option>
          <option value="waveform-parade" ${cell.mode === 'waveform-parade' ? 'selected' : ''}>${s.scopeParade}</option>
          <option value="histogram" ${cell.mode === 'histogram' ? 'selected' : ''}>${s.scopeHistogram}</option>
          <option value="vectorscope" ${cell.mode === 'vectorscope' ? 'selected' : ''}>${s.scopeVector}</option>
          <option value="cie" ${cell.mode === 'cie' ? 'selected' : ''}>${s.scopeCie}</option>
        </select>
      </div>
      ${specificRows}
      <div class="pop-row"><span>${s.popColoring}</span>
        <select data-pop="traceMode">
          ${traceOpts.map(([v, l]) => `<option value="${v}" ${cell.traceMode === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${scaleRow}
      <div class="pop-row"><span>${s.popGain}</span>
        <input type="range" data-pop="gain" min="0.2" max="3" step="0.05" value="${cell.gain}">
      </div>
      <div class="pop-row"><span>${s.popGamma}</span>
        <input type="range" data-pop="gamma" min="0.4" max="1.8" step="0.05" value="${cell.gamma}">
      </div>
      <div class="pop-row"><span>${s.popZoom}</span>
        <input type="range" data-pop="zoom" min="1" max="16" step="0.25" value="${cell.zoom}">
      </div>
      <div class="pop-actions">
        <div class="pop-zoom-grp">
          <button type="button" data-pop-zoom="1" class="${z1 ? 'active' : ''}" title="1× Full View">1×</button>
          <button type="button" data-pop-zoom="2" class="${z2 ? 'active' : ''}" title="2× Zoom View">2×</button>
          <button type="button" data-pop-zoom="4" class="${z4 ? 'active' : ''}" title="4× Detail View">4×</button>
        </div>
        <button type="button" data-pop-act="resetCell">${s.resetCell}</button>
      </div>
    `;
  }

  private buildCells(layout: Layout = this.state.layout): void {
    const root = this.root;
    if (!root) return;
    const grid = root.querySelector('.grid') as HTMLElement;
    const cells = resolveCells(this.state, layout);
    const activeSlot = Math.min(cells.length - 1, Math.max(0, this.state.activeSlot || 0));
    const s = this.i18n();

    setTrustedHtml(
      grid,
      cells
        .map((cell, slot) => {
        const zoomed = cell.zoom > 1.01 || cell.panX != null || cell.panY != null;
        const popOpen = this.openPopoverSlot === slot;
        return `
          <div class="cell" data-mode="${cell.mode}" data-slot="${slot}" data-active="${slot === activeSlot ? 'true' : 'false'}">
            <div class="cell-bar">
              <select class="tag" data-slot="${slot}" title="Scope in this cell">${pickerOptionsHtml(cell.mode, s)}</select>
              <div class="cell-pills" data-slot="${slot}">${this.renderCellPillsHtml(cell)}</div>
              <span class="cell-spacer"></span>
              <button type="button" class="pill zoom-reset" data-slot="${slot}" ${zoomed ? '' : 'hidden'} title="Click or double-click scope to reset zoom">${+cell.zoom.toFixed(1)}× ↺</button>
              <button type="button" class="cell-gear ${popOpen ? 'open' : ''}" data-slot="${slot}" title="Cell scope settings">⚙</button>
            </div>
            <div class="cell-popover" data-slot="${slot}" ${popOpen ? '' : 'hidden'}>
              ${this.renderPopoverHtml(cell, slot)}
            </div>
            <div class="cell-stage ${cell.zoom > 1.01 ? 'zoomed' : ''}" data-slot="${slot}">
              <canvas class="gpu"></canvas>
              <canvas class="grat"></canvas>
              <canvas class="marker"></canvas>
            </div>
          </div>`;
        })
        .join(''),
    );

    this.targets = [];
    for (const cellEl of Array.from(grid.querySelectorAll<HTMLElement>('.cell'))) {
      const slot = Number(cellEl.dataset.slot);
      const cellCfg = cells[slot]!;
      const sel = cellEl.querySelector<HTMLSelectElement>('select.tag');
      if (sel) sel.value = cellCfg.mode;

      const gpu = cellEl.querySelector<HTMLCanvasElement>('canvas.gpu');
      const grat = cellEl.querySelector<HTMLCanvasElement>('canvas.grat');
      const marker = cellEl.querySelector<HTMLCanvasElement>('canvas.marker') ?? undefined;
      if (gpu && grat) {
        this.targets.push({ slot, mode: cellCfg.mode, gpu, grat, marker });
      }
      this.wireCell(cellEl, slot, layout);
    }
  }

  /** Update cell header pills, zoom badge, active border, and popover without destroying GPU canvases! */
  private refreshCellChrome(forcePopoverRebuild = false): void {
    const root = this.root;
    if (!root) return;
    const layout = this.state.layout;
    const cells = resolveCells(this.state, layout);
    const activeSlot = Math.min(cells.length - 1, Math.max(0, this.state.activeSlot || 0));
    const s = this.i18n();

    for (const cellEl of Array.from(root.querySelectorAll<HTMLElement>('.cell'))) {
      const slot = Number(cellEl.dataset.slot);
      const cell = cells[slot];
      if (!cell) continue;
      cellEl.dataset.mode = cell.mode;
      cellEl.dataset.active = slot === activeSlot ? 'true' : 'false';

      const target = this.targets.find((t) => t.slot === slot);
      if (target) target.mode = cell.mode;

      const sel = cellEl.querySelector<HTMLSelectElement>('select.tag');
      if (sel) {
        setTrustedHtml(sel, pickerOptionsHtml(cell.mode, s));
        sel.value = cell.mode;
      }

      const pills = cellEl.querySelector<HTMLElement>('.cell-pills');
      if (pills) setTrustedHtml(pills, this.renderCellPillsHtml(cell));

      const zoomBtn = cellEl.querySelector<HTMLButtonElement>('.zoom-reset');
      if (zoomBtn) {
        const zoomed = cell.zoom > 1.01 || cell.panX != null || cell.panY != null;
        zoomBtn.hidden = !zoomed;
        if (zoomed) zoomBtn.textContent = `${+cell.zoom.toFixed(1)}× ↺`;
      }

      const stage = cellEl.querySelector<HTMLElement>('.cell-stage');
      if (stage && !stage.classList.contains('dragging')) {
        stage.classList.toggle('zoomed', cell.zoom > 1.01);
      }

      const gear = cellEl.querySelector<HTMLButtonElement>('.cell-gear');
      const pop = cellEl.querySelector<HTMLElement>('.cell-popover');
      const isOpen = this.openPopoverSlot === slot;
      if (gear) gear.classList.toggle('open', isOpen);
      if (pop) {
        pop.hidden = !isOpen;
        if (isOpen) {
          if (forcePopoverRebuild || pop.dataset.renderedMode !== cell.mode) {
            setTrustedHtml(pop, this.renderPopoverHtml(cell, slot));
            pop.dataset.renderedMode = cell.mode;
          } else {
            // Sync 1×/2×/4× button highlight & zoom slider live without interrupting drag
            const z = cell.zoom || 1;
            for (const b of Array.from(pop.querySelectorAll<HTMLButtonElement>('button[data-pop-zoom]'))) {
              const bz = Number(b.dataset.popZoom);
              b.classList.toggle('active', Math.abs(z - bz) < 0.08);
            }
            const zInput = pop.querySelector<HTMLInputElement>('input[data-pop="zoom"]');
            if (zInput && this.doc?.activeElement !== zInput) {
              zInput.value = String(z);
            }
            const sig2xChk = pop.querySelector<HTMLInputElement>('input[data-pop="vecScale2x"]');
            if (sig2xChk) sig2xChk.checked = !!cell.vecScale2x;
            const traceSel = pop.querySelector<HTMLSelectElement>('select[data-pop="traceMode"]');
            if (traceSel && this.doc?.activeElement !== traceSel) {
              traceSel.value = cell.traceMode;
            }
          }
        }
      }
    }
    this.syncModeButtons();
  }

  private focusSlot(slot: number): void {
    if (this.state.activeSlot === slot) return;
    this.state = { ...this.state, activeSlot: slot };
    this.handlers.onStateChange({ activeSlot: slot });
    this.refreshCellChrome();
    this.syncInputs();
  }

  private emitCellPatch(slot: number, patch: Partial<CellConfig>): void {
    const layout = this.state.layout;
    const cells = resolveCells(this.state, layout);
    const cur = cells[slot];
    if (!cur) return;
    const updated = { ...cur, ...patch };
    cells[slot] = updated;
    this.state = {
      ...this.state,
      activeSlot: slot,
      cells: { ...this.state.cells, [layout]: cells },
    };
    this.handlers.onCellChange(layout, slot, patch);
    this.refreshCellChrome();
    this.syncInputs();
  }

  private applyPresetZoom(slot: number, cell: CellConfig, targetZoom: number): void {
    if (targetZoom <= 1.01) {
      this.emitCellPatch(slot, { zoom: 1, panX: null, panY: null });
      return;
    }
    if (cell.mode === 'vectorscope') {
      this.emitCellPatch(slot, { zoom: targetZoom, panX: 0, panY: 0 });
    } else if (cell.mode === 'cie') {
      this.emitCellPatch(slot, { zoom: targetZoom, panX: null, panY: null });
    } else {
      const centerPan = (1 - 1 / targetZoom) * 0.5;
      this.emitCellPatch(slot, { zoom: targetZoom, panX: centerPan, panY: centerPan });
    }
  }

  private wireCell(cellEl: HTMLElement, slot: number, layout: Layout): void {
    cellEl.addEventListener('pointerdown', () => this.focusSlot(slot));

    const sel = cellEl.querySelector<HTMLSelectElement>('select.tag');
    sel?.addEventListener('change', () => {
      const picked = sel.value as ScopeMode;
      const currentCells = resolveCells(this.state, layout);
      const nextCells = assignCellSlot(currentCells, slot, picked, this.state, false);
      const nextModes = nextCells.map((c) => c.mode);
      this.state = {
        ...this.state,
        activeSlot: slot,
        panels: { ...this.state.panels, [layout]: nextModes },
        cells: { ...this.state.cells, [layout]: nextCells },
      };
      this.openPopoverSlot = null;
      this.handlers.onCellsReplace(layout, nextCells);
      this.refreshCellChrome();
    });

    // Delegated quick-pills bar clicks
    const pills = cellEl.querySelector<HTMLElement>('.cell-pills');
    pills?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn) return;
      e.stopPropagation();
      const cell = resolveCells(this.state, this.state.layout)[slot];
      if (!cell) return;

      if (btn.dataset.wave) {
        const wc = btn.dataset.wave as WaveChannelMode;
        const nextMode: ScopeMode = wc === 'Y' ? 'waveform-luma' : 'waveform-rgb';
        this.emitCellPatch(slot, { mode: nextMode, waveChannels: wc });
        return;
      }
      if (btn.dataset.parade) {
        this.emitCellPatch(slot, { paradeMode: btn.dataset.parade as ParadeMode });
        return;
      }
      if (btn.dataset.hist) {
        this.emitCellPatch(slot, { histMode: btn.dataset.hist as HistChannelMode });
        return;
      }
      if (btn.dataset.bars) {
        this.emitCellPatch(slot, { barTargets: Number(btn.dataset.bars) === 1 ? 1 : 0.75 });
        return;
      }
      if (btn.dataset.coord) {
        this.emitCellPatch(slot, { coord: btn.dataset.coord as 'xy' | 'uv', panX: null, panY: null });
        return;
      }
      if (btn.dataset.gamut) {
        const g = btn.dataset.gamut as PrimariesId;
        const curSet = new Set(cell.gamuts);
        if (curSet.has(g) && curSet.size > 1) curSet.delete(g);
        else curSet.add(g);
        this.emitCellPatch(slot, { gamuts: Array.from(curSet) });
        return;
      }
      const act = btn.dataset.act;
      if (act === 'zoom2x') {
        this.emitCellPatch(slot, { vecScale2x: !cell.vecScale2x });
      } else if (act === 'skin') {
        this.emitCellPatch(slot, { showSkinLine: cell.showSkinLine === false });
      }
    });

    // Zoom reset pill
    cellEl.querySelector<HTMLButtonElement>('.zoom-reset')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.emitCellPatch(slot, { zoom: 1, panX: null, panY: null });
    });

    // Gear popover toggle
    const gear = cellEl.querySelector<HTMLButtonElement>('.cell-gear');
    const pop = cellEl.querySelector<HTMLElement>('.cell-popover');
    gear?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openPopoverSlot = this.openPopoverSlot === slot ? null : slot;
      if (pop && this.openPopoverSlot === slot) {
        const cell = resolveCells(this.state, this.state.layout)[slot]!;
        setTrustedHtml(pop, this.renderPopoverHtml(cell, slot));
        pop.dataset.renderedMode = cell.mode;
      }
      this.refreshCellChrome();
    });

    // Delegated popover input/change/click handlers
    pop?.addEventListener('pointerdown', (e) => e.stopPropagation());
    const handlePopControl = (e: Event): void => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if (!target) return;
      const cell = resolveCells(this.state, this.state.layout)[slot];
      if (!cell) return;

      if (target.dataset.popGamut) {
        const g = target.dataset.popGamut as PrimariesId;
        const set = new Set(cell.gamuts);
        if ((target as HTMLInputElement).checked) set.add(g);
        else if (set.size > 1) set.delete(g);
        else (target as HTMLInputElement).checked = true;
        this.emitCellPatch(slot, { gamuts: Array.from(set) });
        return;
      }

      const key = target.dataset.pop;
      if (!key) return;
      if (key === 'duplicateScope') {
        const rawVal = target.value;
        const nextMode: ScopeMode =
          rawVal === 'waveform' ? 'waveform-rgb' : (rawVal as ScopeMode);
        const cells = resolveCells(this.state, this.state.layout);
        const nextCells = assignCellSlot(cells, slot, nextMode, this.state, true);
        this.state = {
          ...this.state,
          activeSlot: slot,
          cells: { ...this.state.cells, [this.state.layout]: nextCells },
        };
        if (pop) {
          setTrustedHtml(pop, this.renderPopoverHtml(nextCells[slot]!, slot));
          pop.dataset.renderedMode = nextCells[slot]!.mode;
        }
        this.handlers.onCellsReplace(this.state.layout, nextCells);
        this.refreshCellChrome();
        return;
      }
      if (key === 'waveChannels') {
        const wc = target.value as WaveChannelMode;
        const m: ScopeMode =
          wc === 'Y' || wc === 'R' || wc === 'G' || wc === 'B' ? 'waveform-luma' : 'waveform-rgb';
        this.emitCellPatch(slot, { mode: m, waveChannels: wc });
      } else if (key === 'paradeMode') {
        this.emitCellPatch(slot, { paradeMode: target.value as ParadeMode });
      } else if (key === 'histMode') {
        this.emitCellPatch(slot, { histMode: target.value as HistChannelMode });
      } else if (key === 'traceMode') {
        this.emitCellPatch(slot, { traceMode: target.value as TraceColorMode });
      } else if (key === 'units') {
        this.emitCellPatch(slot, { units: target.value as CellConfig['units'] });
      } else if (key === 'barTargets') {
        this.emitCellPatch(slot, { barTargets: Number(target.value) === 1 ? 1 : 0.75 });
      } else if (key === 'toneFilter') {
        this.emitCellPatch(slot, { toneFilter: target.value as ToneFilter });
      } else if (key === 'coord') {
        this.emitCellPatch(slot, { coord: target.value as 'xy' | 'uv', panX: null, panY: null });
      } else if (key === 'lowPass') {
        this.emitCellPatch(slot, { lowPass: (target as HTMLInputElement).checked });
      } else if (key === 'showSkinLine') {
        this.emitCellPatch(slot, { showSkinLine: (target as HTMLInputElement).checked });
      } else if (key === 'vecScale2x') {
        this.emitCellPatch(slot, { vecScale2x: (target as HTMLInputElement).checked });
      } else if (key === 'gain') {
        this.emitCellPatch(slot, { gain: Number(target.value) });
      } else if (key === 'gamma') {
        this.emitCellPatch(slot, { gamma: Number(target.value) });
      } else if (key === 'zoom') {
        const z = Number(target.value);
        this.emitCellPatch(slot, z <= 1.01 ? { zoom: 1, panX: null, panY: null } : { zoom: z });
      }
    };
    pop?.addEventListener('input', handlePopControl);
    pop?.addEventListener('change', handlePopControl);
    pop?.addEventListener('click', (e) => {
      const zBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-pop-zoom]');
      if (zBtn) {
        const cell = resolveCells(this.state, this.state.layout)[slot];
        if (!cell) return;
        const targetZ = Number(zBtn.dataset.popZoom) || 1;
        // Clicking an already-active 2× or 4× button toggles back to 1×!
        const nextZ = targetZ > 1 && Math.abs((cell.zoom ?? 1) - targetZ) < 0.08 ? 1 : targetZ;
        this.applyPresetZoom(slot, cell, nextZ);
        return;
      }
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-pop-act]');
      if (!btn) return;
      if (btn.dataset.popAct === 'resetCell') {
        const cur = resolveCells(this.state, this.state.layout)[slot]!;
        const fresh = defaultCellForMode(cur.mode, this.state);
        this.emitCellPatch(slot, fresh);
        if (pop) setTrustedHtml(pop, this.renderPopoverHtml(fresh, slot));
      }
    });

    // ---- Interactive Stage: Wheel Cursor-Zoom + Drag-to-Pan + DblClick Reset ----
    const stage = cellEl.querySelector<HTMLElement>('.cell-stage');
    if (!stage) return;

    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.openPopoverSlot !== null) {
          this.openPopoverSlot = null;
          this.refreshCellChrome();
        }
        const rect = stage.getBoundingClientRect();
        const cw = stage.clientWidth || rect.width;
        const ch = stage.clientHeight || rect.height;
        if (cw < 8 || ch < 8) return;
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const cell = resolveCells(this.state, this.state.layout)[slot];
        if (!cell) return;
        const factor = Math.exp(-e.deltaY * 0.0024);
        const nextZoom = Math.max(1, Math.min(16, (cell.zoom || 1) * factor));

        if (nextZoom <= 1.005) {
          this.emitCellPatch(slot, { zoom: 1, panX: null, panY: null });
          return;
        }

        if (cell.mode === 'vectorscope') {
          const zRes = zoomVectorscopeAt(
            cw,
            ch,
            cell.zoom || 1,
            cell.panX ?? 0,
            cell.panY ?? 0,
            nextZoom,
            mx,
            my,
          );
          this.emitCellPatch(slot, { zoom: zRes.zoom, panX: zRes.panCb, panY: zRes.panCr });
        } else if (cell.mode === 'cie') {
          const zRes = zoomCieViewportAt(
            cw,
            ch,
            cell.coord,
            cell.zoom || 1,
            cell.panX,
            cell.panY,
            nextZoom,
            mx,
            my,
            1,
          );
          this.emitCellPatch(slot, { zoom: zRes.zoom, panX: zRes.panX, panY: zRes.panY });
        } else {
          const plotW = Math.max(8, cw - WAVE_PAD.left - WAVE_PAD.right);
          const plotH = Math.max(8, ch - WAVE_PAD.top - WAVE_PAD.bottom);
          let fx = Math.min(1, Math.max(0, (mx - WAVE_PAD.left) / plotW));
          if (cell.mode === 'waveform-parade') {
            const slices = cell.paradeMode === 'YRGB' ? 4 : 3;
            fx = (fx * slices) % 1;
          }
          const fy = Math.min(1, Math.max(0, 1 - (my - WAVE_PAD.top) / plotH));

          const z0 = Math.max(1, cell.zoom || 1);
          const curPanX = Math.min(Math.max(0, 1 - 1 / z0), Math.max(0, cell.panX ?? 0));
          const curPanY = Math.min(Math.max(0, 1 - 1 / z0), Math.max(0, cell.panY ?? 0));
          const dataX = curPanX + fx / z0;
          const dataY = curPanY + fy / z0;
          const maxPan1 = Math.max(0, 1 - 1 / nextZoom);
          const nextPanX = Math.min(maxPan1, Math.max(0, dataX - fx / nextZoom));
          const nextPanY = Math.min(maxPan1, Math.max(0, dataY - fy / nextZoom));
          this.emitCellPatch(slot, { zoom: nextZoom, panX: nextPanX, panY: nextPanY });
        }
      },
      { passive: false },
    );

    let panDrag: {
      startX: number;
      startY: number;
      initPanX: number;
      initPanY: number;
      zoom: number;
      mode: ScopeMode;
      coord: 'xy' | 'uv';
      paradeSlices: number;
    } | null = null;

    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.altKey) return;
      if (this.openPopoverSlot !== null) {
        this.openPopoverSlot = null;
        this.refreshCellChrome();
      }
      const cell = resolveCells(this.state, this.state.layout)[slot];
      if (!cell || (cell.zoom ?? 1) <= 1.005) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      const cw = stage.clientWidth || rect.width;
      const ch = stage.clientHeight || rect.height;
      let initX = cell.panX ?? 0;
      let initY = cell.panY ?? 0;
      if (cell.mode === 'cie' && (cell.panX == null || cell.panY == null)) {
        const cf = cieViewportFrame(cw, ch, cell.coord, cell.zoom, null, null, 1);
        initX = cf.x0;
        initY = cf.y0;
      }
      panDrag = {
        startX: e.clientX,
        startY: e.clientY,
        initPanX: initX,
        initPanY: initY,
        zoom: cell.zoom,
        mode: cell.mode,
        coord: cell.coord,
        paradeSlices: cell.paradeMode === 'YRGB' ? 4 : 3,
      };
      stage.classList.add('dragging');
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener('pointermove', (e) => {
      if (!panDrag) return;
      const rect = stage.getBoundingClientRect();
      const cw = stage.clientWidth || rect.width;
      const ch = stage.clientHeight || rect.height;
      const dx = e.clientX - panDrag.startX;
      const dy = e.clientY - panDrag.startY;
      const z = panDrag.zoom;

      if (panDrag.mode === 'vectorscope') {
        const vf = vectorscopeFrame(cw, ch, z, 0, 0);
        const [cCb, cCr] = clampVectorscopePan(
          z,
          panDrag.initPanX - dx / vf.scale,
          panDrag.initPanY + dy / vf.scale,
        );
        this.emitCellPatch(slot, { panX: cCb, panY: cCr });
      } else if (panDrag.mode === 'cie') {
        const cf = cieViewportFrame(
          cw,
          ch,
          panDrag.coord,
          z,
          panDrag.initPanX,
          panDrag.initPanY,
          1,
        );
        const clamped = cieViewportFrame(
          cw,
          ch,
          panDrag.coord,
          z,
          panDrag.initPanX - dx / cf.scale,
          panDrag.initPanY + dy / cf.scale,
          1,
        );
        this.emitCellPatch(slot, { panX: clamped.x0, panY: clamped.y0 });
      } else {
        const plotW = Math.max(8, cw - WAVE_PAD.left - WAVE_PAD.right);
        const plotH = Math.max(8, ch - WAVE_PAD.top - WAVE_PAD.bottom);
        const sliceW = panDrag.mode === 'waveform-parade' ? plotW / panDrag.paradeSlices : plotW;
        const maxPan = Math.max(0, 1 - 1 / z);
        const nx = Math.min(maxPan, Math.max(0, panDrag.initPanX - dx / sliceW / z));
        const ny = Math.min(maxPan, Math.max(0, panDrag.initPanY + dy / plotH / z));
        this.emitCellPatch(slot, { panX: nx, panY: ny });
      }
    });

    const endPan = (): void => {
      if (!panDrag) return;
      panDrag = null;
      stage.classList.remove('dragging');
    };
    stage.addEventListener('pointerup', endPan);
    stage.addEventListener('pointercancel', endPan);

    stage.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.emitCellPatch(slot, { zoom: 1, panX: null, panY: null });
    });
  }

  private syncModeButtons(): void {
    const root = this.root;
    if (!root) return;
    const activeCells = resolveCells(this.state, this.state.layout);
    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('#modes button'))) {
      const m = btn.dataset.mode as ScopeMode;
      const match = activeCells.some(
        (c) => c.mode === m || (isWaveMode(m) && isWaveMode(c.mode)),
      );
      btn.setAttribute('aria-pressed', match ? 'true' : 'false');
      btn.classList.toggle('scope-active', match);
    }
    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('#layouts button'))) {
      btn.setAttribute('aria-pressed', btn.dataset.layout === this.state.layout ? 'true' : 'false');
    }
  }

  private wireLayoutButtons(): void {
    const layoutNav = this.root?.getElementById('layouts');
    if (!layoutNav) return;
    for (const btn of Array.from(layoutNav.querySelectorAll<HTMLButtonElement>('button'))) {
      btn.addEventListener('click', () => {
        const layout = btn.dataset.layout as Layout;
        this.state = { ...this.state, layout, activeSlot: 0 };
        this.handlers.onLayoutChange(layout);
        this.syncModeButtons();
        this.syncInputs();
      });
    }
  }

  private wireModeButtons(): void {
    const nav = this.root?.getElementById('modes');
    if (!nav) return;
    for (const btn of Array.from(nav.querySelectorAll<HTMLButtonElement>('button'))) {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as ScopeMode;
        const singleCell = defaultCellForMode(mode, this.state);
        const nextCells = { ...this.state.cells, single: [singleCell] };
        this.state = {
          ...this.state,
          mode,
          layout: 'single',
          activeSlot: 0,
          cells: nextCells,
        };
        this.handlers.onCellsReplace('single', [singleCell]);
        this.syncModeButtons();
      });
    }
  }

  private setSettingsModalOpen(open: boolean): void {
    this.settingsOpen = open;
    const backdrop = this.root?.getElementById('settings-backdrop');
    const btn = this.root?.getElementById('settings-btn');
    if (backdrop) backdrop.hidden = !open;
    if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (open) this.syncSettingsModal();
  }

  private syncSettingsModal(): void {
    const root = this.root;
    if (!root) return;
    this.syncing = true;
    try {
      const set = (id: string, v: string): void => {
        const el = root.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
        if (el) el.value = v;
      };
      set('set-primaries', this.state.primariesMode ?? 'auto');
      set('set-hdr-mode', this.state.hdrMode ?? 'auto');
      set('set-matrix', this.state.matrixMode ?? 'auto');
      set('set-range', this.state.rangeMode ?? 'auto');
      set('set-signal', this.state.signalMode ?? 'display');
      set('set-sdr-white', String(this.state.sdrWhiteNits ?? 203));
      set('set-fc-preset', this.state.falseColorPreset ?? 'auto');
      set('set-fc-opacity', String(this.state.falseColorOpacity ?? 0.88));
      set('set-panel-opacity', String(this.state.panelOpacity ?? 0.97));
      set('set-grat-bright', String(this.state.graticuleBrightness ?? 1));
      set('set-trace-mode', this.state.defaultTraceMode ?? 'default');
      const cap = this.state.capture ?? DEFAULT_CAPTURE;
      set('set-capture-format', cap.format);
      set('set-capture-scale', String(cap.scale));
      set('set-capture-background', cap.background);
      this.renderCaptureSizeHint();

      const fcEnableChk = root.getElementById('set-fc-enable') as HTMLInputElement | null;
      if (fcEnableChk) fcEnableChk.checked = !!this.state.videoFalseColor;

      const legendChk = root.getElementById('set-fc-legend') as HTMLInputElement | null;
      if (legendChk) legendChk.checked = this.state.falseColorLegend !== false;

      const pc = this.state.probeConfig ?? DEFAULT_PROBE_CONFIG;
      for (const chk of Array.from(root.querySelectorAll<HTMLInputElement>('input[data-probe-cfg]'))) {
        const k = chk.dataset.probeCfg as keyof ProbeDisplayConfig;
        chk.checked = !!pc[k];
      }

      const lang = this.state.lang ?? 'en';
      for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-set-lang]'))) {
        b.classList.toggle('active', b.dataset.setLang === lang);
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Index of the panel currently marked active in the grid. */
  private activeSlotIndex(): number {
    const cells = resolveCells(this.state, this.state.layout);
    return Math.min(cells.length - 1, Math.max(0, this.state.activeSlot || 0));
  }

  /** Last known source video width, used by the "match source" multiplier. */
  private lastSourceWidth: number | undefined;

  setSourceWidth(width: number | undefined): void {
    this.lastSourceWidth = width && width > 0 ? width : undefined;
    if (this.settingsOpen) this.renderCaptureSizeHint();
  }

  /**
   * Show the pixel size the next snapshot will produce, so "3x" is not a
   * mystery number and a clamped result is visible before it happens.
   */
  private renderCaptureSizeHint(): void {
    const root = this.root;
    if (!root) return;
    const hint = root.getElementById('capture-size-hint');
    if (!hint) return;
    const slot = this.activeSlotIndex();
    const target = this.targets.find((t) => t.slot === slot) ?? this.targets[0];
    if (!target) {
      hint.textContent = '';
      return;
    }
    const cssW = Math.max(1, Math.round(target.gpu.clientWidth));
    const cssH = Math.max(1, Math.round(target.gpu.clientHeight));
    const capture = this.state.capture ?? DEFAULT_CAPTURE;
    const plan = planCapture({
      cssWidth: cssW,
      cssHeight: cssH,
      scale: capture.scale,
      sourceWidth: this.lastSourceWidth,
      mode: target.mode,
      planes: 4,
      wavePad: WAVE_PAD,
      // Conservative defaults until the device is queried; the exporter
      // re-plans against the real limits, so this hint never over-promises.
      maxEdge: 8192,
      maxDensityBytes: 128 * 1024 * 1024,
    });
    const size = `${plan.width} × ${plan.height}`;
    const label = capture.scale === 'match' ? 'match' : `${capture.scale}×`;
    hint.textContent = plan.clamped ? `${size} (${label} · GPU limit)` : `${size} (${label})`;
  }

  private wireSettingsSheet(): void {
    const root = this.root;
    if (!root) return;

    root.getElementById('settings-close')?.addEventListener('click', () => this.setSettingsModalOpen(false));
    root.getElementById('settings-done-btn')?.addEventListener('click', () => this.setSettingsModalOpen(false));

    for (const b of Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-set-lang]'))) {
      b.addEventListener('click', () => {
        const lang: Locale = b.dataset.setLang === 'zh' ? 'zh' : 'en';
        if (lang === this.state.lang) return;
        this.state = { ...this.state, lang };
        this.renderedLang = lang;
        this.applyLocalization();
        this.handlers.onStateChange({ lang });
      });
    }

    const bindSet = (id: string, ev: string, fn: (el: HTMLInputElement | HTMLSelectElement) => void): void => {
      const el = root.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      el?.addEventListener(ev, () => {
        if (this.syncing || !el) return;
        fn(el);
      });
    };

    bindSet('set-panel-opacity', 'input', (el) => {
      const panelOpacity = Number(el.value);
      this.state = { ...this.state, panelOpacity };
      const panel = root.querySelector<HTMLElement>('.panel');
      if (panel) panel.style.setProperty('--panel-alpha', String(panelOpacity));
      this.handlers.onStateChange({ panelOpacity });
    });

    bindSet('set-grat-bright', 'input', (el) => {
      const graticuleBrightness = Number(el.value);
      this.state = { ...this.state, graticuleBrightness };
      this.handlers.onStateChange({ graticuleBrightness });
    });

    bindSet('set-trace-mode', 'change', (el) => {
      const defaultTraceMode = el.value as NonNullable<HudState['defaultTraceMode']>;
      const layout = this.state.layout;
      const nextCells = resolveCells(this.state, layout).map((c) => ({
        ...c,
        traceMode: resolveTraceForMode(c.mode, defaultTraceMode),
      }));
      this.state = {
        ...this.state,
        defaultTraceMode,
        cells: { ...this.state.cells, [layout]: nextCells },
      };
      this.handlers.onStateChange({ defaultTraceMode });
      this.handlers.onCellsReplace(layout, nextCells);
      this.refreshCellChrome();
    });

    bindSet('set-primaries', 'change', (el) => {
      const primariesMode = el.value as HudState['primariesMode'];
      this.state = { ...this.state, primariesMode };
      this.handlers.onStateChange({ primariesMode });
    });

    bindSet('set-hdr-mode', 'change', (el) => {
      const hdrMode = el.value as HdrMode;
      this.state = { ...this.state, hdrMode };
      this.handlers.onStateChange({ hdrMode });
      this.syncInputs();
    });

    bindSet('set-matrix', 'change', (el) => {
      const matrixMode = el.value as HudState['matrixMode'];
      this.state = { ...this.state, matrixMode };
      this.handlers.onStateChange({ matrixMode });
      this.syncInputs();
    });

    bindSet('set-range', 'change', (el) => {
      const rangeMode = el.value as HudState['rangeMode'];
      this.state = { ...this.state, rangeMode };
      this.handlers.onStateChange({ rangeMode });
      this.syncInputs();
    });

    bindSet('set-signal', 'change', (el) => {
      const signalMode = el.value as HudState['signalMode'];
      this.state = { ...this.state, signalMode };
      this.handlers.onStateChange({ signalMode });
      this.syncInputs();
    });

    bindSet('set-sdr-white', 'change', (el) => {
      const sdrWhiteNits = Number(el.value) || 203;
      this.state = { ...this.state, sdrWhiteNits };
      this.handlers.onStateChange({ sdrWhiteNits });
    });

    bindSet('set-fc-enable', 'change', (el) => {
      const videoFalseColor = (el as HTMLInputElement).checked;
      this.state = { ...this.state, videoFalseColor };
      this.handlers.onStateChange({ videoFalseColor });
      this.syncInputs();
    });

    bindSet('set-fc-preset', 'change', (el) => {
      const falseColorPreset = el.value as FalseColorPreset;
      const patch: Partial<HudState> = { falseColorPreset };
      if (!this.state.videoFalseColor) {
        patch.videoFalseColor = true;
      }
      this.state = { ...this.state, ...patch };
      this.handlers.onStateChange(patch);
      this.syncInputs();
      this.syncSettingsModal();
    });

    bindSet('set-fc-opacity', 'input', (el) => {
      const falseColorOpacity = Number(el.value);
      this.state = { ...this.state, falseColorOpacity };
      this.handlers.onStateChange({ falseColorOpacity });
    });

    bindSet('set-fc-legend', 'change', (el) => {
      const falseColorLegend = (el as HTMLInputElement).checked;
      this.state = { ...this.state, falseColorLegend };
      this.handlers.onStateChange({ falseColorLegend });
    });

    for (const chk of Array.from(root.querySelectorAll<HTMLInputElement>('input[data-probe-cfg]'))) {
      chk.addEventListener('change', () => {
        if (this.syncing) return;
        const k = chk.dataset.probeCfg as keyof ProbeDisplayConfig;
        const probeConfig: ProbeDisplayConfig = {
          ...(this.state.probeConfig ?? DEFAULT_PROBE_CONFIG),
          [k]: chk.checked,
        };
        this.state = { ...this.state, probeConfig };
        this.handlers.onStateChange({ probeConfig });
      });
    }

    const setCapture = (patch: Partial<CaptureSettings>): void => {
      const capture: CaptureSettings = { ...(this.state.capture ?? DEFAULT_CAPTURE), ...patch };
      this.state = { ...this.state, capture };
      this.renderCaptureSizeHint();
      this.syncSettingsModal();
      this.handlers.onStateChange({ capture });
    };

    bindSet('set-capture-format', 'change', (el) => {
      const format = el.value as CaptureSettings['format'];
      const capture = { ...(this.state.capture ?? DEFAULT_CAPTURE), format };
      // A transparent plate cannot be stored in JPEG; show what will happen.
      const background = effectiveBackground(format, capture.background);
      setCapture({ format, background });
    });
    bindSet('set-capture-scale', 'change', (el) => {
      const raw = el.value;
      const scale: CaptureSettings['scale'] = raw === 'match' ? 'match' : (Number(raw) as 1 | 2 | 3 | 4);
      setCapture({ scale });
    });
    bindSet('set-capture-background', 'change', (el) => {
      setCapture({ background: el.value as CaptureSettings['background'] });
    });

    root.getElementById('capture-now-btn')?.addEventListener('click', () => {
      this.handlers.onCapture?.(this.activeSlotIndex());
    });

    root.getElementById('reset-all-btn')?.addEventListener('click', () => {
      const keepLang = this.state.lang;
      const keepPos = this.state.hostPosition;
      const fresh: HudState = {
        ...DEFAULT_STATE,
        visible: true,
        lang: keepLang,
        hostPosition: keepPos,
        probeConfig: { ...DEFAULT_PROBE_CONFIG },
      };
      this.state = fresh;
      this.setSettingsModalOpen(false);
      this.handlers.onResetAll?.();
    });
  }

  private wire(): void {
    const root = this.root;
    if (!root) return;

    this.wireLayoutButtons();
    this.wireModeButtons();
    this.wireSettingsSheet();

    root.getElementById('close')?.addEventListener('click', () => this.handlers.onClose());
    root.getElementById('pip-btn')?.addEventListener('click', () => this.handlers.onOpenPip());
    root.getElementById('perf')?.addEventListener('click', () => this.handlers.onToggleLock());

    root.getElementById('capture-btn')?.addEventListener('click', (e: Event) => {
      // Shift/Alt captures only the panel under the pointer's cell selection;
      // otherwise the active cell. Same handler either way, different slot.
      const slot = (e as MouseEvent).shiftKey || (e as MouseEvent).altKey
        ? this.activeSlotIndex()
        : 0;
      this.handlers.onCapture?.(slot);
    });

    root.getElementById('lang-btn')?.addEventListener('click', () => {
      const lang: Locale = (this.state.lang ?? 'en') === 'zh' ? 'en' : 'zh';
      this.state = { ...this.state, lang };
      this.renderedLang = lang;
      this.applyLocalization();
      this.handlers.onStateChange({ lang });
    });

    root.getElementById('settings-btn')?.addEventListener('click', () => {
      this.setSettingsModalOpen(!this.settingsOpen);
    });

    const backdrop = root.getElementById('settings-backdrop');
    backdrop?.addEventListener('click', (e) => {
      if (e.target === backdrop) this.setSettingsModalOpen(false);
    });

    root.getElementById('eyedropper-btn')?.addEventListener('click', () => {
      const next = !this.state.eyedropperEnabled;
      this.state = { ...this.state, eyedropperEnabled: next };
      this.handlers.onStateChange({ eyedropperEnabled: next });
      this.syncInputs();
    });

    root.getElementById('false-color-btn')?.addEventListener('click', () => {
      const next = !this.state.videoFalseColor;
      this.state = { ...this.state, videoFalseColor: next };
      this.handlers.onStateChange({ videoFalseColor: next });
      this.syncInputs();
      if (this.settingsOpen) this.syncSettingsModal();
    });

    const applyNitPreset = (nitLow: number, nitHigh: number): void => {
      this.state = { ...this.state, nitLow, nitHigh };
      this.handlers.onStateChange({ nitLow, nitHigh });
      this.syncInputs();
    };
    root.getElementById('preset-100-1000')?.addEventListener('click', () => applyNitPreset(100, 1000));
    root.getElementById('preset-203-1000')?.addEventListener('click', () => applyNitPreset(203, 1000));
    root.getElementById('preset-203-4000')?.addEventListener('click', () => applyNitPreset(203, 4000));

    // Zone Color All ONLY touches scopes where Nit zones make sense (Waveform, Parade, Histogram)!
    root.getElementById('zone-all-btn')?.addEventListener('click', () => {
      const layout = this.state.layout;
      const cells = resolveCells(this.state, layout);
      const eligible = cells.filter((c) => supportsHdrZones(c.mode));
      if (eligible.length === 0) return;
      const allZones = eligible.every((c) => c.traceMode === 'hdr-zones');
      const next = cells.map((c) => {
        if (!supportsHdrZones(c.mode)) return c;
        return {
          ...c,
          traceMode: (allZones ? 'channel' : 'hdr-zones') as TraceColorMode,
        };
      });
      this.state = { ...this.state, cells: { ...this.state.cells, [layout]: next } };
      this.handlers.onCellsReplace(layout, next);
      this.refreshCellChrome();
    });

    const bind = (
      id: string,
      ev: string,
      fn: (el: HTMLSelectElement | HTMLInputElement) => void,
    ): void => {
      const el = root.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
      el?.addEventListener(ev, () => {
        if (this.syncing || !el) return;
        fn(el);
      });
    };

    bind('fc-preset', 'change', (el) => {
      const falseColorPreset = (el as HTMLSelectElement).value as FalseColorPreset;
      const patch: Partial<HudState> = { falseColorPreset };
      if (!this.state.videoFalseColor) {
        patch.videoFalseColor = true;
      }
      this.state = { ...this.state, ...patch };
      this.handlers.onStateChange(patch);
      this.syncInputs();
      if (this.settingsOpen) this.syncSettingsModal();
    });
    bind('precision', 'change', (el) => {
      const precision = (el as HTMLSelectElement).value as PrecisionMode;
      this.state = { ...this.state, precision };
      this.handlers.onStateChange({ precision });
    });
    bind('hdr-mode', 'change', (el) => {
      const hdrMode = (el as HTMLSelectElement).value as HdrMode;
      this.state = { ...this.state, hdrMode };
      this.handlers.onStateChange({ hdrMode });
      if (this.settingsOpen) this.syncSettingsModal();
    });
    bind('nit-low', 'change', (el) => {
      const nitLow = Math.max(0.05, Math.min(9999, Number(el.value) || 100));
      const nitHigh = Math.max(nitLow + 1, this.state.nitHigh);
      this.state = { ...this.state, nitLow, nitHigh };
      this.handlers.onStateChange({ nitLow, nitHigh });
      this.syncInputs();
    });
    bind('nit-high', 'change', (el) => {
      const nitHigh = Math.max(1, Math.min(10000, Number(el.value) || 1000));
      const nitLow = Math.min(this.state.nitLow, Math.max(0.05, nitHigh - 1));
      this.state = { ...this.state, nitLow, nitHigh };
      this.handlers.onStateChange({ nitLow, nitHigh });
      this.syncInputs();
    });

    bind('layout', 'change', (el) => {
      this.handlers.onLayoutChange((el as HTMLSelectElement).value as Layout);
    });
    bind('signal', 'change', (el) => {
      this.handlers.onStateChange({
        signalMode: (el as HTMLSelectElement).value as HudState['signalMode'],
      });
    });
    bind('range', 'change', (el) => {
      this.handlers.onStateChange({
        rangeMode: (el as HTMLSelectElement).value as HudState['rangeMode'],
      });
    });
    bind('matrix', 'change', (el) => {
      this.handlers.onStateChange({
        matrixMode: (el as HTMLSelectElement).value as HudState['matrixMode'],
      });
    });

    bind('units', 'change', (el) => {
      const units = (el as HTMLSelectElement).value as HudState['units'];
      const slot = Math.min(resolveCells(this.state).length - 1, Math.max(0, this.state.activeSlot || 0));
      this.handlers.onStateChange({ units });
      this.emitCellPatch(slot, { units });
    });
    bind('bars', 'change', (el) => {
      const barTargets = Number((el as HTMLSelectElement).value) === 1 ? 1 : (0.75 as 0.75 | 1);
      const cells = resolveCells(this.state);
      const vecSlot = cells.findIndex((c) => c.mode === 'vectorscope');
      const slot = vecSlot >= 0 ? vecSlot : Math.max(0, this.state.activeSlot || 0);
      this.handlers.onStateChange({ barTargets });
      this.emitCellPatch(slot, { barTargets });
    });
    bind('coord', 'change', (el) => {
      const coord = (el as HTMLSelectElement).value as HudState['coord'];
      const cells = resolveCells(this.state);
      const cieSlot = cells.findIndex((c) => c.mode === 'cie');
      const slot = cieSlot >= 0 ? cieSlot : Math.max(0, this.state.activeSlot || 0);
      this.handlers.onStateChange({ coord });
      this.emitCellPatch(slot, { coord, panX: null, panY: null });
    });
    bind('gain', 'input', (el) => {
      const gain = Number((el as HTMLInputElement).value);
      const layout = this.state.layout;
      const cells = resolveCells(this.state, layout).map((c) => ({ ...c, gain }));
      this.state = { ...this.state, gain, cells: { ...this.state.cells, [layout]: cells } };
      this.handlers.onStateChange({ gain });
      this.handlers.onCellsReplace(layout, cells);
    });
    bind('zoom', 'input', (el) => {
      const zoom = Number((el as HTMLInputElement).value);
      const slot = Math.min(resolveCells(this.state).length - 1, Math.max(0, this.state.activeSlot || 0));
      this.handlers.onStateChange({ zoom });
      this.emitCellPatch(slot, zoom <= 1.01 ? { zoom: 1, panX: null, panY: null } : { zoom });
    });

    const header = root.querySelector('header') as HTMLElement;
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    header.addEventListener('pointerdown', (e) => {
      if (this.isFill) return;
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const rect = this.host!.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!drag || !this.host) return;
      this.host.style.setProperty('left', `${Math.max(0, drag.left + e.clientX - drag.x)}px`, 'important');
      this.host.style.setProperty('right', 'auto', 'important');
      this.host.style.setProperty('top', `${Math.max(0, drag.top + e.clientY - drag.y)}px`, 'important');
    });
    header.addEventListener('pointerup', () => {
      if (!drag || !this.host) return;
      const rect = this.host.getBoundingClientRect();
      drag = null;
      this.handlers.onStateChange({
        hostPosition: { left: Math.round(rect.left), top: Math.round(rect.top), right: 16 },
      });
    });

    const grip = root.getElementById('resize-grip');
    if (grip && !this.isFill) {
      let rDrag: { x: number; y: number; w: number; h: number } | null = null;
      grip.addEventListener('pointerdown', (e) => {
        if (!this.host) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = this.host.getBoundingClientRect();
        rDrag = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
        grip.setPointerCapture(e.pointerId);
      });
      grip.addEventListener('pointermove', (e) => {
        if (!rDrag || !this.host) return;
        const nextW = Math.max(340, Math.round(rDrag.w + e.clientX - rDrag.x));
        const nextH = Math.max(260, Math.round(rDrag.h + e.clientY - rDrag.y));
        this.host.style.setProperty('width', `${nextW}px`, 'important');
        this.host.style.setProperty('height', `${nextH}px`, 'important');
      });
      grip.addEventListener('pointerup', () => {
        if (!rDrag) return;
        rDrag = null;
        this.handlers.onResize?.();
      });
    }

    this.syncModeButtons();
  }

  private syncing = false;

  private syncInputs(): void {
    const root = this.root;
    if (!root) return;
    this.syncing = true;
    try {
      const set = (id: string, value: string): void => {
        const el = root.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
        if (el) el.value = value;
      };
      const cells = resolveCells(this.state);
      const slot = Math.min(cells.length - 1, Math.max(0, this.state.activeSlot || 0));
      const focused = cells[slot] ?? defaultCellForMode(this.state.mode, this.state);

      set('fc-preset', this.state.falseColorPreset ?? 'auto');
      set('precision', this.state.precision ?? 'auto');
      set('hdr-mode', this.state.hdrMode ?? 'auto');
      set('nit-low', String(this.state.nitLow ?? 100));
      set('nit-high', String(this.state.nitHigh ?? 1000));
      set('layout', this.state.layout);
      set('signal', this.state.signalMode);
      set('range', this.state.rangeMode);
      set('matrix', this.state.matrixMode ?? 'auto');
      set('units', focused.units);
      set('bars', String(focused.barTargets ?? 0.75));
      set('coord', focused.coord);
      set('gain', String(focused.gain));
      set('zoom', String(focused.zoom));

      const panel = root.querySelector<HTMLElement>('.panel');
      if (panel) panel.style.setProperty('--panel-alpha', String(this.state.panelOpacity ?? 0.97));

      const eyeBtn = root.getElementById('eyedropper-btn');
      if (eyeBtn) {
        eyeBtn.setAttribute('aria-pressed', this.state.eyedropperEnabled ? 'true' : 'false');
        eyeBtn.classList.toggle('eyedropper-on', !!this.state.eyedropperEnabled);
      }

      const s = this.i18n();
      const fcBtn = root.getElementById('false-color-btn');
      if (fcBtn) {
        fcBtn.setAttribute('aria-pressed', this.state.videoFalseColor ? 'true' : 'false');
        fcBtn.classList.toggle('fc-on', !!this.state.videoFalseColor);
        fcBtn.textContent = `◐ ${this.state.videoFalseColor ? s.falseColorOn : s.falseColor}`;
      }

      const sumHint = root.getElementById('nit-summary');
      if (sumHint) {
        sumHint.textContent = `${Math.round(this.state.nitLow ?? 100)}n / ${Math.round(this.state.nitHigh ?? 1000)}n · ${s.wheelZoomHint}`;
      }
    } finally {
      this.syncing = false;
    }
  }
}
