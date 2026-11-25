import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * Guards the class of bug where the panel mounts and renders but is invisible.
 *
 * The first version set `position: fixed` with no `top`/`right`, relying on
 * applyPosition() to add them. That method early-returns while `this.host` is
 * still null, so the insets were never applied. A fixed element without insets
 * resolves to its static position — the end of documentElement — which on a
 * tall page (YouTube, any long article) is several screens below the viewport.
 * DOM presence and pixel measurements both looked fine; only a real page showed
 * the problem.
 */
const BUNDLE = resolve(__dirname, '../dist/content.js');
const HOST_ID = 'video-scopes-host';

describe('HUD placement', () => {
  let dom: JSDOM;
  let win: Window & typeof globalThis;

  beforeAll(async () => {
    const code = existsSync(BUNDLE) ? readFileSync(BUNDLE, 'utf8') : '';
    expect(code.length, 'run `pnpm build` first').toBeGreaterThan(0);

    // A tall page, like the ones where this bug bites.
    dom = new JSDOM(
      '<!doctype html><html><body><div style="height:8000px"></div></body></html>',
      { runScripts: 'outside-only', url: 'https://example.test/', pretendToBeVisual: true },
    );
    win = dom.window as unknown as Window & typeof globalThis;

    // Seed the session opt-in: the panel no longer auto-opens.
    const store: Record<string, unknown> = { 's:scopesOn': true };
    const listeners: Array<(m: unknown) => void> = [];
    (win as unknown as { chrome: unknown }).chrome = {
      runtime: { onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn) } },
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (o: Record<string, unknown>) => Object.assign(store, o),
        },
        // Startup reads storage.session to decide whether the panel is opted in.
        session: {
          get: async (k: string) => ({ [k]: store['s:' + k] }),
          set: async (o: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(o)) store['s:' + k] = v;
          },
        },
      },
    };
    win.eval(code);
  });

  const host = (): HTMLElement | null => win.document.getElementById(HOST_ID);

  it('mounts when the session opt-in is set', async () => {
    for (let i = 0; i < 40 && !host(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(host()).not.toBeNull();
  });

  it('anchors to the viewport with explicit insets', () => {
    const h = host()!;
    // Without an offset a fixed element falls back to its static position.
    expect(h.style.top).not.toBe('');
    const hasHorizontalAnchor = h.style.right !== '' || h.style.left !== '';
    expect(hasHorizontalAnchor, 'needs left or right').toBe(true);
  });

  it('is positioned and layered above page content', () => {
    const h = host()!;
    expect(h.style.position).toBe('fixed');
    expect(Number(h.style.zIndex)).toBeGreaterThan(1000);
  });

  it('keeps a non-zero offset from the top of the viewport', () => {
    const top = parseFloat(host()!.style.top || 'NaN');
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top).toBeLessThan(400);
  });

  it('does not rely on the element being scrolled into view', () => {
    // A fixed element anchored to the viewport is visible at scrollY = 0.
    // This asserts the anchor exists at all, which is what the bug broke.
    win.scrollTo(0, 0);
    const h = host()!;
    expect(h.style.top || h.style.bottom).not.toBe('');
  });
});
