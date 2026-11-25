import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * End-to-end behaviour of the built content script in a DOM.
 *
 * Contract under test:
 *  - a first run mounts the panel on its own, so a fresh install is discoverable
 *  - Alt+S / the toolbar message toggle it open and closed
 *  - the choice is persisted, and an explicit close survives a reload
 *
 * Note the earlier version of this file asserted "nothing happens on load".
 * That was the old behaviour and it is exactly what made the extension look
 * broken to a user who had closed the panel once.
 */
const BUNDLE = resolve(__dirname, '../dist/content.js');
const HOST_ID = 'video-scopes-host';

async function makeEnv(): Promise<{
  win: Window & typeof globalThis;
  store: Record<string, unknown>;
  listeners: Array<(m: unknown) => void>;
}> {
  const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, 'utf8') : '';
  expect(code.length, 'run `pnpm build` first').toBeGreaterThan(0);

  const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', {
    runScripts: 'outside-only',
    url: 'https://example.test/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;

  const store: Record<string, unknown> = {};
  const listeners: Array<(m: unknown) => void> = [];
  (win as unknown as { chrome: unknown }).chrome = {
    runtime: { onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn) } },
    storage: {
      local: { get: async (k: string) => ({ [k]: store[k] }), set: async (o: Record<string, unknown>) => Object.assign(store, o) },
      session: {
        get: async (k: string) => ({ [k]: store['s:' + k] }),
        set: async (o: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(o)) store['s:' + k] = v;
        },
      },
    },
  };

  win.eval(code);
  await new Promise((r) => setTimeout(r, 250));
  return { win, store, listeners };
}

const host = (win: Window & typeof globalThis): HTMLElement | null =>
  win.document.getElementById(HOST_ID);

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 50));
}

describe('built content script', () => {
  it('registers a runtime message listener', async () => {
    const { listeners } = await makeEnv();
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('opens by itself on a first run', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    expect(host(win)).not.toBeNull();
  });

  it('mounts a fixed host with a shadow root and the panel', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    const h = host(win)!;
    expect(h.style.position).toBe('fixed');
    expect(h.style.zIndex).toBe('2147483646');
    expect(h.shadowRoot).not.toBeNull();
    expect(h.shadowRoot!.querySelector('.panel')).not.toBeNull();
  });

  it('renders four panels in the default 2x2 layout', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win)?.shadowRoot?.querySelectorAll('.cell').length === 4);
    expect(host(win)!.shadowRoot!.querySelectorAll('.cell').length).toBe(4);
  });

  it('exposes the units, range and layout controls', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    const root = host(win)!.shadowRoot!;
    expect(root.getElementById('units')).not.toBeNull();
    expect(root.getElementById('range')).not.toBeNull();
    expect(root.getElementById('layout')).not.toBeNull();
  });

  it('closes on Alt+S and persists visible=false', async () => {
    const { win, store } = await makeEnv();
    await waitFor(() => host(win) !== null);
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await waitFor(() => host(win) === null);
    expect(host(win)).toBeNull();
    const saved = store['video-scopes:state'] as { visible?: boolean } | undefined;
    expect(saved?.visible).toBe(false);
  });

  it('reopens on a second Alt+S', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    const press = (): void =>
      win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    press();
    await waitFor(() => host(win) === null);
    press();
    await waitFor(() => host(win) !== null);
    expect(host(win)).not.toBeNull();
  });

  it('ignores a plain S keypress', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    const before = host(win);
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'KeyS' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(host(win)).toBe(before);
  });

  it('responds to the toggle-scopes message used by the toolbar button', async () => {
    const { win, listeners } = await makeEnv();
    await waitFor(() => host(win) !== null);
    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    await waitFor(() => host(win) === null);
    expect(host(win)).toBeNull();
    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    await waitFor(() => host(win) !== null);
    expect(host(win)).not.toBeNull();
  });
});
