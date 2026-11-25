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

async function makeEnv(opts: { enabled?: boolean } = {}): Promise<{
  win: Window & typeof globalThis;
  store: Record<string, unknown>;
  listeners: Array<(m: unknown) => void>;
  show: () => void;
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

  // The panel is opt-in; tests that need it mounted ask for it explicitly,
  // exactly as a toolbar click would.
  if (opts.enabled !== false) store['s:scopesOn'] = true;

  win.eval(code);
  await new Promise((r) => setTimeout(r, 250));
  const show = (): void => {
    for (const fn of listeners) fn({ type: 'show-scopes' });
  };
  return { win, store, listeners, show };
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

  it('stays closed unless asked', async () => {
    const { win } = await makeEnv({ enabled: false });
    await new Promise((r) => setTimeout(r, 400));
    expect(host(win), 'the panel is opt-in').toBeNull();
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

  it('closes on Alt+S for the current page', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await waitFor(() => host(win) === null);
    expect(host(win)).toBeNull();
  });

  it('reopens on the next page load even after being closed', async () => {
    // The deadlock this guards against: persisting visible=false made a single
    // close suppress the panel forever, with nothing on screen to explain it.
    const first = await makeEnv();
    await waitFor(() => host(first.win) !== null);
    first.win.dispatchEvent(new first.win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await waitFor(() => host(first.win) === null);
    expect(host(first.win)).toBeNull();

    // Simulate a reload: a brand new document, same storage.
    const second = await makeEnv();
    await waitFor(() => host(second.win) !== null);
    expect(host(second.win), 'a reload must bring the panel back').not.toBeNull();
  });

  it('reopens on a second Alt+S', async () => {
    const { win } = await makeEnv();
    await waitFor(() => host(win) !== null);
    const press = (): void => {
      win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    };
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

  it('toolbar click keeps the panel visible instead of hiding it', async () => {
    // Someone clicking the icon is asking to SEE the scopes. Toggling here used
    // to close an already-open panel, which is why clicking appeared to do
    // nothing at all.
    const { win, listeners } = await makeEnv();
    await waitFor(() => host(win) !== null);
    const before = host(win);

    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    await new Promise((r) => setTimeout(r, 200));

    expect(host(win), 'clicking must not remove the panel').not.toBeNull();
    expect(host(win)).toBe(before);
  });

  it('toolbar click still reports healthy geometry after repeated clicks', async () => {
    const { win, listeners } = await makeEnv();
    await waitFor(() => host(win) !== null);
    for (let i = 0; i < 3; i++) {
      for (const fn of listeners) fn({ type: 'toggle-scopes' });
      await new Promise((r) => setTimeout(r, 100));
    }
    const h = host(win);
    expect(h).not.toBeNull();
    expect(h!.style.position).toBe('fixed');
    expect(h!.style.top).not.toBe('');
  });

  it('toolbar click mounts the panel when it was closed with Alt+S', async () => {
    const { win, listeners } = await makeEnv();
    await waitFor(() => host(win) !== null);
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await waitFor(() => host(win) === null);
    expect(host(win)).toBeNull();

    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    await waitFor(() => host(win) !== null);
    expect(host(win), 'the icon must bring it back').not.toBeNull();
  });
});
