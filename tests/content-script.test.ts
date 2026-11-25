/**
 * Loads the real built content script into a jsdom page and exercises the HUD
 * lifecycle. This is the closest automated equivalent to "install the unpacked
 * extension and press Alt+S", which no headless browser tool can do for MV3
 * unpacked builds.
 *
 * The HUD now renders inside a shadow root, so assertions go through
 * `host.shadowRoot` rather than the host element's own textContent.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const BUNDLE = resolve(__dirname, '../dist/content.js');
const HOST_ID = 'video-scopes-host';

describe('built content script', () => {
  let dom: JSDOM;
  let win: Window & typeof globalThis;

  beforeAll(() => {
    const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, 'utf8') : '';
    expect(code.length, 'dist/content.js must exist — run `pnpm build` first').toBeGreaterThan(0);

    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'https://example.test/',
      pretendToBeVisual: true,
    });
    win = dom.window as unknown as Window & typeof globalThis;

    const store: Record<string, unknown> = {};
    const listeners: Array<(m: unknown) => void> = [];
    (win as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn) },
      },
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (o: Record<string, unknown>) => {
            Object.assign(store, o);
          },
        },
      },
    };
    (win as unknown as { __listeners: typeof listeners }).__listeners = listeners;
    (win as unknown as { __store: typeof store }).__store = store;

    win.eval(code);
  });

  const host = (): HTMLElement | null => win.document.getElementById(HOST_ID);
  const toggle = (): void => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
  };

  it('registers a runtime message listener', () => {
    const listeners = (win as unknown as { __listeners: unknown[] }).__listeners;
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('does not inject anything on load when the last session was closed', () => {
    expect(host()).toBeNull();
  });

  it('mounts a fixed host with a shadow root on Alt+S', async () => {
    toggle();
    // enable() awaits loadSettings() before mounting.
    await new Promise((r) => setTimeout(r, 30));
    const h = host();
    expect(h).not.toBeNull();
    expect(h!.style.position).toBe('fixed');
    expect(h!.style.zIndex).toBe('2147483646');
    expect(h!.shadowRoot).not.toBeNull();
  });

  it('renders the scope panel inside the shadow root', async () => {
    const h = host();
    await new Promise((r) => setTimeout(r, 60));
    const root = h?.shadowRoot;
    expect(root?.querySelector('.panel')).not.toBeNull();
    expect(root?.querySelector('.grid')).not.toBeNull();
    // Default layout is the 2x2 grid.
    expect(root?.querySelectorAll('.cell').length).toBe(4);
  });

  it('exposes the range and units controls', () => {
    const root = host()?.shadowRoot;
    expect(root?.getElementById('units')).not.toBeNull();
    expect(root?.getElementById('range')).not.toBeNull();
    expect(root?.getElementById('layout')).not.toBeNull();
  });

  it('persists visible=true once open', async () => {
    const store = (win as unknown as { __store: Record<string, unknown> }).__store;
    const state = store['video-scopes:state'] as { visible?: boolean } | undefined;
    expect(state?.visible).toBe(true);
  });

  it('unmounts on a second Alt+S and persists visible=false', async () => {
    toggle();
    await new Promise((r) => setTimeout(r, 60));
    expect(host()).toBeNull();
    const store = (win as unknown as { __store: Record<string, unknown> }).__store;
    const state = store['video-scopes:state'] as { visible?: boolean } | undefined;
    expect(state?.visible).toBe(false);
  });

  it('ignores a plain S keypress', async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'KeyS' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(host()).toBeNull();
  });

  it('responds to the toggle-scopes runtime message', async () => {
    const listeners = (win as unknown as { __listeners: Array<(m: unknown) => void> }).__listeners;
    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    await new Promise((r) => setTimeout(r, 60));
    expect(host()).not.toBeNull();
    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    await new Promise((r) => setTimeout(r, 60));
    expect(host()).toBeNull();
  });
});
