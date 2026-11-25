import type { ColorSpaceInfo, RangeDiagnosis } from '../core/range-detector';
import type { QualityTier } from '../core/perf-governor';
import type { ScopeMode } from '../gpu/scope-renderer';
import { assignSlot, resolvePanels, type HudState, type Layout } from './settings';

export interface PanelTargets {
  mode: ScopeMode;
  gpu: HTMLCanvasElement;
  grat: HTMLCanvasElement;
}

export interface HudHandlers {
  onStateChange(patch: Partial<HudState>): void;
  onLayoutChange(layout: Layout): void;
  /** A cell's scope was reassigned by the user. */
  onPanelsChange(layout: Layout, panels: ScopeMode[]): void;
  onClose(): void;
  onOpenPip(): void;
  onToggleLock(): void;
}

const HOST_ID = 'video-scopes-host';

/** Modes a user can pin into the single-view slot. */
const MODE_LABELS: Record<ScopeMode, string> = {
  'waveform-luma': 'Wave',
  'waveform-rgb': 'RGB',
  'waveform-parade': 'Parade',
  vectorscope: 'Vector',
  cie: 'CIE',
};

/**
 * CSS class for a layout.
 *
 * The container is itself `.grid`, so a four-up layout also called `.grid`
 * produced the selector `.grid.grid` — which matches *any* element with class
 * "grid", including the container in single view. That rule came after
 * `.grid.single` and, at equal specificity, won: every layout rendered as 2x2.
 */
function layoutClass(layout: Layout): string {
  return layout === 'grid' ? 'quad' : layout;
}

/** Panel counts offered directly in the toolbar. */
const LAYOUTS: { layout: Layout; label: string; title: string }[] = [
  { layout: 'single', label: '1', title: 'One scope' },
  { layout: 'pair', label: '2', title: 'Two scopes' },
  { layout: 'triple', label: '3', title: 'Three scopes' },
  { layout: 'grid', label: '4', title: 'Four scopes' },
];

