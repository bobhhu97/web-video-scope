export type Locale = 'en' | 'zh';

export interface I18nStrings {
  appTitle: string;
  pipTitle: string;
  closeTitle: string;
  eyedropper: string;
  eyedropperTitle: string;
  falseColor: string;
  falseColorOn: string;
  falseColorTitle: string;

  modeWave: string;
  modeParade: string;
  modeHist: string;
  modeVector: string;
  modeCie: string;

  scopeWaveform: string;
  scopeParade: string;
  scopeHistogram: string;
  scopeVector: string;
  scopeCie: string;

  layout1: string;
  layout2: string;
  layout3: string;
  layout4: string;

  precAuto: string;
  precLow: string;
  precStd: string;
  precHigh: string;
  precUltra: string;
  precFhd: string;
  precTooSmall: string;
  precFull: string;
  hdrAuto: string;

  fcAuto: string;
  fcArri: string;
  fcSmallHd: string;
  fcSpectrum: string;
  fcHdrNits: string;
  fcPresetAuto: string;
  fcPresetArri: string;
  fcPresetSmallHd: string;
  fcPresetSpectrum: string;
  fcPresetHdr: string;

  signalHdrSection: string;
  wheelZoomHint: string;
  hdrNitZones: string;
  lowNit: string;
  peakNit: string;
  zoneColorAll: string;
  zoneColorAllTitle: string;

  // Cell popover
  popScope: string;
  popChannels: string;
  popParade: string;
  popFilter: string;
  popLowPass: string;
  popTargets: string;
  popTones: string;
  popOverlay: string;
  skinLine: string;
  vecSignal2x: string;
  vecSignal2xTitle: string;
  popChart: string;
  popGamuts: string;
  popColoring: string;
  popScale: string;
  popGain: string;
  popGamma: string;
  popZoom: string;
  resetCell: string;

  toneAll: string;
  toneShadows: string;
  toneMidtones: string;
  toneHighlights: string;

  traceChannel: string;
  traceColorize: string;
  traceMono: string;
  traceHdrZones: string;
  traceGreen: string;

  // Global Settings Modal
  settingsTitle: string;
  secGeneral: string;
  lblLanguage: string;
  lblPanelOpacity: string;
  lblGratBright: string;
  lblTraceColoring: string;
  traceDefault: string;
  secColorSpace: string;
  lblPrimaries: string;
  lblTransfer: string;
  lblMatrix: string;
  lblRange: string;
  lblSignalPath: string;
  lblSdrWhite: string;
  autoDetect: string;
  signalDisplay: string;
  signalRaw: string;

  secEyedropper: string;
  probeShowRings: string;
  probeShowTooltip: string;
  probeRgb8: string;
  probeRgb10: string;
  probeLuma: string;
  probeXy: string;
  probeUv: string;
  probeYuv: string;
  probeHex: string;
  probeCoords: string;

  secFalseColor: string;
  lblFcEnable: string;
  lblFcPreset: string;
  lblFcOpacity: string;
  lblFcLegend: string;
  fcOffscreenHint: string;

  secCapture: string;
  lblCaptureFormat: string;
  lblCaptureScale: string;
  lblCaptureBackground: string;
  captureScaleMatch: string;
  bgPanel: string;
  bgTransparent: string;
  bgWhite: string;
  captureHint: string;
  captureAccuracyHint: string;
  btnCapture: string;
  captureSaved: string;
  captureFailed: string;
  captureBusy: string;
  captureGpuLimit: string;

  btnResetAll: string;
  btnDone: string;
}

export type UiStrings = I18nStrings;

