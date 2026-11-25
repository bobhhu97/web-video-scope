/**
 * Loads the real built content script into a jsdom page and exercises the
 * toggle behaviour. This is the closest automated equivalent to "install the
 * unpacked extension and press Alt+S", which no headless browser tool can do
 * for MV3 unpacked builds.
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
    });
    win = dom.window as unknown as Window & typeof globalThis;

    const listeners: Array<(m: unknown) => void> = [];
    (win as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn) },
      },
    };
    (win as unknown as { __listeners: typeof listeners }).__listeners = listeners;

    win.eval(code);
  });

  const host = (): Element | null => win.document.getElementById(HOST_ID);

  it('registers a runtime message listener', () => {
    const listeners = (win as unknown as { __listeners: unknown[] }).__listeners;
    expect(listeners.length).toBeGreaterThan(0);
  });

  it('does not inject anything on load', () => {
    expect(host()).toBeNull();
  });

  it('injects a fixed host on Alt+S', () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    const h = host();
    expect(h).not.toBeNull();
    expect((h as HTMLElement).style.position).toBe('fixed');
    expect((h as HTMLElement).style.zIndex).toBe('2147483646');
    expect(h!.textContent).toBe('Video Scopes ready');
  });

  it('removes the host on a second Alt+S', () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    expect(host()).toBeNull();
  });

  it('ignores a plain S keypress', () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code: 'KeyS' }));
    expect(host()).toBeNull();
  });

  it('responds to the toggle-scopes runtime message', () => {
    const listeners = (win as unknown as { __listeners: Array<(m: unknown) => void> }).__listeners;
    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    expect(host()).not.toBeNull();
    for (const fn of listeners) fn({ type: 'toggle-scopes' });
    expect(host()).toBeNull();
  });
});
