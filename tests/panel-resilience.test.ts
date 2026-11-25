import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The panel must appear even when everything optional fails.
 *
 * This encodes the lesson from the YouTube debugging session: a user cannot
 * distinguish "GPU init threw" from "extension is broken", and they should never
 * have to. The HUD is mounted before any storage read, GPU setup or video
 * detection, so a failure in those leaves a visible panel with a notice.
 */
const BUNDLE = resolve(__dirname, '../dist/content.js');
const HOST_ID = 'video-scopes-host';

interface Opts {
  storageThrows?: boolean;
  noGpu?: boolean;
  noVideo?: boolean;
}

function makeWindow(opts: Opts): Window & typeof globalThis {
  const html = opts.noVideo
    ? '<!doctype html><html><body></body></html>'
    : '<!doctype html><html><body><video></video></body></html>';
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://example.test/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;

  if (opts.noGpu) {
    Object.defineProperty(win.navigator, 'gpu', { value: undefined, configurable: true });
  }

  const store: Record<string, unknown> = {};
  const boom = (): never => {
    throw new Error('storage unavailable');
  };
  (win as unknown as { chrome: unknown }).chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: {
      local: {
        get: async (k: string) => (opts.storageThrows ? boom() : { [k]: store[k] }),
        set: async (o: Record<string, unknown>) => {
          if (opts.storageThrows) boom();
          Object.assign(store, o);
        },
      },
      session: {
        get: async (k: string) => (opts.storageThrows ? boom() : { [k]: store['s:' + k] }),
        set: async (o: Record<string, unknown>) => {
          if (opts.storageThrows) boom();
          for (const [k, v] of Object.entries(o)) store['s:' + k] = v;
        },
      },
    },
  };
  return win;
}

async function boot(win: Window & typeof globalThis): Promise<HTMLElement | null> {
  win.eval(readFileSync(BUNDLE, 'utf8'));
  await new Promise((r) => setTimeout(r, 250));
  return win.document.getElementById(HOST_ID);
}

describe('panel robustness', () => {
  it('mounts on a page with no video at all', async () => {
    const host = await boot(makeWindow({ noVideo: true }));
    expect(host).not.toBeNull();
    expect(host!.shadowRoot?.querySelector('.panel')).not.toBeNull();
  });

  it('mounts when chrome.storage throws', async () => {
    const host = await boot(makeWindow({ storageThrows: true }));
    expect(host, 'a storage failure must not hide the panel').not.toBeNull();
    expect(host!.shadowRoot?.querySelector('.panel')).not.toBeNull();
  });

  it('mounts when WebGPU is unavailable', async () => {
    const host = await boot(makeWindow({ noGpu: true }));
    expect(host, 'a GPU failure must not hide the panel').not.toBeNull();
    expect(host!.shadowRoot?.querySelector('.panel')).not.toBeNull();
  });

  it('positions the host in the viewport in every degraded case', async () => {
    for (const opts of [{ noVideo: true }, { storageThrows: true }, { noGpu: true }]) {
      const host = await boot(makeWindow(opts));
      expect(host).not.toBeNull();
      expect(host!.style.position).toBe('fixed');
      expect(host!.style.top).not.toBe('');
    }
  });

  it('opens automatically so a fresh install is discoverable', async () => {
    const host = await boot(makeWindow({}));
    expect(host).not.toBeNull();
  });
});