const EN: I18nStrings = {
  appTitle: 'Web Video Scope',
  pipTitle: 'Detach into floating window',
  closeTitle: 'Close (Alt+S)',
  eyedropper: 'Picker',
  eyedropperTitle:
    'Toggle Eyedropper mode: hover video to show signal rings on all scopes & live pixel readout',
  falseColor: 'False Color',
  falseColorOn: 'False Color: ON',
  falseColorTitle: 'Overlay live False Color exposure / HDR Nit zones on video',

  modeWave: 'Wave',
  modeParade: 'Parade',
  modeHist: 'Hist',
  modeVector: 'Vector',
  modeCie: 'CIE',

  scopeWaveform: 'Waveform',
  scopeParade: 'Parade',
  scopeHistogram: 'Histogram',
  scopeVector: 'Vectorscope',
  scopeCie: 'CIE Diagram',

  layout1: '1-Up Single Scope',
  layout2: '2-Up Side by Side',
  layout3: '3-Up Stacked',
  layout4: '4-Up Quad Scopes',

  precAuto: 'Prec: Auto',
  precLow: 'Eco 320p',
  precStd: 'Std 640p',
  precHigh: 'High 854p',
  precUltra: 'Ultra 1280p',
  precFhd: 'FHD 1920p',
  precTooSmall: 'Source is smaller than this preset',
  precFull: 'Full 1:1 (source)',
  hdrAuto: 'HDR: Auto',

  fcAuto: 'FC: Auto',
  fcArri: 'ARRI',
  fcSmallHd: 'SmallHD',
  fcSpectrum: 'Spectrum',
  fcHdrNits: 'HDR Nits',
  fcPresetAuto: 'Auto (SDR→ARRI / HDR→Nits)',
  fcPresetArri: 'ARRI Classic Exposure (6-Band)',
  fcPresetSmallHd: 'SmallHD PageOS Multi-Zone',
  fcPresetSpectrum: 'IRE Continuous Spectrum',
  fcPresetHdr: 'HDR Multi-Zone Nits',

  signalHdrSection: 'Signal & HDR Nit Zones',
  wheelZoomHint: 'Wheel=Zoom · Drag=Pan',
  hdrNitZones: 'HDR Nit Zones:',
  lowNit: 'Low',
  peakNit: 'Peak',
  zoneColorAll: 'Zone Color All',
  zoneColorAllTitle: 'Toggle 3–4 zone HDR Nit coloring across luminance/code scopes',

  popScope: 'Scope',
  popChannels: 'Channels',
  popParade: 'Parade',
  popFilter: 'Filter',
  popLowPass: 'Low-Pass',
  popTargets: 'Targets',
  popTones: 'Tones',
  popOverlay: 'Overlay',
  skinLine: 'Skin I-Line',
  vecSignal2x: '2× Trace',
  vecSignal2xTitle: 'Magnify Vectorscope signal waveform by 2× (keeps graticule at 1×)',
  popChart: 'Chart',
  popGamuts: 'Gamuts',
  popColoring: 'Coloring',
  popScale: 'Scale',
  popGain: 'Gain',
  popGamma: 'Gamma',
  popZoom: 'Zoom',
  resetCell: 'Reset',

  toneAll: 'All Tones',
  toneShadows: 'Low / Shadows',
  toneMidtones: 'Midtones',
  toneHighlights: 'High / Peaks',

  traceChannel: 'Channel Colors',
  traceColorize: 'Colorize (Source RGB)',
  traceMono: 'Monochrome (B&W)',
  traceHdrZones: 'HDR Nit Zones',
  traceGreen: 'Classic Green CRT',

  settingsTitle: 'Global Preferences & Color Pipeline',
  secGeneral: 'General & Appearance',
  lblLanguage: 'Language',
  lblPanelOpacity: 'Panel Opacity',
  lblGratBright: 'Graticule Dim',
  lblTraceColoring: 'Scope Coloring',
  traceDefault: 'Standard (Channel / Color)',
  secColorSpace: 'Source Color Space Override',
  lblPrimaries: 'Primaries',
  lblTransfer: 'Transfer (EOTF)',
  lblMatrix: 'YUV Matrix',
  lblRange: 'Data Range',
  lblSignalPath: 'Signal Path',
  lblSdrWhite: 'SDR Ref White',
  autoDetect: 'Auto (Stream VUI)',
  signalDisplay: 'Display RGB (0-Copy GPU)',
  signalRaw: 'Raw Decoded YUV',

  secEyedropper: 'Eyedropper & Cursor Readout',
  probeShowRings: 'Show Rings on Scopes',
  probeShowTooltip: 'Cursor Readout Tooltip',
  probeRgb8: 'RGB 8-bit (0–255)',
  probeRgb10: 'RGB 10-bit (0–1023)',
  probeLuma: 'Luminance (IRE / HDR Nits)',
  probeXy: 'CIE 1931 (x, y)',
  probeUv: "CIE 1976 (u', v')",
  probeYuv: 'Chroma (Cb, Cr)',
  probeHex: 'HEX (#RRGGBB)',
  probeCoords: 'Pixel Coords (X, Y)',

  secFalseColor: 'False Color Overlay',
  lblFcEnable: 'Enable Live False Color Overlay on Video',
  lblFcPreset: 'False Color Mode',
  lblFcOpacity: 'Overlay Opacity',
  lblFcLegend: 'Show Scale Legend on Video',
  fcOffscreenHint: 'False Color is ON — scroll the main video into the viewport to display the overlay.',

  secCapture: 'Panel Snapshot',
  lblCaptureFormat: 'Format',
  lblCaptureScale: 'Resolution',
  lblCaptureBackground: 'Background',
  captureScaleMatch: 'Match source',
  bgPanel: 'Panel gray',
  bgTransparent: 'Transparent',
  bgWhite: 'White',
  captureHint:
    'Click the camera to export the whole layout (2×2 in quad, a column in triple). Hold ⇧ or ⌥ for just the active panel.',
  captureAccuracyHint:
    'Snapshots re-render at a higher multiplier, but detail is capped by the analysis precision. Pick “Full 1:1” to export true per-pixel detail.',
  btnCapture: 'Save snapshot',
  captureSaved: 'Snapshot saved',
  captureFailed: 'Snapshot failed',
  captureBusy: 'Rendering snapshot…',
  captureGpuLimit: 'GPU limit',

  btnResetAll: 'Reset All Defaults',
  btnDone: 'Done',
};

