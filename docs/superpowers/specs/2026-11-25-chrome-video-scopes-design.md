# Chrome 视频示波器插件 — 设计规范

- 日期：2026-11-25
- 状态：待实现
- 目标浏览器：Chrome 121+（Manifest V3）

## 1. 问题与目标

在任意网页播放的视频（YouTube / Bilibili / Vimeo / 自建流媒体 / `<video>` 驱动的 Web 编辑器）之上叠加一层专业级视频示波器，用于判断曝光、黑位、色偏、饱和度和 HDR 合规性。

必须满足：

1. **波形示波器**：Y 通道、RGB 三通道叠加、RGB / YRGB Parade。
2. **矢量示波器**：Cb/Cr 极坐标点云，含 75% / 100% 彩条靶标与肤色线。
3. **CIE 马蹄图**：CIE 1931 xy 与 CIE 1976 u'v' 两种色度图，可叠加色域三角形。
4. **正确识别 video range**：Limited（16–235 / 64–940）与 Full（0–255 / 0–1023）不能靠猜，要读解码器元数据，并且能诊断常见的 range 错标。
5. **多套刻度标识**：IRE、8-bit 码值、10-bit 码值、mV、HDR nits。
6. **性能**：1080p60 播放时单个示波器额外开销 < 1.5 ms GPU；四个示波器同时开启不掉帧。
7. **不干扰宿主页面**：CSS 完全隔离，全屏播放时仍可见。

## 2. 非目标（YAGNI）

- 不做视频编辑、导出、LUT 应用。
- 不做音频表 / 响度表。
- 不做 DRM（Widevine/EME）加密视频的分析 —— 这类视频在 WebCodecs 与 canvas 上都拿不到像素，只提示不支持。
- 不做 Firefox / Safari 适配（WebGPU + Element Capture 组合依赖 Chrome）。

## 3. 关键调研结论（决定了架构）

| 结论 | 来源 | 对设计的影响 |
| --- | --- | --- |
| 点云 `gl.POINTS` + 加法混合在密集区域会硬件冲突，Apple Silicon 上 4K 掉到 3 FPS | Blender 5.0 VSE 示波器 PR #144867（Aras Pranckevicius） | 主路径用 **Compute Shader 原子累加**，不用点云 |
| Compute 原子累加 + fragment resolve 在 4K 下 waveform 约 1.2 ms、vectorscope 约 0.6 ms | 同上 | 性能目标可达 |
| `new VideoFrame(htmlVideoElement)` 直接复用底层 `media::VideoFrame`，保留 `colorSpace`（primaries/transfer/matrix/fullRange） | Chromium `video_frame.cc` | range 元数据来源 |
| `importExternalTexture` 对跨源 tainted 视频抛 `SecurityError`；`tabCapture` 不绕过这一点 | MDN + Chromium `gpu_external_texture.cc` | 需要三层捕获瀑布流 |
| `tabCapture` 拿到的是**合成后**画面（已做色彩管理与 range 展开，分辨率=显示尺寸） | Chromium 实现 | 兜底路径必须标记「range 未知 / display-referred」 |
| Element Capture（`RestrictionTarget.fromElement`）与 Region Capture 可把 tab 流裁剪到单个元素 | Chrome 121+ | L3 兜底可只抓视频区域 |
| WebGPU 外部纹理采样返回的是**显示参考**的 RGB（YUV→RGB 已按视频 colorSpace 展开） | WebGPU 规范 + Chromium | 码值还原需要按元数据做逆映射；精确码值另设 Raw Plane 模式 |

## 4. 架构

```
┌──────────────────────────── 页面 (content script, 隔离世界) ────────────────────────────┐
│  VideoDetector ──► rVFC 帧调度 ──► FrameSource ──► ScopeEngine (WebGPU) ──► HUD (Shadow DOM) │
│      │                                    │              │                    │            │
│      ▼                                    ▼              ▼                    ▼            │
│  MutationObserver                   L1 VideoFrame     signalTex          graticule canvas   │
│  (SPA 换集 / 全屏)                   L2 CORS-fixed     (rgba16float)       (2D, DPR-aware)   │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                            │ L3 (可选)
                              ┌─────────────▼─────────────┐
                              │ background SW: getMediaStreamId │
                              │ offscreen doc: getUserMedia + restrictTo │
                              └───────────────────────────┘
```

