// Re-exports only. Vite's library-style output would tree-shake a pure
// re-export module down to nothing, so this flag keeps the exports alive for
// the test harness which imports them by name.
export const HARNESS_BUNDLE = true;

export { initCanvas, configureCanvas, getDevice } from './gpu/device';
export { SignalTexture } from './gpu/signal-texture';
export { Downscaler, analysisSize, ANALYSIS_SIZES } from './gpu/downscale';
export { ScopeRenderer, DEFAULT_SCOPE_OPTIONS } from './gpu/scope-renderer';
export { drawGraticule, drawWaveformGraticule, drawVectorscopeGraticule, drawCieGraticule } from './ui/graticule';
export { default as DOWNSCALE_WGSL } from './gpu/shaders/downscale.wgsl?raw';
