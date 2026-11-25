import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOVERNOR,
  TIER_DESCRIPTION,
  initialGovernorState,
  stepGovernor,
  stepGovernorHard,
  type GovernorState,
} from '../src/core/perf-governor';

const cfg = { ...DEFAULT_GOVERNOR, settleFrames: 0 };

function run(n: number, gpuMs: number, from: GovernorState, c = cfg): GovernorState {
  let s = from;
  for (let i = 0; i < n; i++) s = stepGovernor(s, gpuMs, c);
  return s;
}

describe('stepGovernor', () => {
  it('steps down after enough consecutive over-budget frames', () => {
    expect(run(20, 10, initialGovernorState()).tier).toBe(2);
  });

  it('does not step down on a short burst', () => {
    expect(run(5, 10, initialGovernorState()).tier).toBe(1);
  });

  it('resets the over counter when a good frame arrives', () => {
    let s = run(10, 10, initialGovernorState());
    s = stepGovernor(s, 1, cfg);
    s = run(10, 10, s);
    expect(s.tier).toBe(1);
  });

  it('steps up only after a long stable period', () => {
    expect(run(60, 1, initialGovernorState()).tier).toBe(0);
  });

  it('never goes below tier 0 or above tier 4', () => {
    expect(run(500, 0.1, { ...initialGovernorState(), tier: 0 }).tier).toBe(0);
    expect(run(500, 100, { ...initialGovernorState(), tier: 4 }).tier).toBe(4);
  });

  it('ignores null measurements', () => {
    const s = initialGovernorState();
    expect(stepGovernor(s, null, cfg)).toBe(s);
  });

  it('ignores frames right after a tier change (settle window)', () => {
    const c = { ...DEFAULT_GOVERNOR };
    let s: GovernorState = { tier: 1, over: 0, under: 0, settled: 0 };
    for (let i = 0; i < c.settleFrames; i++) s = stepGovernor(s, 50, c);
    expect(s.tier).toBe(1);
  });

  it('hard mode jumps two tiers on a catastrophic frame', () => {
    expect(stepGovernorHard(initialGovernorState(), 40).tier).toBe(3);
  });

  it('hard mode clamps at tier 4 and delegates normal frames', () => {
    expect(stepGovernorHard({ ...initialGovernorState(), tier: 3 }, 40).tier).toBe(4);
    expect(stepGovernorHard(initialGovernorState(), 1).tier).toBe(1);
  });
});

describe('TIER_DESCRIPTION', () => {
  it('every tier names a valid fps and preset', () => {
    for (const t of [0, 1, 2, 3, 4] as const) {
      expect(TIER_DESCRIPTION[t].fps).toBeGreaterThan(0);
      expect(['low', 'default', 'high']).toContain(TIER_DESCRIPTION[t].preset);
    }
  });

  it('tiers do not dictate layout', () => {
    // Layout is the user's choice; a governor tick must never change it.
    for (const t of [0, 1, 2, 3, 4] as const) {
      expect(TIER_DESCRIPTION[t]).not.toHaveProperty('layout');
    }
  });

  it('is monotonic: quality never increases as the tier number grows', () => {
    const order = { low: 0, default: 1, high: 2 } as const;
    for (let t = 1; t <= 4; t++) {
      expect(order[TIER_DESCRIPTION[t as 0].preset]).toBeLessThanOrEqual(
        order[TIER_DESCRIPTION[(t - 1) as 0].preset],
      );
      expect(TIER_DESCRIPTION[t as 0].fps).toBeLessThanOrEqual(TIER_DESCRIPTION[(t - 1) as 0].fps);
    }
  });
});
