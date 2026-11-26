import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const MANIFEST_PATH = resolve(__dirname, '../manifest.json');
const BUNDLE_PATH = resolve(__dirname, '../dist/content.js');

describe('On-demand injection & zero page/title pollution', () => {
  it('declares no automatic content_scripts and no broad <all_urls> host_permissions in manifest.json', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    expect(manifest.content_scripts ?? []).toHaveLength(0);
    expect(manifest.host_permissions ?? []).toHaveLength(0);
    expect(manifest.permissions).toContain('activeTab');
    expect(manifest.permissions).toContain('scripting');
  });

  it('never appends [VS:idle] or any [VS:*] suffix to document.title in idle, active, or closed states', async () => {
    const dom = new JSDOM('<!doctype html><html><head><title>哔哩哔哩 (゜-゜)つロ 干杯~-bilibili</title></head><body><video></video></body></html>', {
      runScripts: 'outside-only',
      url: 'https://www.bilibili.com/video/BV1pZynzFEC3',
      pretendToBeVisual: true,
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    const originalTitle = win.document.title;

    const store: Record<string, unknown> = {};
    const listeners: Array<(m: unknown) => void> = [];
    (win as unknown as { chrome: unknown }).chrome = {
      runtime: { onMessage: { addListener: (fn: (m: unknown) => void) => listeners.push(fn) } },
      storage: {
        local: {
          get: async (k: string) => ({ [k]: store[k] }),
          set: async (o: Record<string, unknown>) => Object.assign(store, o),
        },
        session: {
          get: async (k: string) => ({ [k]: store['s:' + k] }),
          set: async (o: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(o)) store['s:' + k] = v;
          },
        },
      },
    };

    // 1. Cold start: title must stay 100% untouched (no [VS:idle])
    win.eval(readFileSync(BUNDLE_PATH, 'utf8'));
    await new Promise((r) => setTimeout(r, 300));
    expect(win.document.title).toBe(originalTitle);
    expect(win.document.title).not.toContain('[VS:');

    // 2. User clicks extension icon (show-scopes): title must STILL stay 100% untouched
    for (const fn of listeners) fn({ type: 'show-scopes' });
    await new Promise((r) => setTimeout(r, 350));
    expect(win.document.title).toBe(originalTitle);
    expect(win.document.title).not.toContain('[VS:');

    // 3. User closes scopes (Alt+S): title must STILL stay 100% untouched
    win.dispatchEvent(new win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await new Promise((r) => setTimeout(r, 250));
    expect(win.document.title).toBe(originalTitle);
  });
});