### 4.1 帧捕获：三层瀑布流

| 层 | 触发条件 | 手段 | 数据性质 |
| --- | --- | --- | --- |
| **L1 零拷贝** | 视频 origin-clean（同源 / 有 CORS 头 / MSE blob） | `requestVideoFrameCallback` 回调里 `device.importExternalTexture({ source: video })` | 显示参考 RGB，元数据已知（可 `new VideoFrame(video).colorSpace` 读取） |
| **L2 CORS 修复** | 跨源且有 `Access-Control-Allow-Origin: *` 能力 | `declarativeNetRequest` 注入 ACAO 头 + 重设 `video.crossOrigin` 并 `load()` | 同 L1 |
| **L3 合成器捕获** | 站点拒绝 CORS 或签名 URL | `chrome.tabCapture.getMediaStreamId` → offscreen `getUserMedia` → `track.restrictTo(RestrictionTarget.fromElement(video))`，失败则 `track.cropTo(CropTarget.fromElement(video))` | 显示参考，分辨率=显示尺寸，range 标记为 `unknown` |

L3 若不可用（老版本 Chrome / 元素不可定位），UI 顶部显示不可分析横幅，并给出「切到 L2」「用内置测试页」两条出路。

### 4.2 帧调度

- 只在 `requestVideoFrameCallback` 回调里工作：视频 24 fps 就只分析 24 次/秒，暂停时 0 开销。
- 用户拖动进度条触发 `seeked`、切换刻度/示波器参数时，额外渲染一次「当前帧静态分析」。
- 分析频率与显示频率解耦：`analysisFps`（默认 30）节流，`ScopeEngine` 每帧只做一次信号纹理更新，多个示波器共享（Blender `SEQ_preview_cache` 同思路）。
- 页面不可见（`document.hidden`）或 HUD 关闭时停止分析。

### 4.3 GPU 管线（每帧）

1. **Decode pass**：全屏三角采样 `texture_external` → `rgba16float` 的 `signalTex`（分析分辨率，默认 960×540，可设 Full/Half/Quarter）。
2. **Clear pass**：清零所有启用的密度缓冲（`R32Uint` storage）。
3. **Gather pass**（每个示波器一个 compute）：`textureLoad(signalTex)` → 色彩数学 → `atomicAdd` 到密度缓冲。
4. **Resolve pass**：fragment shader 读密度，荧光映射 `I = 1 - exp(-n·gain)`，写 canvas（`alphaMode: 'premultiplied'`，背景透明）。
5. **Graticule** 由独立 2D canvas 在 DOM 下层绘制并缓存，刻度变化才重绘（保证文字锐利，省一次纹理上传）。

### 4.4 色彩数学

亮度系数：

| Matrix | Kr | Kg | Kb |
| --- | --- | --- | --- |
| BT.709 | 0.2126 | 0.7152 | 0.0722 |
| BT.601 (smpte170m / bt470bg) | 0.299 | 0.587 | 0.114 |
| BT.2020 NCL | 0.2627 | 0.678 | 0.0593 |

```
Y'  = Kr·R' + Kg·G' + Kb·B'
Cb  = (B' - Y') / (2(1 - Kb))
Cr  = (R' - Y') / (2(1 - Kr))
```

码值还原（`norm ∈ [0,1]` 为显示归一化信号）：

```
limited 8-bit : code = 16  + 219·norm
full    8-bit : code = 0   + 255·norm
limited 10-bit: code = 64  + 876·norm
full   10-bit : code = 0   + 1023·norm
```

**纵向坐标轴统一使用「码值空间」**：归一化轴坐标 `a = code / maxCode`（8-bit 除以 255，10-bit 除以 1023）。所有单位只是同一根轴上的不同标尺：

```
IRE(a)  = (a·maxCode - black) / (white - black) · 100
code8(a) = a·255        code10(a) = a·1023
mV(a)   = IRE(a)/100 · 700
```

Limited 信号的黑位因此自然落在 `16/255 = 6.27%` 高度而不是贴底，Footroom / Headroom 成为轴上真实可见的带状区域，与硬件示波器一致。

RGB→XYZ（D65）常量直接内置：

