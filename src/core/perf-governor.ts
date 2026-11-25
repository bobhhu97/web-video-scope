/**
 * Pure decisions for the performance governor, kept separate from the GPU so
 * they can be unit tested in node.
 */

export type QualityTier = 0 | 1 | 2 | 3 | 4;

export interface GovernorConfig {
  /** Per-frame GPU budget in milliseconds. */
  budgetMs: number;
  /** Consecutive over-budget frames required before stepping down. */
  downAfter: number;
  /** Consecutive under-budget frames required before stepping up. */
  upAfter: number;
  /** Frames ignored right after a tier change (pipeline rebuild spikes). */
  settleFrames: number;
}

export interface GovernorState {
  tier: QualityTier;
  over: number;
  under: number;
  settled: number;
}

export const DEFAULT_GOVERNOR: GovernorConfig = {
  budgetMs: 4,
  downAfter: 20,
  upAfter: 60,
  settleFrames: 8,
};

export const TIER_DESCRIPTION: Record<
  QualityTier,
  { fps: number; preset: 'low' | 'default' | 'high'; layout: 'grid' | 'triple' | 'single' }
> = {
  0: { fps: 60, preset: 'high', layout: 'grid' },
  1: { fps: 30, preset: 'high', layout: 'grid' },
  2: { fps: 30, preset: 'default', layout: 'grid' },
  3: { fps: 20, preset: 'default', layout: 'triple' },
  4: { fps: 15, preset: 'low', layout: 'single' },
};

export function initialGovernorState(): GovernorState {
  return { tier: 1, over: 0, under: 0, settled: 0 };
}

export function stepGovernor(
  state: GovernorState,
  gpuMs: number | null,
  cfg: GovernorConfig = DEFAULT_GOVERNOR,
): GovernorState {
  if (gpuMs === null) return state;
  if (state.settled < cfg.settleFrames) {
    return { ...state, settled: state.settled + 1 };
  }
  const over = gpuMs > cfg.budgetMs;
  const next: GovernorState = {
    ...state,
    over: over ? state.over + 1 : 0,
    under: over ? 0 : state.under + 1,
  };
  if (next.over >= cfg.downAfter && next.tier < 4) {
    return { tier: (next.tier + 1) as QualityTier, over: 0, under: 0, settled: 0 };
  }
  if (next.under >= cfg.upAfter && next.tier > 0) {
    return { tier: (next.tier - 1) as QualityTier, over: 0, under: 0, settled: 0 };
  }
  return next;
}

/** A single catastrophic frame skips a tier instead of waiting for the counter. */
export function stepGovernorHard(
  state: GovernorState,
  gpuMs: number | null,
  cfg: GovernorConfig = DEFAULT_GOVERNOR,
): GovernorState {
  if (gpuMs === null) return state;
  if (gpuMs > cfg.budgetMs * 5 && state.tier < 4) {
    const tier = Math.min(4, state.tier + 2) as QualityTier;
    return { tier, over: 0, under: 0, settled: 0 };
  }
  return stepGovernor(state, gpuMs, cfg);
}