const STYLE = `
  :host { all: initial; }

  /*
   * Fixed column: header, picker, scopes, options. Only the scopes row flexes,
   * so shrinking the window compresses the scopes and never hides the controls.
   * The previous version put seven controls in a wrapping footer, which at
   * narrow widths grew to three rows and squeezed the scopes to a sliver.
   */
  .panel {
    display: flex; flex-direction: column;
    height: 100%; min-height: 0;
    font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #b9c6d0; background: #0b0f12;
    border: 1px solid #ffffff1a; border-radius: 8px;
    overflow: hidden;
  }

  header {
    display: flex; align-items: center; gap: 5px; flex: 0 0 auto;
    padding: 4px 6px; background: #12181d;
    cursor: move; user-select: none;
    border-bottom: 1px solid #ffffff14;
  }
  header .title { color: #d7e3ec; font-weight: 500; }
  header .spacer { flex: 1; }

  .badge {
    padding: 0 5px; border-radius: 999px; background: #1c262d;
    color: #8ea3b0; white-space: nowrap; font-size: 10px;
  }
  .badge.ok { background: #16291d; color: #8cd9a5; }
  .badge.warn { background: #3a2a12; color: #f0c070; }
  .badge.locked { background: #16243a; color: #8ab4e8; }
  .badge.mono { font-variant-numeric: tabular-nums; cursor: pointer; }

  button {
    font: inherit; font-size: 11px; color: #cfe0ea; background: #16202a;
    border: 1px solid #ffffff20; border-radius: 4px;
    padding: 0 6px; cursor: pointer; line-height: 1.7;
  }
  button:hover { background: #1d2a36; }
  button[aria-pressed="true"] {
    background: #1e3a52; border-color: #4e7fa8; color: #cfe6fa;
  }

  /* ---- scope picker ---------------------------------------------------- */
  nav.bar {
    display: flex; gap: 6px; align-items: center; flex: 0 0 auto;
    padding: 4px 6px; background: #0f1418;
    border-bottom: 1px solid #ffffff10;
    overflow-x: auto; scrollbar-width: none;
  }
  nav.bar::-webkit-scrollbar { display: none; }
  nav.bar .grp { display: flex; gap: 2px; }
  nav.bar .sep { width: 1px; height: 16px; background: #ffffff1a; flex: 0 0 auto; }
  nav.bar button { white-space: nowrap; min-width: 26px; }

  /* ---- scope area ------------------------------------------------------ */
  .grid {
    flex: 1 1 auto; min-height: 0;
    display: grid; gap: 3px; padding: 4px;
    background: #080b0e;
  }
  /* Height is the scarce resource: the scopes are wide and short. */
  .grid.single { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  .grid.pair { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
  .grid.quad { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .grid.triple { grid-template-columns: 1fr; grid-template-rows: repeat(3, 1fr); }

  .cell {
    position: relative; min-width: 0; min-height: 0;
    background: #0d1117; border-radius: 3px; overflow: hidden;
  }
  .cell canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .cell canvas.grat { pointer-events: none; }
  .cell .tag {
    position: absolute; top: 2px; right: 4px; z-index: 2;
    font: inherit; font-size: 9px; color: #ffffff59;
    background: #0d1117cc; border: 1px solid #ffffff1a; border-radius: 3px;
    padding: 0 1px; max-width: 70px; cursor: pointer;
  }
  .cell .tag:hover { color: #cfe0ea; border-color: #ffffff40; }
  .grid.single .cell .tag { opacity: 0.45; }
  .grid.single .cell .tag:hover { opacity: 1; }

  /* ---- options, collapsible ------------------------------------------- */
  details.options {
    flex: 0 0 auto; background: #0f1418;
    border-top: 1px solid #ffffff14;
    max-height: 45%; overflow-y: auto;
  }
  details.options > summary {
    padding: 3px 8px; cursor: pointer; color: #8ea3b0;
    list-style: none; user-select: none;
  }
  details.options > summary::-webkit-details-marker { display: none; }
  details.options > summary::before { content: '▸ '; }
  details.options[open] > summary::before { content: '▾ '; }
  .opts {
    display: grid; gap: 4px 10px; padding: 0 8px 7px;
    grid-template-columns: repeat(auto-fit, minmax(112px, 1fr));
    align-items: center;
  }
  .opts label {
    display: grid; grid-template-columns: auto 1fr; gap: 4px;
    align-items: center; color: #8ea3b0; font-size: 10px;
  }
  select {
    font: inherit; font-size: 10px; color: #cfe0ea; background: #16202a;
    border: 1px solid #ffffff20; border-radius: 4px;
    padding: 0 2px; width: 100%; min-width: 0;
  }
  input[type=range] { width: 100%; min-width: 0; accent-color: #4e7fa8; margin: 0; }

  .notice {
    flex: 0 0 auto; margin: 0; padding: 3px 8px;
    font-size: 10px; background: #3a2a12; color: #f0c070;
    border-bottom: 1px solid #ffffff10;
  }
`;

export class Hud {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  /** Document this panel was built in; canvas contexts are bound to it. */
  private doc: Document | null = null;
  private canvases = new Map<ScopeMode, PanelTargets>();
  private state: HudState;
  private readonly handlers: HudHandlers;

  constructor(initial: HudState, handlers: HudHandlers) {
    this.state = initial;
    this.handlers = handlers;
  }

  get mounted(): boolean {
    return this.host !== null;
  }

  get hostElement(): HTMLElement | null {
    return this.host;
  }

  /**
   * Build the panel inside `doc`.
   *
   * The document is a parameter because a Document PiP window has its own. Every
   * element, including the canvases, must be created by that document: moving a
   * canvas between documents invalidates its WebGPU context.
   */
  mount(doc: Document = document, opts: { fill?: boolean } = {}): void {
    if (this.host) return;
    const host = doc.createElement('div');
    host.id = HOST_ID;
    // `all: initial` MUST come first: it resets every property, so writing it
    // after `position: fixed` silently drops the host back into normal flow.
    host.style.cssText = opts.fill
      ? 'all:initial;position:absolute;inset:0;width:100%;height:100%;' +
        'min-width:320px;min-height:240px;z-index:1;overflow:hidden;'
      : 'all:initial;position:fixed;top:16px;right:16px;left:auto;' +
        'width:720px;height:540px;min-width:320px;min-height:260px;' +
        'z-index:2147483646;resize:both;overflow:hidden;';

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = this.template();

    this.host = host;
    this.root = root;
    this.doc = doc;
    if (!opts.fill) this.applyPosition();
    (doc.documentElement ?? doc.body).appendChild(host);

    this.buildCells();
    this.wire();
    this.syncInputs();
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.canvases.clear();
  }

  panelCanvases(): PanelTargets[] {
    return Array.from(this.canvases.values());
  }