```
Rec.709/sRGB : 0.412391 0.357584 0.180481 / 0.212639 0.715169 0.072192 / 0.019331 0.119195 0.950532
Display-P3   : 0.486571 0.265668 0.198217 / 0.228975 0.691739 0.079287 / 0.000000 0.045113 1.043944
Rec.2020     : 0.636958 0.144617 0.168881 / 0.262700 0.677998 0.059302 / 0.000000 0.028073 1.060985
```

CIE 1976：`u' = 4X / (X + 15Y + 3Z)`，`v' = 9Y / (X + 15Y + 3Z)`。

### 4.5 Video range 诊断

1. **元数据直读**（权威）：`new VideoFrame(video).colorSpace.fullRange`、`.matrix`、`.primaries`、`.transfer`、`frame.format`。
2. **统计启发式**（发现错标）：对每帧亮度直方图取 `P0.1` / `P99.9` 与越界比例。
   - 声明 `full`，但 `P0.1 ∈ [0.045, 0.085]` 且 `P99.9 ∈ [0.90, 0.94]` 且越界比例 < 0.2% → **疑似按 Full 解码了 Limited 信号**（黑位悬空、高光不到位）。
   - 声明 `limited`，但 `P0.1 ≤ 0.02` 且 `P99.9 ≥ 0.98` 且存在越界像素 → **疑似按 Limited 解读了 Full 信号**（黑位被切、高光溢出）。
   - 连续 3 帧同结论才提示，避免闪黑帧误报。
3. **手动覆盖**：`Auto / Force Limited / Force Full`，立即改变波形纵向标尺与码值读法。
4. 状态栏常驻显示：`BT.709 · Limited · 8-bit · NV12 · 显示参考`。

## 5. 示波器细节

### 5.1 Waveform

- 模式：`Y`（单通道）、`RGB`（三通道叠加加法混合）、`RGB Parade`（水平三等分）、`YRGB Parade`（四等分）。
- 纵向 = 码值（0..maxCode），横向 = 源画面列。
- 刻度单位：`ire | code8 | code10 | mv | nits`；Limited 时在 16/235（8-bit）处画 Legal 边界虚线，0–16 与 235–255 区域加半透明 Footroom/Headroom 底色带。
- 可调：`gain`（荧光增益）、`gamma`、`tint`（默认绿 #7CFF9B，RGB 模式用通道色）、`zoom`（HDR 时纵向放大到 0–4×）。

### 5.2 Vectorscope

- 映射：屏幕 `x = Cb`，`y = Cr`（由此红色靶标落在 ~103°，与广播习惯一致），半径 `0.5·0.9·zoom`。
- 靶标：六色 × 75% / 100% 由当前矩阵实时算出的精确坐标（不写死），随 BT.601/709/2020 切换重排。
- 肤色线：`atan2` 角 123°，从中心到 0.45R 画暖色虚线。
- 缩放：1× / 2× / 4× / 8×，缩放时靶标同步缩放。

### 5.3 CIE 马蹄图

- 坐标系：1931 xy（默认）/ 1976 u'v'。
- 底图：1931 2° 观察者光谱轨迹 380–700 nm（10 nm 步长，33 点）+ 紫边闭合；轨迹外区域画极淡灰。
- 叠层：Rec.709 / Display-P3 / Rec.2020 / ACES AP1 三角形；D65 与 DCI 白点十字。
- 点云：按色度 bin 累加，颜色取该 bin 的代表色（用逆 XYZ→sRGB 求色相，越界色域做柔和裁切），亮度按计数。

## 6. UI / 交互

- **HUD**：Shadow DOM（`mode: 'open'`，宿主 `all: initial`），可拖拽、可缩放、记忆位置（`chrome.storage.local`）。
- **布局**：单视图 / 2×2 四宫格 / 1×3 三联（Waveform+Parade+Vectorscope）。
- **全屏跟随**：监听 `fullscreenchange`，把 Shadow Host 重新 append 到 `document.fullscreenElement`（或其 shadow root）内。
- **画中画**：`documentPictureInPicture.requestWindow()` 拉出独立置顶窗口，示波器可放第二屏。
- **像素探针**：按住 `Alt` 在视频上移动，显示该点码值与色度，并在三个示波器上联动十字线。
- **快捷键**：`Alt+S` 开关 HUD，`Alt+1..4` 切视图，`Alt+R` 切 range 覆盖。
- **性能徽章**：显示当前 analysis FPS 与单帧 GPU 耗时（`timestamp-query` 可用时）。

