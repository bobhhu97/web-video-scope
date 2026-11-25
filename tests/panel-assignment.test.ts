import { describe, expect, it } from 'vitest';
import {
  LAYOUT_SLOTS,
  assignSlot,
  panelsForLayout,
  resolvePanels,
  type Layout,
} from '../src/ui/settings';
import type { ScopeMode } from '../src/gpu/scope-renderer';

const ALL: ScopeMode[] = ['waveform-luma', 'waveform-rgb', 'waveform-parade', 'vectorscope', 'cie'];

describe('LAYOUT_SLOTS', () => {
  it('matches what panelsForLayout returns for every layout', () => {
    for (const layout of Object.keys(LAYOUT_SLOTS) as Layout[]) {
      expect(panelsForLayout(layout, 'waveform-luma')).toHaveLength(LAYOUT_SLOTS[layout]);
    }
  });
});

describe('panelsForLayout', () => {
  it('gives four distinct scopes in the four-up view', () => {
    const p = panelsForLayout('grid', 'cie');
    expect(p).toHaveLength(4);
    expect(new Set(p).size).toBe(4);
  });

  it('gives three distinct scopes in the three-up view', () => {
    const p = panelsForLayout('triple', 'cie');
    expect(new Set(p).size).toBe(p.length);
  });

  it('never repeats a scope in a multi-panel layout', () => {
    // A repeated scope would make two cells share one renderer, which the
    // controller keys by mode — one of the cells would render nothing.
    for (const layout of ['pair', 'triple', 'grid'] as const) {
      for (const picked of ALL) {
        const p = panelsForLayout(layout, picked);
        expect(new Set(p).size).toBe(p.length);
      }
    }
  });
});

describe('resolvePanels', () => {
  it('falls back to the default when there is no override', () => {
    expect(resolvePanels('grid', 'cie', undefined)).toEqual(panelsForLayout('grid', 'cie'));
    expect(resolvePanels('grid', 'cie', {})).toEqual(panelsForLayout('grid', 'cie'));
  });

  it('uses the override when it has the right number of slots', () => {
    const custom: ScopeMode[] = ['cie', 'vectorscope', 'waveform-luma', 'waveform-rgb'];
    expect(resolvePanels('grid', 'cie', { grid: custom })).toEqual(custom);
  });

  it('ignores an override of the wrong length', () => {
    // A stored override can outlive a change to the slot counts; trusting it
    // would build the wrong number of cells.
    expect(resolvePanels('grid', 'cie', { grid: ['cie', 'vectorscope'] })).toEqual(
      panelsForLayout('grid', 'cie'),
    );
  });

  it('keeps overrides independent per layout', () => {
    const custom: ScopeMode[] = ['cie', 'vectorscope'];
    const got = resolvePanels('pair', 'waveform-luma', { triple: ['cie', 'cie', 'cie'], pair: custom });
    expect(got).toEqual(custom);
  });

  it('does not hand out its own stored array', () => {
    const stored: ScopeMode[] = ['cie', 'vectorscope'];
    const got = resolvePanels('pair', 'cie', { pair: stored });
    got[0] = 'waveform-luma';
    expect(stored[0]).toBe('cie');
  });
});

describe('assignSlot', () => {
  it('assigns into a free slot without disturbing the others', () => {
    const before: ScopeMode[] = ['waveform-luma', 'vectorscope'];
    const after = assignSlot(before, 0, 'cie');
    expect(after).toEqual(['cie', 'vectorscope']);
    expect(before).toEqual(['waveform-luma', 'vectorscope']);
  });

  it('swaps when the requested scope is already in another slot', () => {
    // Duplicating would give two cells the same mode and one renderer between
    // them, so the displaced scope takes the old slot instead.
    const after = assignSlot(['waveform-luma', 'vectorscope', 'cie'], 0, 'cie');
    expect(after).toEqual(['cie', 'vectorscope', 'waveform-luma']);
    expect(new Set(after).size).toBe(3);
  });

  it('is a no-op when the slot already has that scope', () => {
    const before: ScopeMode[] = ['waveform-luma', 'vectorscope'];
    expect(assignSlot(before, 1, 'vectorscope')).toEqual(before);
  });

  it('always keeps every slot distinct', () => {
    let panels: ScopeMode[] = ['waveform-luma', 'waveform-rgb', 'waveform-parade', 'vectorscope'];
    for (const mode of ALL) {
      for (let slot = 0; slot < panels.length; slot++) {
        const next = assignSlot(panels, slot, mode);
        expect(new Set(next).size).toBe(next.length);
        expect(next[slot]).toBe(mode);
        panels = next;
      }
    }
  });
});