  /**
   * Adopt the host's state for presentation-only fields.
   *
   * Deliberately does NOT overwrite `layout` or `mode`: those describe which
   * canvases exist, and rebuilding them is a side effect that must only happen
   * through relayout()/setSingleMode(). Assigning them here let a late
   * refreshHud() replace a freshly rebuilt single view with a stale grid.
   */
  setState(state: HudState): void {
    const { layout: _layout, mode: _mode, ...rest } = state;
    this.state = { ...this.state, ...rest };
    this.applyPosition();
    this.syncInputs();
    this.syncModeButtons();
  }

  relayout(layout: Layout): void {
    if (!this.root) return;
    const grid = this.root.querySelector('.grid') as HTMLElement | null;
    if (!grid) return;
    grid.className = `grid ${layoutClass(layout)}`;
    // Use the layout the caller just asserted, not a locally cached copy that a
    // racing setState() may already have overwritten.
    this.buildCells(layout);
  }

  /** Switch which scope fills the single-view slot. */
  setSingleMode(mode: ScopeMode): void {
    this.state = { ...this.state, mode };
    this.syncModeButtons();
    if (this.state.layout === 'single') {
      const grid = this.root?.querySelector('.grid') as HTMLElement | null;
      if (grid) {
        grid.className = 'grid single';
        this.buildCells();
      }
    }
  }

  setColorInfo(info: ColorSpaceInfo): void {
    const el = this.root?.getElementById('cs');
    if (!el) return;
    const range = info.fullRange === null ? 'range?' : info.fullRange ? 'full' : 'limited';
    const parts = [(info.matrix ?? '?').toUpperCase(), `src:${range}`, info.transfer];
    if (info.format) parts.push(info.format);
    el.textContent = parts.join(' · ');
    el.title =
      'Colour metadata read from the decoder. The scopes may draw on a different ' +
      'axis — see the axis badge.';
  }