## 7. 目录结构

```
chrome-video-scopes/
├── manifest.json  package.json  tsconfig.json  vite.config.ts  vitest.config.ts
├── public/test-harness.html   public/harness.js
├── src/
│   ├── harness-entry.ts                 # 测试台导出汇总
│   ├── background/service-worker.ts  offscreen.ts
│   ├── content/
│   │   ├── index.ts        # 装配与快捷键
│   │   ├── video-detector.ts  frame-loop.ts  fullscreen.ts
│   │   ├── color-space.ts  # VideoFrame.colorspace -> ColorSpaceInfo
│   │   └── scope-controller.ts  # 唯一持有 GPU 资源
│   ├── core/
│   │   ├── color/  matrices.ts  primaries.ts  transfer.ts  locus.ts
│   │   ├── scale/  quantize.ts（码值轴）  units.ts（IRE/code/mV/nits）
│   │   ├── range-detector.ts
│   │   └── scopes/ stats.ts  reference.ts（CPU 基准）  plan.ts
│   ├── gpu/
│   │   ├── device.ts  signal-texture.ts  raw-planes.ts  scope-renderer.ts
│   │   └── shaders/ accumulate.wgsl  resolve.wgsl
│   └── ui/  hud.ts（只做 DOM）  graticule.ts  probe.ts  settings.ts
└── tests/  *.test.ts
```

> 单一 `accumulate.wgsl` 用 `accMode`（0 波形 / 2 矢量 / 3 CIE）与 `signalKind`（0 display / 1 raw）分派，避免四份高度相似、容易各自漂移的 shader。

## 8. 已知限制（必须写进 README）

1. **默认观测显示参考信号**：`copyExternalImageToTexture` 取到的是浏览器色彩管理之后的 RGB。对 SDR Rec.709 内容，range 展开可被 `blend()` 精确还原，观测有效；对 PQ / HLG / 非 Rec.709 原色，必须切「Raw Plane」模式读原始 I420 平面才准确。
2. **nits 标尺假设 PQ**：轴坐标直接按 PQ 信号解读，因此对 HDR 内容是精确的；对 SDR 内容只是换一组参考刻度，UI 标注 `PQ assumed`。
3. **Raw 模式没有逐通道 RGB**：只有 Y/U/V 平面，RGB Parade 会把 Y 复制到三栏并标注 `Y only`。
4. **DRM 视频**：EME 加密内容取不到像素，插件显示不支持。
5. **L3 捕获精度**：分辨率等于视频在页面上的显示尺寸而非源分辨率；range 只能靠统计推断，状态栏标注 `heuristic`。
6. **跨源无 CORS**：默认不可分析，需用户显式开启 L2 注入（DNR 需 `declarativeNetRequest` 权限，商店审核需说明）。

## 9. 验收标准

- 内置测试页（SMPTE 75% 彩条 + 灰阶斜坡 + Limited/Full 双版本）上：
  - Waveform 在 IRE 刻度下 75% 白条落在 75±0.5 IRE；Limited 版本黑位在 0 IRE、白位在 100 IRE。
  - **Limited 版本的黑位在轴上位于 6.27% 高度而非贴底**——这是码值轴正确性的核心判据。
  - **切换 IRE / 8-bit / 10-bit / mV / nits 标尺后波形几何完全不变**，只有标签变化。
  - Vectorscope 六色 75% 靶标误差 < 2 px（512 px 画布、无缩放）。
  - CIE 图上纯红/绿/蓝落在对应原色顶点 ±0.004 色度单位内。
  - Range 诊断对「Limited 码值但标 Full」的片源 3 帧内告警，对正常片连续 10 秒不误报。
- 1080p60 YouTube 播放，四个示波器全开，fps ≥ 55；单帧 compute 分派无 `GPUValidationError`。
- 全屏（YouTube `f`）后 HUD 仍在可视区。
- 关闭 HUD 再打开 5 次，`performance.memory` 无持续增长（`destroy()` 覆盖 texture/buffer）。
- 单元测试覆盖：`matrices` `primaries` `transfer` `quantize` `units` `locus` `range-detector` `reference` `signal-texture` `graticule` `vectorscope-geometry` `cie-geometry` `plan` `raw-layout`。
