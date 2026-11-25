import type { ColorSpaceInfo, RangeDiagnosis } from '../core/range-detector';
import type { QualityTier } from '../core/perf-governor';
import type { ScopeMode } from '../gpu/scope-renderer';
import { panelsForLayout, type HudState, type Layout } from './settings';

export interface PanelTargets {
  mode: ScopeMode;
  gpu: HTMLCanvasElement;
  grat: HTMLCanvasElement;
}

export interface HudHandlers {
  onStateChange(patch: Partial<HudState>): void;
  onLayoutChange(layout: Layout): void;
  onClose(): void;
  /** Detach the panel into a Document Picture-in-Picture window. */
  onOpenPip(): void;
  /** User clicked the quality badge: pin to the current tier, or unpin. */
  onToggleLock(): void;
}

const HOST_ID = 'video-scopes-host';

const STYLE = `
  :host { all: initial; }
  .panel {
    font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #b9c6d0; background: #0b0f12f2;
    border: 1px solid #ffffff1a; border-radius: 10px;
    box-shadow: 0 10px 30px #0009;
    overflow: hidden; resize: both;
    min-width: 300px; min-height: 170px;
    width: 760px;
  }
  header {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; background: #12181d; cursor: move;
    user-select: none; border-bottom: 1px solid #ffffff14;
  }
  header .title { color: #d7e3ec; font-weight: 500; letter-spacing: .02em; }
  header .spacer { flex: 1; }
  .badge {
    padding: 1px 6px; border-radius: 999px; background: #1c262d;
    color: #8ea3b0; white-space: nowrap;
  }
  .badge.warn { background: #3a2a12; color: #f0c070; }
  .badge.ok { background: #16291d; color: #8cd9a5; }
  .badge.locked { background: #16243a; color: #8ab4e8; }
  button {
    font: inherit; color: #cfe0ea; background: #16202a;
    border: 1px solid #ffffff20; border-radius: 5px;
    padding: 1px 6px; cursor: pointer;
  }
  button:hover { background: #1d2a36; }
  .grid { display: grid; gap: 3px; padding: 6px; }
  .grid.single { grid-template-columns: 1fr; }
  .grid.grid { grid-template-columns: 1fr 1fr; }
  .grid.triple { grid-template-columns: 1fr; }
  .cell {
    position: relative; background: #0d1117; border-radius: 5px;
    overflow: hidden; border: 1px solid #ffffff0f;
  }
  .cell canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .cell canvas.grat { pointer-events: none; }
  footer {
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    padding: 5px 8px; border-top: 1px solid #ffffff14; background: #0f1418;
  }
  footer label { display: inline-flex; align-items: center; gap: 3px; color: #8ea3b0; }
  select {
    font: inherit; color: #cfe0ea; background: #16202a;
    border: 1px solid #ffffff20; border-radius: 5px; padding: 1px 3px;
  }
  input[type=range] { width: 62px; accent-color: #4e7fa8; }
`;

export class Hud {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
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

  mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    // `all: initial` MUST come first: it resets every property, so writing it
    // after `position: fixed` silently drops the host back into normal flow.
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483646;';
    this.applyPosition();

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = this.template();

    this.host = host;
    this.root = root;
    document.documentElement.appendChild(host);

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

  /** Live GPU + graticule canvases for the currently visible panels. */
  panelCanvases(): PanelTargets[] {
    return Array.from(this.canvases.values());
  }

  setState(state: HudState): void {
    this.state = state;
    this.applyPosition();
    this.syncInputs();
  }

  relayout(layout: Layout): void {
    if (!this.root) return;
    this.state = { ...this.state, layout };
    const grid = this.root.querySelector('.grid') as HTMLElement | null;
    if (!grid) return;
    grid.className = `grid ${layout}`;
    this.buildCells();
  }

  setColorInfo(info: ColorSpaceInfo): void {
    const el = this.root?.getElementById('cs');
    if (!el) return;
    const range = info.fullRange === null ? 'range ?' : info.fullRange ? 'full' : 'limited';
    const parts = [
      (info.matrix ?? '?').toUpperCase(),
      range,
      info.transfer,
    ];
    if (info.format) parts.push(info.format);
    el.textContent = parts.join(' · ');
  }

  setDiagnosis(d: RangeDiagnosis): void {
    const status = this.root?.getElementById('status');
    const warn = this.root?.getElementById('warn');
    if (status) {
      status.textContent = `${d.effective} · ${d.source}`;
      status.className = `badge ${d.effective === 'full' ? 'ok' : ''}`;
    }
    if (warn) {
      if (d.warning) {
        warn.hidden = false;
        warn.textContent =
          d.warning === 'limited-treated-as-full'
            ? '⚠ limited read as full'
            : '⚠ full read as limited';
      } else {
        warn.hidden = true;
      }
    }
  }

  setPerf(fps: number, gpuMs: number | null, tier: QualityTier): void {
    const el = this.root?.getElementById('perf');
    if (!el) return;
    const locked = this.state.lockedTier !== null;
    const parts = [`${Math.round(fps)} fps`];
    if (gpuMs !== null) parts.push(`${gpuMs.toFixed(1)} ms`);
    parts.push(locked ? `lock:${tier}` : `auto:${tier}`);
    el.textContent = parts.join(' · ');
    el.className = `badge ${locked ? 'locked' : ''}`;
  }

