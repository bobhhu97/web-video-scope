import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

/**
 * The panel is opt-in.
 *
 * It allocates GPU textures, runs a compute pipeline and overlays the page, so
 * it must never start on its own. The content script is injected (it has to be,
 * to receive the toolbar click) but must do nothing costly until asked.
 *
 * `chrome.storage.session` carries the opt-in across tabs within one browser
 * session, and is cleared when the browser closes — so an idle browser never has
 * scope work running anywhere.
 */
const BUNDLE = resolve(__dirname, '../dist/content.js');
const HOST_ID = 'video-scopes-host';

interface Env {
  win: Window & typeof globalThis;
  store: Record<string, unknown>;
  listeners: Array<(m: unknown) => void>;
  /** Number of canvas contexts created — a proxy for GPU work starting. */
  canvasContexts: () => number;
}

function makeEnv(sessionFlags: Record<string, unknown> = {}): Env {
  const dom = new JSDOM('<!doctype html><html><body><video></video></body></html>', {
    runScripts: 'outside-only',
    url: 'https://example.test/',
    pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;

  let contexts = 0;
  const origGetContext = win.HTMLCanvasElement.prototype.getContext;
  win.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    contexts += 1;
    return (origGetContext as (...a: unknown[]) => unknown).apply(this, args) as never;
  } as typeof origGetContext;

  const store: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sessionFlags)) store['s:' + k] = v;

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
  return { win, store, listeners, canvasContexts: () => contexts };
}

async function boot(env: Env, waitMs = 400): Promise<void> {
  env.win.eval(readFileSync(BUNDLE, 'utf8'));
  await new Promise((r) => setTimeout(r, waitMs));
}

const host = (win: Window & typeof globalThis): HTMLElement | null =>
  win.document.getElementById(HOST_ID);

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end && !fn()) await new Promise((r) => setTimeout(r, 50));
}

describe('opt-in startup', () => {
  it('does not mount anything on a cold start', async () => {
    const env = makeEnv();
    await boot(env);
    expect(host(env.win), 'must stay off until asked').toBeNull();
  });

  it('does no GPU work on a cold start', async () => {
    const env = makeEnv();
    await boot(env);
    expect(env.canvasContexts(), 'no canvas means no GPU pipeline').toBe(0);
  });

  it('still registers the message listener so the toolbar click can reach it', async () => {
    const env = makeEnv();
    await boot(env);
    expect(env.listeners.length).toBeGreaterThan(0);
  });

  it('mounts when the toolbar click asks for it', async () => {
    const env = makeEnv();
    await boot(env);
    for (const fn of env.listeners) fn({ type: 'show-scopes' });
    await waitFor(() => host(env.win) !== null);
    expect(host(env.win)).not.toBeNull();
  });

  it('records the opt-in for the rest of the session', async () => {
    const env = makeEnv();
    await boot(env);
    for (const fn of env.listeners) fn({ type: 'show-scopes' });
    await waitFor(() => host(env.win) !== null);
    expect(env.store['s:scopesOn']).toBe(true);
  });

  it('restores within the same session when that flag is set', async () => {
    const env = makeEnv({ scopesOn: true });
    await boot(env);
    await waitFor(() => host(env.win) !== null);
    expect(host(env.win), 'a new tab in the same session keeps working').not.toBeNull();
  });

  it('clears the flag when the user closes the panel', async () => {
    const env = makeEnv({ scopesOn: true });
    await boot(env);
    await waitFor(() => host(env.win) !== null);
    env.win.dispatchEvent(new env.win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await waitFor(() => host(env.win) === null);
    expect(env.store['s:scopesOn']).toBe(false);
  });

  it('does not start on the next page load after a close', async () => {
    const env = makeEnv();
    await boot(env);
    for (const fn of env.listeners) fn({ type: 'show-scopes' });
    await waitFor(() => host(env.win) !== null);
    env.win.dispatchEvent(new env.win.KeyboardEvent('keydown', { altKey: true, code: 'KeyS' }));
    await waitFor(() => host(env.win) === null);

    // A new document against the same storage: must stay off.
    const next = makeEnv({ scopesOn: env.store['s:scopesOn'] });
    await boot(next);
    expect(host(next.win), 'an explicit close must persist for the session').toBeNull();
  });
});