const ZH: I18nStrings = {
  appTitle: 'Web 视频示波器',
  pipTitle: '弹出为独立置顶悬浮窗',
  closeTitle: '关闭面板 (Alt+S)',
  eyedropper: '吸管',
  eyedropperTitle: '开启/关闭吸管取色：鼠标移过画面时在各示波器联动显示定位圆圈与数值浮窗',
  falseColor: '伪色',
  falseColorOn: '伪色: 开',
  falseColorTitle: '在视频画面上叠加实时曝光伪色 / HDR Nit 分区层',

  modeWave: '波形',
  modeParade: '分量',
  modeHist: '直方图',
  modeVector: '矢量',
  modeCie: 'CIE色度',

  scopeWaveform: '波形图',
  scopeParade: '分量图',
  scopeHistogram: '直方图',
  scopeVector: '矢量示波器',
  scopeCie: 'CIE 色度图',

  layout1: '单格视图 (1-Up)',
  layout2: '双格并排 (2-Up)',
  layout3: '三格叠放 (3-Up)',
  layout4: '四宫格视图 (4-Up)',

  precAuto: '精度: 自动',
  precLow: '省电 320p',
  precStd: '标准 640p',
  precHigh: '高清 854p',
  precUltra: '超清 1280p',
  precFhd: 'FHD 1920p',
  precTooSmall: '视频源分辨率低于该档位',
  precFull: '全分辨率 1:1 (源)',
  hdrAuto: 'HDR: 自动',

  fcAuto: '伪色: 自动',
  fcArri: 'ARRI',
  fcSmallHd: 'SmallHD',
  fcSpectrum: 'IRE光谱',
  fcHdrNits: 'HDR Nits',
  fcPresetAuto: '自动切换 (SDR→ARRI / HDR→Nits)',
  fcPresetArri: 'ARRI 经典六段曝光伪色',
  fcPresetSmallHd: 'SmallHD PageOS 曝光伪色',
  fcPresetSpectrum: 'IRE 连续彩虹光谱伪色',
  fcPresetHdr: 'HDR 多区 Nit 伪色',

  signalHdrSection: '信号与 HDR Nit 分区设置',
  wheelZoomHint: '滚轮=缩放 · 拖拽=平移',
  hdrNitZones: 'HDR Nit 阈值:',
  lowNit: '暗部',
  peakNit: '峰值',
  zoneColorAll: '全波形 Nit 着色',
  zoneColorAllTitle: '为所有波形/分量/直方图切换 HDR 三/四区 Nit 着色',

  popScope: '示波器',
  popChannels: '通道',
  popParade: '分量',
  popFilter: '滤波',
  popLowPass: '低通抗噪',
  popTargets: '彩条靶标',
  popTones: '色调过滤',
  popOverlay: '辅助线',
  skinLine: '肤色线 (I-Line)',
  vecSignal2x: '波形 2×',
  vecSignal2xTitle: '仅将矢量波形信号放大 2 倍便于观察，外圈刻度保持不变',
  popChart: '坐标系',
  popGamuts: '色域框',
  popColoring: '着色模式',
  popScale: '刻度单位',
  popGain: '增益',
  popGamma: '伽马',
  popZoom: '缩放',
  resetCell: '重置',

  toneAll: '全部色调',
  toneShadows: '暗部 (Shadows)',
  toneMidtones: '中间调 (Midtones)',
  toneHighlights: '高光 (Highlights)',

  traceChannel: '通道标准色',
  traceColorize: '源画面真彩色 (Colorize)',
  traceMono: '黑白无着色 (B&W)',
  traceHdrZones: 'HDR 多区 Nit 着色',
  traceGreen: '经典绿荧光 (CRT)',

  settingsTitle: '全局设置与色彩空间配置',
  secGeneral: '常规与界面外观',
  lblLanguage: '界面语言',
  lblPanelOpacity: '面板透明度',
  lblGratBright: '刻度亮度',
  lblTraceColoring: '示波器着色',
  traceDefault: '标准配色 (通道色 / 真彩色)',
  secColorSpace: '当前画面色彩空间指定',
  lblPrimaries: '画面色域',
  lblTransfer: '转换曲线',
  lblMatrix: '色彩矩阵',
  lblRange: '量化范围',
  lblSignalPath: '采样路径',
  lblSdrWhite: 'SDR参考白',
  autoDetect: '自动识别 (跟随视频流)',
  signalDisplay: '显示画面 RGB (GPU零拷贝)',
  signalRaw: '底层解码 YUV (NV12/P010)',

  secEyedropper: '吸管模式与数值显示项',
  probeShowRings: '在各示波器上联动显示定位圆圈',
  probeShowTooltip: '跟随鼠标指针显示数值浮窗',
  probeRgb8: 'RGB 8-bit 数值 (0–255)',
  probeRgb10: 'RGB 10-bit 数值 (0–1023)',
  probeLuma: '亮度读数 (IRE / HDR Nits)',
  probeXy: 'CIE 1931 色坐标 (x, y)',
  probeUv: "CIE 1976 色坐标 (u', v')",
  probeYuv: '色差分量 (Cb, Cr)',
  probeHex: 'HEX 色值 (#RRGGBB)',
  probeCoords: '画面像素坐标 (X, Y)',

  secFalseColor: '伪色叠加层设置',
  lblFcEnable: '开启视频画面实时伪色叠加',
  lblFcPreset: '伪色模式',
  lblFcOpacity: '叠加透明度',
  lblFcLegend: '在视频左下角显示伪色标尺图例',
  fcOffscreenHint: '伪色已开启：当前目标视频不在可视区域内，请滚动至主视频画面。',

  secCapture: '画面截图导出',
  lblCaptureFormat: '文件格式',
  lblCaptureScale: '导出分辨率',
  lblCaptureBackground: '背景',
  captureScaleMatch: '匹配源',
  bgPanel: '面板灰底',
  bgTransparent: '透明',
  bgWhite: '白底',
  captureHint:
    '点相机按钮导出当前整个布局（四宫格为 2×2，三宫格为竖排一列）；按住 ⇧ 或 ⌥ 只截选中的面板。',
  captureAccuracyHint:
    '截图会以更高倍率重新渲染，但细节上限仍由分析精度决定。想要真实像素级细节，请把精度设为“全分辨率 1:1”。',
  btnCapture: '保存截图',
  captureSaved: '截图已保存',
  captureFailed: '截图失败',
  captureBusy: '正在渲染截图…',
  captureGpuLimit: 'GPU 上限',

  btnResetAll: '恢复默认设置',
  btnDone: '完成',
};

export function t(lang: Locale | undefined): I18nStrings {
  return lang === 'zh' ? ZH : EN;
}