  setProbe(text: string | null): void {
    const el = this.root?.getElementById('probe');
    if (!el) return;
    el.hidden = text === null;
    if (text !== null) el.textContent = text;
  }

  setNotice(text: string | null): void {
    const el = this.root?.getElementById('notice');
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
          <span class="title">Video Scopes</span>
          <span class="badge" id="status">detecting…</span>
          <span class="badge" id="cs">–</span>
          <span class="badge warn" id="warn" hidden></span>
          <span class="spacer"></span>
          <span class="badge" id="perf">–</span>
          <button id="pip" title="Open in a always-on-top window">⧉</button>
          <button id="close" title="Close (Alt+S)">✕</button>
        </header>
        <div class="badge warn" id="notice" hidden style="margin:6px 8px 0"></div>
        <div class="badge" id="probe" hidden style="margin:6px 8px 0"></div>
        <div class="grid ${this.state.layout}"></div>
        <footer>
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
          <label>layout
            <select id="layout">
              <option value="grid">2×2</option>
              <option value="triple">1×3</option>
              <option value="single">single</option>
            </select>
          </label>
          <label>cie
            <select id="coord">
              <option value="xy">1931 xy</option>
              <option value="uv">1976 u'v'</option>
            </select>
          </label>
          <label title="raw reads decoder YUV planes; exact code values for HDR">signal
            <select id="signal">
              <option value="display">display</option>
              <option value="raw">raw</option>
            </select>
          </label>
          <label>gain <input id="gain" type="range" min="0.2" max="3" step="0.1"></label>
          <label>zoom <input id="zoom" type="range" min="1" max="8" step="1"></label>
        </footer>
      </div>`;
  }

  private buildCells(): void {
    const root = this.root;
    if (!root) return;
    const grid = root.querySelector('.grid') as HTMLElement;
    const modes = panelsForLayout(this.state.layout, this.state.mode);

    grid.innerHTML = modes
      .map((m) => {
        const square = m === 'cie' || m === 'vectorscope';
        return `<div class="cell" data-mode="${m}" style="aspect-ratio:${square ? '1/1' : '2/1'}">
          <canvas class="gpu"></canvas><canvas class="grat"></canvas>
        </div>`;
      })
      .join('');

    this.canvases.clear();
    for (const cell of Array.from(grid.querySelectorAll<HTMLElement>('.cell'))) {
      const mode = cell.dataset.mode as ScopeMode;
      const gpu = cell.querySelector<HTMLCanvasElement>('canvas.gpu');
      const grat = cell.querySelector<HTMLCanvasElement>('canvas.grat');
      if (gpu && grat) this.canvases.set(mode, { mode, gpu, grat });
    }
  }

  private wire(): void {
    const root = this.root;
    if (!root) return;

    root.getElementById('close')?.addEventListener('click', () => this.handlers.onClose());

    root.getElementById('units')?.addEventListener('change', (e) => {
      this.handlers.onStateChange({ units: (e.target as HTMLSelectElement).value as HudState['units'] });
    });
    root.getElementById('range')?.addEventListener('change', (e) => {
      this.handlers.onStateChange({
        rangeMode: (e.target as HTMLSelectElement).value as HudState['rangeMode'],
      });
    });
    root.getElementById('layout')?.addEventListener('change', (e) => {
      this.handlers.onLayoutChange((e.target as HTMLSelectElement).value as Layout);
    });
    root.getElementById('coord')?.addEventListener('change', (e) => {
      this.handlers.onStateChange({ coord: (e.target as HTMLSelectElement).value as HudState['coord'] });
    });
    root.getElementById('signal')?.addEventListener('change', (e) => {
      this.handlers.onStateChange({
        signalMode: (e.target as HTMLSelectElement).value as HudState['signalMode'],
      });
    });
    root.getElementById('gain')?.addEventListener('input', (e) => {
      this.handlers.onStateChange({ gain: Number((e.target as HTMLInputElement).value) });
    });
    root.getElementById('zoom')?.addEventListener('input', (e) => {
      this.handlers.onStateChange({ zoom: Number((e.target as HTMLInputElement).value) });
    });
    root.getElementById('perf')?.addEventListener('click', () => this.handlers.onToggleLock());
    root.getElementById('pip')?.addEventListener('click', () => this.handlers.onOpenPip());

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
      const left = Math.max(0, drag.left + e.clientX - drag.x);
      const top = Math.max(0, drag.top + e.clientY - drag.y);
      this.host.style.left = `${left}px`;
      this.host.style.right = 'auto';
      this.host.style.top = `${top}px`;
    });
    header.addEventListener('pointerup', () => {
      if (!drag || !this.host) return;
      const rect = this.host.getBoundingClientRect();
      drag = null;
      this.handlers.onStateChange({
        hostPosition: { left: Math.round(rect.left), top: Math.round(rect.top), right: 16 },
      });
    });
  }

  private syncInputs(): void {
    const root = this.root;
    if (!root) return;
    const set = (id: string, value: string): void => {
      const el = root.getElementById(id) as HTMLSelectElement | HTMLInputElement | null;
      if (el) el.value = value;
    };
    set('units', this.state.units);
    set('range', this.state.rangeMode);
    set('layout', this.state.layout);
    set('coord', this.state.coord);
    set('signal', this.state.signalMode);
    set('gain', String(this.state.gain));
    set('zoom', String(this.state.zoom));
  }
}
