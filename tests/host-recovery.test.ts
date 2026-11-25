import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The host must survive a page that rebuilds its DOM after load.
 *
 * YouTube hydrates its shell after the content script has run (document_start),
 * replacing documentElement's children wholesale. The panel mounts, reports
 * itself mounted, and is then removed as collateral — it looked to the user like
 * the extension did nothing, while every signal said it had loaded.
 */
const BUNDLE = resolve(__dirname, '../dist/content.js');
const HOST_ID = 'video-scopes-host';

function makeWindow(): Window & typeof globalThis {
  const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', {
    runScripts: 'outside-only',
    url: 'https://example.test/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const store: Record<string, unknown> = {};
  (win as unknown as { chrome: unknown }).chrome = {
    runtime: { onMessage: { addListener() {} } },
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
  return win;
}

async function boot(win: Window & typeof globalThis): Promise<void> {
  win.eval(readFileSync(BUNDLE, 'utf8'));
  for (let i = 0; i < 60; i++) {
    if (win.document.getElementById(HOST_ID)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const settle = (ms = 200): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('host survives DOM rebuilds', () => {
  it('mounts initially', async () => {
    const win = makeWindow();
    await boot(win);
    expect(win.document.getElementById(HOST_ID)).not.toBeNull();
  });

  it('re-attaches after the host is removed directly', async () => {
    const win = makeWindow();
    await boot(win);
    const host = win.document.getElementById(HOST_ID)!;
    host.remove();
    expect(win.document.getElementById(HOST_ID)).toBeNull();

    await settle(250);
    expect(win.document.getElementById(HOST_ID)).not.toBeNull();
  });

  it('re-attaches after the whole documentElement children set is replaced', async () => {
    const win = makeWindow();
    await boot(win);

    // This is what a framework hydration looks like: everything under
    // documentElement is swapped out in one go.
    const root = win.document.documentElement;
    while (root.firstChild) root.removeChild(root.firstChild);
    const fresh = win.document.createElement('body');
    fresh.innerHTML = '<div id="app">rebuilt</div><video></video>';
    root.appendChild(fresh);

    expect(win.document.getElementById(HOST_ID)).toBeNull();
    await settle(300);
    expect(win.document.getElementById(HOST_ID), 'host must come back').not.toBeNull();
  });

  it('does not duplicate the host when re-attaching repeatedly', async () => {
    const win = makeWindow();
    await boot(win);
    for (let i = 0; i < 3; i++) {
      win.document.getElementById(HOST_ID)?.remove();
      await settle(150);
    }
    await settle(200);
    expect(win.document.querySelectorAll('#' + HOST_ID).length).toBe(1);
  });

  it('keeps the panel and its shadow root intact across a re-attach', async () => {
    const win = makeWindow();
    await boot(win);
    const host = win.document.getElementById(HOST_ID)!;
    const panelBefore = host.shadowRoot?.querySelector('.panel');
    expect(panelBefore).toBeTruthy();

    host.remove();
    await settle(250);

    const again = win.document.getElementById(HOST_ID)!;
    expect(again.shadowRoot?.querySelector('.panel')).not.toBeNull();
  });
});