  setDiagnosis(d: RangeDiagnosis): void {
    const status = this.root?.getElementById('status');
    const warn = this.root?.getElementById('warn');
    if (status) {
      status.textContent = `axis:${d.effective}`;
      status.className = `badge ${d.effective === 'full' ? 'ok' : ''}`;
      status.title =
        d.effective === 'full'
          ? 'Plotting on a full-range axis (0-255). Content with headroom reads above 100 IRE.'
          : 'Plotting on a limited-range axis (16-235). Legal white reads 100 IRE.';
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
  }

  setPerf(
    fps: number,
    gpuMs: number | null,
    tier: QualityTier,
    upload?: 'external' | 'copy' | 'raw',
  ): void {
    const el = this.root?.getElementById('perf');
    if (!el) return;
    const locked = this.state.lockedTier !== null;
    const parts = [`${Math.round(fps)}fps`];
    if (gpuMs !== null) parts.push(`${gpuMs.toFixed(1)}ms`);
    if (upload === 'external') parts.push('0copy');
    else if (upload) parts.push(upload);
    parts.push(locked ? `lock:${tier}` : `t${tier}`);
    el.textContent = parts.join(' ');
    el.className = `badge mono ${locked ? 'locked' : ''}`;
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
    if (!this.host) return;
    const { left, top, right } = this.state.hostPosition;
    this.host.style.top = `${top}px`;
    if (left === null) {
      this.host.style.left = 'auto';
      this.host.style.right = `${right}px`;
    } else {
      this.host.style.left = `${left}px`;
      this.host.style.right = 'auto';
    }
  }

  private template(): string {
    return `
      <style>${STYLE}</style>
      <div class="panel">
        <header>
          <span class="title">Scopes</span>
          <span class="badge" id="status">axis:–</span>
          <span class="badge" id="cs">–</span>
          <span class="badge warn" id="warn" hidden></span>
          <span class="spacer"></span>
          <span class="badge mono" id="perf">–</span>
          <button id="close" title="Close (Alt+S)">✕</button>
        </header>

        <div class="notice" id="notice" hidden></div>
        <div class="notice" id="probe" hidden></div>

        <nav class="bar">
          <span class="grp" id="layouts"></span>
          <span class="sep"></span>
          <span class="grp" id="modes"></span>
        </nav>

        <div class="grid ${layoutClass(this.state.layout)}"></div>

        <details class="options" open>
          <summary>Options</summary>
          <div class="opts">
            <label>layout
              <select id="layout">
                <option value="single">1 · single</option>
                <option value="pair">2 · side by side</option>
                <option value="triple">3 · stacked</option>
                <option value="grid">4 · grid</option>
              </select>
            </label>
            <label>units
              <select id="units">
                <option value="ire">IRE</option>
                <option value="code8">8-bit</option>
                <option value="code10">10-bit</option>
                <option value="mv">mV</option>
                <option value="nits">nits</option>
              </select>
            </label>
            <label>range
              <select id="range">
                <option value="auto">auto</option>
                <option value="limited">limited</option>
                <option value="full">full</option>
              </select>
            </label>
            <label>signal
              <select id="signal">
                <option value="display">display</option>
                <option value="raw">raw YUV</option>
              </select>
            </label>
            <label>CIE
              <select id="coord">
                <option value="xy">1931 xy</option>
                <option value="uv">1976 u'v'</option>
              </select>
            </label>
            <label>gain
              <input id="gain" type="range" min="0.2" max="3" step="0.1">
            </label>
            <label>zoom
              <input id="zoom" type="range" min="1" max="8" step="1">
            </label>
          </div>
        </details>
      </div>`;
  }

  private buildCells(layout: Layout = this.state.layout): void {
    const root = this.root;
    if (!root) return;
    const grid = root.querySelector('.grid') as HTMLElement;
    const panels = resolvePanels(layout, this.state.mode, this.state.panels);
    const options = (Object.keys(MODE_LABELS) as ScopeMode[])
      .map((m) => `<option value="${m}">${MODE_LABELS[m]}</option>`)
      .join('');

    grid.innerHTML = panels
      .map(
        (m, slot) =>
          `<div class="cell" data-mode="${m}" data-slot="${slot}">
             <canvas class="gpu"></canvas>
             <canvas class="grat"></canvas>
             <select class="tag" data-slot="${slot}" title="Scope in this panel">${options}</select>
           </div>`,
      )
      .join('');
    for (const sel of Array.from(grid.querySelectorAll<HTMLSelectElement>('select.tag'))) {
      sel.value = panels[Number(sel.dataset.slot)]!;
      sel.addEventListener('change', () => {
        const slot = Number(sel.dataset.slot);
        const picked = sel.value as ScopeMode;
        const current = resolvePanels(this.state.layout, this.state.mode, this.state.panels);
        const next = assignSlot(current, slot, picked);
        this.state = { ...this.state, panels: { ...this.state.panels, [this.state.layout]: next } };
        this.handlers.onPanelsChange(this.state.layout, next);
      });
    }

    this.canvases.clear();
    for (const cell of Array.from(grid.querySelectorAll<HTMLElement>('.cell'))) {
      const mode = cell.dataset.mode as ScopeMode;
      const gpu = cell.querySelector<HTMLCanvasElement>('canvas.gpu');
      const grat = cell.querySelector<HTMLCanvasElement>('canvas.grat');
      if (gpu && grat) this.canvases.set(mode, { mode, gpu, grat });
    }
  }

  private syncModeButtons(): void {
    const root = this.root;
    if (!root) return;
    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('#modes button'))) {
      btn.setAttribute('aria-pressed', btn.dataset.mode === this.state.mode ? 'true' : 'false');
    }
    for (const btn of Array.from(root.querySelectorAll<HTMLButtonElement>('#layouts button'))) {
      btn.setAttribute('aria-pressed', btn.dataset.layout === this.state.layout ? 'true' : 'false');
    }
    // The per-cell pickers are rebuilt by buildCells; this keeps them correct
    // after a state-only update that did not rebuild the grid.
    const panels = resolvePanels(this.state.layout, this.state.mode, this.state.panels);
    for (const sel of Array.from(root.querySelectorAll<HTMLSelectElement>('select.tag'))) {
      const slot = Number(sel.dataset.slot);
      if (panels[slot]) sel.value = panels[slot]!;
    }
  }

  private wire(): void {
    const root = this.root;
    if (!root) return;

    // Panel-count buttons. The <select> in Options does the same thing, but it
    // is collapsed by default and too slow to reach mid-grade, so the count is
    // also one click away in the toolbar.
    const layoutNav = root.getElementById('layouts')!;
    layoutNav.innerHTML = LAYOUTS.map(
      (l) =>
        `<button data-layout="${l.layout}" type="button" title="${l.title}" aria-pressed="false">${l.label}</button>`,
    ).join('');
    for (const btn of Array.from(layoutNav.querySelectorAll<HTMLButtonElement>('button'))) {
      btn.addEventListener('click', () => {
        const layout = btn.dataset.layout as Layout;
        this.state = { ...this.state, layout };
        this.handlers.onLayoutChange(layout);
        this.syncModeButtons();
        // Keep the Options dropdown in step: two controls for one value that can
        // disagree is a bug report waiting to happen.
        this.syncInputs();
      });
    }

    // Scope picker. Choosing a scope switches to single view: in a multi-panel
    // layout "use this scope" has no other sensible meaning, and it is the
    // fastest way to get one scope big enough to read.
    const nav = root.getElementById('modes')!;
    nav.innerHTML = (Object.keys(MODE_LABELS) as ScopeMode[])
      .map((m) => `<button data-mode="${m}" type="button">${MODE_LABELS[m]}</button>`)
      .join('');
    for (const btn of Array.from(nav.querySelectorAll<HTMLButtonElement>('button'))) {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode as ScopeMode;
        // Record the choice locally first: onLayoutChange rebuilds the cells from
        // this.state.mode, so switching layout before the mode is known would
        // rebuild the grid with the previous scope (or the whole grid again).
        // Set the local state first so every later render reads a consistent
        // (mode, layout) pair. Then notify: mode change only updates the
        // highlight, layout change rebuilds the grid exactly once.
        this.state = { ...this.state, mode, layout: 'single' };
        this.handlers.onStateChange({ mode, layout: 'single' });
        this.handlers.onLayoutChange('single');
      });
    }

    root.getElementById('close')?.addEventListener('click', () => this.handlers.onClose());
    root.getElementById('perf')?.addEventListener('click', () => this.handlers.onToggleLock());

    const bind = (
      id: string,
      ev: string,
      fn: (el: HTMLSelectElement | HTMLInputElement) => void,
    ): void => {
      const el = root.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
      el?.addEventListener(ev, () => {
        // Ignore events caused by writing the value ourselves.
        if (this.syncing || !el) return;
        fn(el);
      });
    };

    bind('layout', 'change', (el) => {
      this.handlers.onLayoutChange((el as HTMLSelectElement).value as Layout);
    });
    bind('units', 'change', (el) => {
      this.handlers.onStateChange({ units: (el as HTMLSelectElement).value as HudState['units'] });
    });
    bind('range', 'change', (el) => {
      this.handlers.onStateChange({
        rangeMode: (el as HTMLSelectElement).value as HudState['rangeMode'],
      });
    });
    bind('signal', 'change', (el) => {
      this.handlers.onStateChange({
        signalMode: (el as HTMLSelectElement).value as HudState['signalMode'],
      });
    });
    bind('coord', 'change', (el) => {
      this.handlers.onStateChange({ coord: (el as HTMLSelectElement).value as HudState['coord'] });
    });
    bind('gain', 'input', (el) => {
      this.handlers.onStateChange({ gain: Number((el as HTMLInputElement).value) });
    });
    bind('zoom', 'input', (el) => {
      this.handlers.onStateChange({ zoom: Number((el as HTMLInputElement).value) });
    });

    const header = root.querySelector('header') as HTMLElement;
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      const rect = this.host!.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!drag || !this.host) return;
      this.host.style.left = `${Math.max(0, drag.left + e.clientX - drag.x)}px`;
      this.host.style.right = 'auto';
      this.host.style.top = `${Math.max(0, drag.top + e.clientY - drag.y)}px`;
    });
    header.addEventListener('pointerup', () => {
      if (!drag || !this.host) return;
      const rect = this.host.getBoundingClientRect();
      drag = null;
      this.handlers.onStateChange({
        hostPosition: { left: Math.round(rect.left), top: Math.round(rect.top), right: 16 },
      });
    });

    this.syncModeButtons();
  }

  /** True while inputs are being written from state, so handlers ignore echoes. */
  private syncing = false;

  private syncInputs(): void {
    const root = this.root;
    if (!root) return;
    this.syncing = true;
    const set = (id: string, value: string): void => {
      const el = root.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
      if (el) el.value = value;
    };
    set('layout', this.state.layout);
    set('units', this.state.units);
    set('range', this.state.rangeMode);
    set('signal', this.state.signalMode);
    set('coord', this.state.coord);
    set('gain', String(this.state.gain));
    set('zoom', String(this.state.zoom));
    // Release on the next task: assigning a <select> value can emit `change`
    // asynchronously in some engines.
    setTimeout(() => {
      this.syncing = false;
    }, 0);
  }
}
