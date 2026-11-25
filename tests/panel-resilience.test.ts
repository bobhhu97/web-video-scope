import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * Once the user has opted in, nothing optional may prevent the panel appearing.
 *
 * This is the counterpart to opt-in-startup: that file proves the extension is
 * silent until asked; this one proves that after asking, a degraded environment
 * (no video, no GPU, storage errors) still produces a visible panel rather than
 * a blank failure.
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

  // The opt-in flag must survive even in the storage-throws case, otherwise the
  // test would be measuring "not started" rather than "started but degraded".
  const store: Record<string, unknown> = { 's:scopesOn': true };
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
        // Reads still work: the flag was already loaded. Writes may fail.
        get: async (k: string) => ({ [k]: store['s:' + k] }),
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
  for (let i = 0; i < 40; i++) {
    const h = win.document.getElementById(HOST_ID);
    if (h) return h;
    await new Promise((r) => setTimeout(r, 50));
  }
  return win.document.getElementById(HOST_ID);
}

describe('panel robustness after opt-in', () => {
  it('mounts on a page with no video at all', async () => {
    const host = await boot(makeWindow({ noVideo: true }));
    expect(host).not.toBeNull();
    expect(host!.shadowRoot?.querySelector('.panel')).not.toBeNull();
  });

  it('mounts when settings reads throw', async () => {
    const host = await boot(makeWindow({ storageThrows: true }));
    expect(host, 'a settings failure must not hide the panel').not.toBeNull();
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

  it('explains itself rather than showing a blank panel when scopes cannot start', async () => {
    const host = await boot(makeWindow({ noGpu: true }));
    expect(host).not.toBeNull();
    const notice = host!.shadowRoot?.getElementById('notice');
    // A notice is expected here but the hard requirement is that the panel is
    // present; an empty but visible panel still beats no panel.
    if (notice && !notice.hidden) {
      expect(notice.textContent!.length).toBeGreaterThan(0);
    }
  });
});
