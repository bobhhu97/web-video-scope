# Chrome 视频示波器插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Manifest V3 Chrome 插件，在任意网页播放的视频上叠加实时波形（Y/RGB/RGB Parade）、矢量示波器、CIE 1931/1976 色度图，并准确识别 video range 与色彩元数据。

**Architecture:** content script 用 `requestVideoFrameCallback` 驱动帧同步，`copyExternalImageToTexture` 把显示编码后的像素送入 WebGPU `rgba8unorm` 信号纹理；每个示波器一条 compute 管线把像素原子累加到 `array<atomic<u32>>` 密度缓冲，再由 fragment shader 做荧光映射与合成为透明 canvas；刻度网由独立 2D canvas 绘制在 DOM 下层。跨源视频走三层捕获瀑布流（L1 零拷贝 → L2 DNR 注入 CORS → L3 tabCapture + Element Restriction）。

**Tech Stack:** TypeScript、Vite（多入口 library build）、WebGPU（WGSL compute + render）、Canvas 2D（graticule）、Vitest、Manifest V3。

## Global Constraints

- 目标环境：Chrome 121+（`@webgpu/types` 版本 ≥ 0.1.60，`package.json` 中 `"engines": { "node": ">=20" }`）。
- Manifest V3，权限只声明需要的：`activeTab`、`scripting`、`storage`、`tabCapture`、`offscreen`；`declarativeNetRequest` 仅在 L2 任务中加入。
- 所有 GPU 输出 canvas 必须 `alphaMode: 'premultiplied'`，背景透明，由 CSS 提供面板底色。
- 所有 UI 必须挂在 Shadow DOM 内，宿主根节点 `position: fixed; z-index: 2147483646; all: initial`。
- 色彩常量（亮度系数、RGB→XYZ 矩阵）不得写死在任何 UI 代码里，只能来自 `src/core/color/`。
- 分析流程必须由 `requestVideoFrameCallback` 驱动，禁止用裸 `requestAnimationFrame` 轮询视频帧（rAF 只用于渲染循环）。
- 任何新增源文件都必须有对应的 Vitest 单测或明确的浏览器内验证步骤（测试台页面 + 截图断言）。
- 提交信息使用 Conventional Commits（`feat:` / `fix:` / `test:` / `chore:`）。

---

## File Structure

```
chrome-video-scopes/
├── manifest.json  package.json  tsconfig.json  vite.config.ts  vitest.config.ts
├── public/
│   ├── test-harness.html        # 内置 SMPTE 彩条 + 灰阶阶梯测试台（?range=limited|full）
│   └── harness.js               # 测试台脚本，import harness-bundle.js
├── src/
│   ├── harness-entry.ts         # 测试台专用导出汇总（非插件产物）
│   ├── background/
│   │   ├── service-worker.ts    # action 转发 + tabCapture stream id + DNR 开关
│   │   └── offscreen.ts         # tabCapture 兜底分析文档
│   ├── content/
│   │   ├── index.ts             # 入口：装配 detector / HUD / controller / 快捷键
│   │   ├── video-detector.ts    # 找到主 <video>，处理 SPA 换集与全屏
│   │   ├── frame-loop.ts        # rVFC 驱动 + 节流 + seeked 重绘
│   │   ├── fullscreen.ts        # host 跟随 fullscreenElement 重挂载
│   │   ├── color-space.ts       # VideoFrame.colorspace → ColorSpaceInfo，RangeMode → RangeSpec
│   │   └── scope-controller.ts  # 唯一持有 GPU 资源（device/context/texture/renderer）
│   ├── core/
│   │   ├── color/
│   │   │   ├── matrices.ts      # 亮度系数、YCbCr、彩条靶标
│   │   │   ├── primaries.ts     # 原色 xy、RGB→XYZ 矩阵、xy/u'v'
│   │   │   ├── transfer.ts      # sRGB / PQ / HLG / xy→linear sRGB
│   │   │   └── locus.ts         # CIE 1931 光谱轨迹、色域三角形
│   │   ├── scale/
│   │   │   ├── quantize.ts      # 码值轴、Limited/Full 边界、axisMapping
│   │   │   └── units.ts         # IRE / 8b / 10b / mV / nits 刻度
│   │   ├── range-detector.ts    # 元数据优先 + 统计启发式错标检测
│   │   └── scopes/
│   │       ├── stats.ts         # 直方图 → P0.1/P99.9/越界比例
│   │       ├── reference.ts     # CPU 参考实现（GPU 的验收基准）+ CIE_BOUNDS
│   │       └── plan.ts          # rebuild vs uniform-update 判定（纯函数）
│   ├── gpu/
│   │   ├── device.ts            # 共享 GPUDevice、canvas context、DPR 同步
│   │   ├── signal-texture.ts    # copyExternalImageToTexture + 帧去重
│   │   ├── raw-planes.ts        # VideoFrame.copyTo → r8unorm + rg8unorm
│   │   ├── scope-renderer.ts    # compute 累加 + resolve 合成
│   │   └── shaders/
│   │       ├── accumulate.wgsl
│   │       └── resolve.wgsl
│   └── ui/
│       ├── hud.ts               # Shadow DOM 面板（只做 DOM 与交互，不画图）
│       ├── graticule.ts         # 三种刻度网 + 坐标换算
│       ├── probe.ts             # 像素探针
│       └── settings.ts          # chrome.storage 状态读写
└── tests/
    ├── matrices.test.ts  primaries.test.ts  transfer.test.ts
    ├── quantize.test.ts  units.test.ts      locus.test.ts
    ├── range-detector.test.ts  reference.test.ts
    ├── signal-texture.test.ts  graticule.test.ts
    ├── vectorscope-geometry.test.ts  cie-geometry.test.ts
    ├── plan.test.ts      raw-layout.test.ts
```

---

### Task 1: 工程脚手架与最小可加载插件

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `manifest.json`, `src/content/index.ts`, `.gitignore`

**Interfaces:**
- Produces: `pnpm build` 输出 `dist/manifest.json` + `dist/content.js`；后续所有任务都复用这套构建。

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "chrome-video-scopes",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "dev": "vite build --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.287",
    "@webgpu/types": "^0.1.60",
    "typescript": "^5.7.2",
    "vite": "^6.0.7",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["@webgpu/types", "chrome"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: 写 `vite.config.ts`（content script 需要 IIFE，不能是 ESM）**

```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome121',
    minify: false,
    rollupOptions: {
      input: { content: resolve(__dirname, 'src/content/index.ts') },
      output: {
        entryFileNames: '[name].js',
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
  publicDir: 'public',
});
```

- [ ] **Step 4: 写 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
```

- [ ] **Step 5: 写 `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Video Scopes",
  "version": "0.1.0",
  "description": "Waveform, vectorscope and CIE diagram overlay for any video on the web.",
  "minimum_chrome_version": "121",
  "permissions": ["activeTab", "scripting", "storage"],
  "action": { "default_title": "Toggle video scopes" },
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ]
}
```

- [ ] **Step 6: 写最小 `src/content/index.ts`**

```ts
const HOST_ID = 'video-scopes-host';

function toggle(): void {
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.remove();
    return;
  }
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText =
    'position:fixed;top:16px;right:16px;z-index:2147483646;all:initial;' +
    'font:12px/1.4 ui-monospace,monospace;color:#9fe8b0;background:#101413cc;' +
    'padding:8px 12px;border-radius:6px;border:1px solid #9fe8b033';
  host.textContent = 'Video Scopes ready';
  document.documentElement.appendChild(host);
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'toggle-scopes') toggle();
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') toggle();
});
```

- [ ] **Step 7: 写 `src/background/service-worker.ts`（先只做 action 转发）**

```ts
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle-scopes' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  }
});
```

同时在 `vite.config.ts` 的 `rollupOptions.input` 加 `background: resolve(__dirname, 'src/background/service-worker.ts')`。

- [ ] **Step 8: 写 `.gitignore`**

```
node_modules
dist
*.log
.DS_Store
```

- [ ] **Step 9: 安装并构建**

Run: `pnpm install && pnpm build`
Expected: 输出 `dist/content.js`、`dist/background.js`、`dist/manifest.json`，无 TS 报错。

- [ ] **Step 10: 手动验证**

在 `chrome://extensions` 打开开发者模式 → 「加载已解压的扩展程序」→ 选 `dist` → 打开任意含 `<video>` 的页面 → 点扩展图标。
Expected: 右上角出现 `Video Scopes ready` 绿色标签，再点一次消失。

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold MV3 extension with vite build"
```

---

### Task 2: 色彩数学核心（亮度系数、YCbCr、原色矩阵）

**Files:**
- Create: `src/core/color/matrices.ts`, `src/core/color/primaries.ts`
- Test: `tests/matrices.test.ts`, `tests/primaries.test.ts`

**Interfaces:**
- Produces:
  - `type MatrixId = 'bt709' | 'bt601' | 'bt2020'`
  - `LUMA: Record<MatrixId, LumaCoefficients>`，`LumaCoefficients = { kr: number; kg: number; kb: number }`
  - `luma(r, g, b, c): number`
  - `chroma(r, g, b, c): { cb: number; cr: number }`
  - `chromaTargets(c, level): ChromaTarget[]`，`ChromaTarget = { name: BarName; y: number; cb: number; cr: number; angleDeg: number; radius: number }`
  - `SKIN_TONE_ANGLE_DEG = 123`
  - `type PrimariesId = 'rec709' | 'p3' | 'rec2020'`
  - `PRIMARIES: Record<PrimariesId, Primaries>`，`Primaries = { id; xy: { r: [number, number]; g: [number, number]; b: [number, number] }; white: [number, number]; rgbToXyz: number[][] }`
  - `linearRgbToXyz(rgb: [number, number, number], p: PrimariesId): [number, number, number]`
  - `xyzToXY(xyz): [number, number]`，`xyzToUV(xyz): [number, number]`

- [ ] **Step 1: 写失败测试 `tests/matrices.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { LUMA, chroma, chromaTargets, luma } from '../src/core/color/matrices';

describe('luma', () => {
  it('white at 75% has luma 0.75 for every matrix', () => {
    for (const c of Object.values(LUMA)) {
      expect(luma(0.75, 0.75, 0.75, c)).toBeCloseTo(0.75, 6);
    }
  });

  it('BT.709 75% red has luma 0.1595 and chroma (-0.0859, 0.375)', () => {
    expect(luma(0.75, 0, 0, LUMA.bt709)).toBeCloseTo(0.15945, 4);
    const { cb, cr } = chroma(0.75, 0, 0, LUMA.bt709);
    expect(cb).toBeCloseTo(-0.0859, 4);
    expect(cr).toBeCloseTo(0.375, 4);
  });

  it('BT.2020 75% blue has luma 0.0445', () => {
    expect(luma(0, 0, 0.75, LUMA.bt2020)).toBeCloseTo(0.04448, 4);
  });

  it('BT.601 100% red has luma 0.299', () => {
    expect(luma(1, 0, 0, LUMA.bt601)).toBeCloseTo(0.299, 6);
  });
});

describe('chromaTargets', () => {
  it('returns 6 bars with red near 103 degrees in BT.709', () => {
    const t = chromaTargets(LUMA.bt709, 0.75);
    expect(t.map((x) => x.name)).toEqual(['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']);
    const red = t.find((x) => x.name === 'red')!;
    expect(red.angleDeg).toBeCloseTo(102.91, 2);
    expect(red.radius).toBeCloseTo(0.3847, 4);
  });

  it('100% targets are exactly 1/0.75 of 75% targets for saturated primaries', () => {
    const t75 = chromaTargets(LUMA.bt709, 0.75).find((x) => x.name === 'red')!;
    const t100 = chromaTargets(LUMA.bt709, 1).find((x) => x.name === 'red')!;
    expect(t100.cb / t75.cb).toBeCloseTo(1 / 0.75, 3);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/matrices.test.ts`
Expected: FAIL — `Cannot find module '../src/core/color/matrices'`。

- [ ] **Step 3: 实现 `src/core/color/matrices.ts`**

```ts
export type MatrixId = 'bt709' | 'bt601' | 'bt2020';

export interface LumaCoefficients {
  readonly kr: number;
  readonly kg: number;
  readonly kb: number;
}

export const LUMA: Record<MatrixId, LumaCoefficients> = {
  bt709: { kr: 0.2126, kg: 0.7152, kb: 0.0722 },
  bt601: { kr: 0.299, kg: 0.587, kb: 0.114 },
  bt2020: { kr: 0.2627, kg: 0.678, kb: 0.0593 },
};

export type BarName = 'red' | 'yellow' | 'green' | 'cyan' | 'blue' | 'magenta';

const BAR_RGB: Record<BarName, [number, number, number]> = {
  red: [1, 0, 0],
  yellow: [1, 1, 0],
  green: [0, 1, 0],
  cyan: [0, 1, 1],
  blue: [0, 0, 1],
  magenta: [1, 0, 1],
};

export const SKIN_TONE_ANGLE_DEG = 123;

export function luma(r: number, g: number, b: number, c: LumaCoefficients): number {
  return c.kr * r + c.kg * g + c.kb * b;
}

export function chroma(
  r: number,
  g: number,
  b: number,
  c: LumaCoefficients,
): { cb: number; cr: number } {
  const y = luma(r, g, b, c);
  return {
    cb: (b - y) / (2 * (1 - c.kb)),
    cr: (r - y) / (2 * (1 - c.kr)),
  };
}

export interface ChromaTarget {
  name: BarName;
  y: number;
  cb: number;
  cr: number;
  angleDeg: number;
  radius: number;
}

export function chromaTargets(c: LumaCoefficients, level: number): ChromaTarget[] {
  return (Object.keys(BAR_RGB) as BarName[]).map((name) => {
    const [r, g, b] = BAR_RGB[name].map((v) => v * level) as [number, number, number];
    const y = luma(r, g, b, c);
    const { cb, cr } = chroma(r, g, b, c);
    return {
      name,
      y,
      cb,
      cr,
      angleDeg: (Math.atan2(cr, cb) * 180) / Math.PI,
      radius: Math.hypot(cb, cr),
    };
  });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/matrices.test.ts`
Expected: 6 passed。

- [ ] **Step 5: 写失败测试 `tests/primaries.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { PRIMARIES, linearRgbToXyz, xyzToUV, xyzToXY } from '../src/core/color/primaries';

describe('primaries', () => {
  it('pure red maps to the red primary chromaticity', () => {
    for (const id of ['rec709', 'p3', 'rec2020'] as const) {
      const [x, y] = xyzToXY(linearRgbToXyz([1, 0, 0], id));
      expect(x).toBeCloseTo(PRIMARIES[id].xy.r[0], 3);
      expect(y).toBeCloseTo(PRIMARIES[id].xy.r[1], 3);
    }
  });

  it('white maps to D65', () => {
    for (const id of ['rec709', 'p3', 'rec2020'] as const) {
      const [x, y] = xyzToXY(linearRgbToXyz([1, 1, 1], id));
      expect(x).toBeCloseTo(0.3127, 3);
      expect(y).toBeCloseTo(0.329, 3);
    }
  });

  it('CIE 1976 u-prime v-prime of D65 is (0.1978, 0.4683)', () => {
    const [u, v] = xyzToUV(linearRgbToXyz([1, 1, 1], 'rec709'));
    expect(u).toBeCloseTo(0.1978, 3);
    expect(v).toBeCloseTo(0.4683, 3);
  });
});
```

- [ ] **Step 6: 实现 `src/core/color/primaries.ts`**

```ts
export type PrimariesId = 'rec709' | 'p3' | 'rec2020';

export interface Primaries {
  readonly id: PrimariesId;
  readonly xy: { r: [number, number]; g: [number, number]; b: [number, number] };
  readonly white: [number, number];
  readonly rgbToXyz: readonly (readonly [number, number, number])[];
}

export const PRIMARIES: Record<PrimariesId, Primaries> = {
  rec709: {
    id: 'rec709',
    xy: { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06] },
    white: [0.3127, 0.329],
    rgbToXyz: [
      [0.412391, 0.357584, 0.180481],
      [0.212639, 0.715169, 0.072192],
      [0.019331, 0.119195, 0.950532],
    ],
  },
  p3: {
    id: 'p3',
    xy: { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06] },
    white: [0.3127, 0.329],
    rgbToXyz: [
      [0.486571, 0.265668, 0.198217],
      [0.228975, 0.691739, 0.079287],
      [0.0, 0.045113, 1.043944],
    ],
  },
  rec2020: {
    id: 'rec2020',
    xy: { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046] },
    white: [0.3127, 0.329],
    rgbToXyz: [
      [0.636958, 0.144617, 0.168881],
      [0.2627, 0.677998, 0.059302],
      [0.0, 0.028073, 1.060985],
    ],
  },
};

export function linearRgbToXyz(
  rgb: [number, number, number],
  id: PrimariesId,
): [number, number, number] {
  const m = PRIMARIES[id].rgbToXyz;
  const [r, g, b] = rgb;
  return [
    m[0]![0] * r + m[0]![1] * g + m[0]![2] * b,
    m[1]![0] * r + m[1]![1] * g + m[1]![2] * b,
    m[2]![0] * r + m[2]![1] * g + m[2]![2] * b,
  ];
}

export function xyzToXY(xyz: [number, number, number]): [number, number] {
  const [x, y, z] = xyz;
  const s = x + y + z;
  return s < 1e-9 ? [0, 0] : [x / s, y / s];
}

export function xyzToUV(xyz: [number, number, number]): [number, number] {
  const [x, y, z] = xyz;
  const d = x + 15 * y + 3 * z;
  return d < 1e-9 ? [0, 0] : [(4 * x) / d, (9 * y) / d];
}
```

- [ ] **Step 7: 运行确认通过**

Run: `pnpm vitest run tests/primaries.test.ts`
Expected: 3 passed（矩阵常量已离线核对：Rec.709 原色反解为 (0.6400,0.3300)/(0.3000,0.6000)/(0.1500,0.0600)，白点 (0.3127,0.3290)）。

- [ ] **Step 8: Commit**

```bash
git add src/core/color tests/matrices.test.ts tests/primaries.test.ts
git commit -m "feat(core): add luma/chroma math and primaries matrices"
```

---

### Task 3: 传递函数与码值坐标轴刻度（IRE / 8-bit / 10-bit / mV / nits）

**Files:**
- Create: `src/core/color/transfer.ts`, `src/core/scale/quantize.ts`, `src/core/scale/units.ts`
- Test: `tests/transfer.test.ts`, `tests/quantize.test.ts`, `tests/units.test.ts`

**核心约定（后续所有任务依赖）:**

纵向坐标轴是**码值空间**，轴坐标 `a = code / maxCode`，`maxCode` 为 255（8-bit）或 1023（10-bit）。这样：

- Limited 信号黑位落在 `16/255 = 6.27%` 高度，不贴底；Footroom/Headroom 是真正可见的带状区。
- 同一根轴上换标尺（IRE / code8 / code10 / mV）只是换标签，不改变几何。
- Limited 与 Full 的波形在高度上**必须可区分**，这是 range 识别能力的直接体现。

**Interfaces:**
- Produces（`transfer.ts`）:
  - `srgbToLinear(v: number): number`，`linearToSrgb(v: number): number`
  - `pqToNits(e: number): number`，`nitsToPq(l: number): number`
  - `hlgToLinear(e: number): number`
  - `xyToLinearSrgb(xy: [number, number]): [number, number, number]`
- Produces（`quantize.ts`）:
  - `type Depth = 8 | 10`
  - `interface RangeSpec { limited: boolean; depth: Depth }`
  - `FULL_SCALE: Record<Depth, number>`（255 / 1023）
  - `legalBounds(spec): { black; white; min; max }`（码值）
  - `normalizedToCode(n, spec): number` — 显示归一化 → 码值
  - `codeToNormalized(code, spec): number`
  - `codeToAxis(code, depth): number`，`axisToCode(a, depth): number`
  - `legalAxisBounds(spec): { black; white }`（轴坐标）
- Produces（`units.ts`）:
  - `type Unit = 'ire' | 'code8' | 'code10' | 'mv' | 'nits'`
  - `axisToUnit(a, unit, spec): number`
  - `unitToAxis(value, unit, spec): number`
  - `tickValues(unit, spec): number[]`（轴坐标，升序）
  - `legalBands(spec): { footroom: [number, number]; headroom: [number, number] }`（轴坐标）
  - `unitSuffix(unit): string`

- [ ] **Step 1: 写失败测试 `tests/transfer.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  hlgToLinear,
  linearToSrgb,
  nitsToPq,
  pqToNits,
  srgbToLinear,
  xyToLinearSrgb,
} from '../src/core/color/transfer';

describe('sRGB transfer', () => {
  it('round-trips', () => {
    for (const v of [0, 0.02, 0.0404, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
    }
  });
  it('mid-gray 0.5 encodes to ~0.7354 linear', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.21404, 4);
  });
});

describe('PQ (SMPTE ST 2084)', () => {
  it('round-trips across the HDR range', () => {
    for (const n of [0.01, 1, 100, 203, 1000, 4000, 10000]) {
      expect(pqToNits(nitsToPq(n))).toBeCloseTo(n, 3);
    }
  });
  it('maps signal 1.0 to 10000 nits and 0 to 0', () => {
    expect(pqToNits(0)).toBeCloseTo(0, 6);
    expect(pqToNits(1)).toBeCloseTo(10000, 1);
  });
  it('maps 100 nits to ~0.5081 signal (BT.2408 SDR reference)', () => {
    expect(nitsToPq(100)).toBeCloseTo(0.5081, 3);
  });
});

describe('HLG', () => {
  it('is monotonic and hits 1/12 at signal 0.5', () => {
    expect(hlgToLinear(0.5)).toBeCloseTo(1 / 12, 6);
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = hlgToLinear(i / 10);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});

describe('xyToLinearSrgb', () => {
  it('D65 white gives equal rgb', () => {
    const [r, g, b] = xyToLinearSrgb([0.3127, 0.329]);
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(1, 2);
    expect(b).toBeCloseTo(1, 2);
  });
});
```

- [ ] **Step 2: 实现 `src/core/color/transfer.ts`**

```ts
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const M1 = 2610 / 16384; // 0.1593017578125
const M2 = (2523 / 4096) * 128; // 78.84375
const C1 = 3424 / 4096; // 0.8359375
const C2 = 2413 / 128; // 18.8515625
const C3 = 2392 / 128; // 18.6875

export function nitsToPq(nits: number): number {
  const y = Math.max(nits, 0) / 10000;
  const p = Math.pow(y, M1);
  return Math.pow((C1 + C2 * p) / (1 + C3 * p), M2);
}

export function pqToNits(e: number): number {
  const p = Math.pow(Math.max(e, 0), 1 / M2);
  const num = Math.max(p - C1, 0);
  const den = C2 - C3 * p;
  if (den <= 0) return 10000;
  return 10000 * Math.pow(num / den, 1 / M1);
}

const HLG_A = 0.17883277;
const HLG_B = 0.28466892; // 1 - 4a
const HLG_C = 0.55991073; // 0.5 - a*ln(4a)

export function hlgToLinear(e: number): number {
  return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - HLG_C) / HLG_A) + HLG_B) / 12;
}

const XYZ_TO_LINEAR_SRGB: readonly (readonly [number, number, number])[] = [
  [3.2409699419, -1.5373831776, -0.4986107603],
  [-0.9692436363, 1.8759675015, 0.0415550574],
  [0.0556300797, -0.2039769589, 1.0569715142],
];

export function xyToLinearSrgb(xy: [number, number]): [number, number, number] {
  const [x, y] = xy;
  if (y < 1e-6) return [0, 0, 0];
  const X = x / y;
  const Y = 1;
  const Z = (1 - x - y) / y;
  const m = XYZ_TO_LINEAR_SRGB;
  return [
    m[0]![0] * X + m[0]![1] * Y + m[0]![2] * Z,
    m[1]![0] * X + m[1]![1] * Y + m[1]![2] * Z,
    m[2]![0] * X + m[2]![1] * Y + m[2]![2] * Z,
  ];
}
```

- [ ] **Step 3: 运行确认通过**

Run: `pnpm vitest run tests/transfer.test.ts`
Expected: 全部 passed。若 `pqToNits(1)` 失败，检查 `C2 - C3*p` 在 `p = 1` 时为 0.164，不应返回 10000 分支。

- [ ] **Step 4: 写失败测试 `tests/quantize.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  FULL_SCALE,
  axisMapping,
  axisToCode,
  codeToAxis,
  codeToNormalized,
  displayNormalizedToAxis,
  legalAxisBounds,
  legalBounds,
  normalizedToCode,
} from '../src/core/scale/quantize';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };
const L10 = { limited: true, depth: 10 as const };

describe('legalBounds', () => {
  it('reports black/white in code values', () => {
    expect(legalBounds(L8)).toEqual({ black: 16, white: 235, min: 0, max: 255 });
    expect(legalBounds(L10)).toEqual({ black: 64, white: 940, min: 0, max: 1023 });
    expect(legalBounds(F8)).toEqual({ black: 0, white: 255, min: 0, max: 255 });
  });
});

describe('normalized <-> code', () => {
  it('limited 8-bit maps 0 -> 16 and 1 -> 235', () => {
    expect(normalizedToCode(0, L8)).toBeCloseTo(16, 6);
    expect(normalizedToCode(1, L8)).toBeCloseTo(235, 6);
    expect(normalizedToCode(0.5, L8)).toBeCloseTo(125.5, 6);
  });
  it('limited 10-bit maps 0 -> 64 and 1 -> 940', () => {
    expect(normalizedToCode(0, L10)).toBeCloseTo(64, 6);
    expect(normalizedToCode(1, L10)).toBeCloseTo(940, 6);
  });
  it('full range spans the whole field', () => {
    expect(normalizedToCode(1, F8)).toBeCloseTo(255, 6);
    expect(normalizedToCode(0.5, F8)).toBeCloseTo(127.5, 6);
  });
  it('round-trips', () => {
    for (const spec of [L8, F8, L10]) {
      expect(codeToNormalized(normalizedToCode(0.42, spec), spec)).toBeCloseTo(0.42, 6);
    }
  });
});

describe('code <-> axis', () => {
  it('axis is code divided by full scale', () => {
    expect(FULL_SCALE[8]).toBe(255);
    expect(FULL_SCALE[10]).toBe(1023);
    expect(codeToAxis(16, 8)).toBeCloseTo(16 / 255, 9);
    expect(codeToAxis(64, 10)).toBeCloseTo(64 / 1023, 9);
    expect(axisToCode(1, 8)).toBeCloseTo(255, 9);
  });
  it('legal black sits above the floor for limited, at the floor for full', () => {
    expect(legalAxisBounds(L8).black).toBeCloseTo(16 / 255, 9);
    expect(legalAxisBounds(L8).white).toBeCloseTo(235 / 255, 9);
    expect(legalAxisBounds(F8).black).toBe(0);
    expect(legalAxisBounds(F8).white).toBe(1);
  });
  it('limited and full never collapse to the same axis position', () => {
    expect(legalAxisBounds(L8).black).toBeGreaterThan(0.06);
    expect(legalAxisBounds(L8).white).toBeLessThan(0.93);
  });
});

describe('displayNormalizedToAxis', () => {
  it('full range is the identity', () => {
    for (const v of [0, 0.25, 0.5, 1]) {
      expect(displayNormalizedToAxis(v, F8)).toBeCloseTo(v, 9);
    }
  });
  it('limited range compresses into 16/255 .. 235/255', () => {
    expect(displayNormalizedToAxis(0, L8)).toBeCloseTo(16 / 255, 9);
    expect(displayNormalizedToAxis(1, L8)).toBeCloseTo(235 / 255, 9);
    expect(displayNormalizedToAxis(0.5, L8)).toBeCloseTo(125.5 / 255, 9);
  });
  it('a display-white (1.0) limited signal does NOT reach the top of the axis', () => {
    expect(displayNormalizedToAxis(1, L8)).toBeLessThan(0.95);
    expect(displayNormalizedToAxis(0, L8)).toBeGreaterThan(0.05);
  });
  it('10-bit limited maps into 64/1023 .. 940/1023', () => {
    expect(displayNormalizedToAxis(0, L10)).toBeCloseTo(64 / 1023, 9);
    expect(displayNormalizedToAxis(1, L10)).toBeCloseTo(940 / 1023, 9);
  });
  it('axisMapping returns the shader uniform pair', () => {
    const m = axisMapping(L8);
    expect(m.black).toBeCloseTo(16 / 255, 9);
    expect(m.span).toBeCloseTo(219 / 255, 9);
    expect(m.black + m.span).toBeCloseTo(235 / 255, 9);
    expect(axisMapping(F8)).toEqual({ black: 0, span: 1 });
  });
});
```

- [ ] **Step 5: 实现 `src/core/scale/quantize.ts`**

```ts
export type Depth = 8 | 10;

export interface RangeSpec {
  readonly limited: boolean;
  readonly depth: Depth;
}

export const FULL_SCALE: Record<Depth, number> = { 8: 255, 10: 1023 };

const LEGAL: Record<Depth, [number, number]> = { 8: [16, 235], 10: [64, 940] };

export function legalBounds(spec: RangeSpec): {
  black: number;
  white: number;
  min: number;
  max: number;
} {
  const max = FULL_SCALE[spec.depth];
  const [b, w] = LEGAL[spec.depth];
  return spec.limited ? { black: b, white: w, min: 0, max } : { black: 0, white: max, min: 0, max };
}

export function normalizedToCode(n: number, spec: RangeSpec): number {
  const { black, white } = legalBounds(spec);
  return black + (white - black) * n;
}

export function codeToNormalized(code: number, spec: RangeSpec): number {
  const { black, white } = legalBounds(spec);
  return (code - black) / (white - black);
}

export function codeToAxis(code: number, depth: Depth): number {
  return code / FULL_SCALE[depth];
}

export function axisToCode(a: number, depth: Depth): number {
  return a * FULL_SCALE[depth];
}

export function legalAxisBounds(spec: RangeSpec): { black: number; white: number } {
  const { black, white } = legalBounds(spec);
  return { black: codeToAxis(black, spec.depth), white: codeToAxis(white, spec.depth) };
}

/**
 * Display-normalized signal (0..1 in the browser's legal span) mapped onto the
 * code-space axis. This is the exact contract the WGSL `blend()` helper must
 * reproduce; the unit tests below are what keeps the two in sync.
 */
export function displayNormalizedToAxis(v: number, spec: RangeSpec): number {
  return codeToAxis(normalizedToCode(v, spec), spec.depth);
}

/** Axis-space black/span pair uploaded to the accumulate shader. */
export function axisMapping(spec: RangeSpec): { black: number; span: number } {
  const { black, white } = legalAxisBounds(spec);
  return { black, span: white - black };
}
```

- [ ] **Step 6: 写失败测试 `tests/units.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { legalBands, axisToUnit, tickValues, unitSuffix, unitToAxis } from '../src/core/scale/units';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };

describe('axisToUnit', () => {
  it('IRE: legal black is 0 and legal white is 100', () => {
    expect(axisToUnit(16 / 255, 'ire', L8)).toBeCloseTo(0, 6);
    expect(axisToUnit(235 / 255, 'ire', L8)).toBeCloseTo(100, 6);
  });
  it('IRE: full range black/white are 0/100', () => {
    expect(axisToUnit(0, 'ire', F8)).toBeCloseTo(0, 6);
    expect(axisToUnit(1, 'ire', F8)).toBeCloseTo(100, 6);
  });
  it('IRE: signal above legal white reads as super-white', () => {
    expect(axisToUnit(1, 'ire', L8)).toBeCloseTo(109.13, 1);
  });
  it('code8 / code10 are pure relabels of the axis', () => {
    expect(axisToUnit(0.5, 'code8', L8)).toBeCloseTo(127.5, 6);
    expect(axisToUnit(0.5, 'code10', L8)).toBeCloseTo(511.5, 6);
  });
  it('mV is 700mV at legal white', () => {
    expect(axisToUnit(235 / 255, 'mv', L8)).toBeCloseTo(700, 4);
    expect(axisToUnit(16 / 255, 'mv', L8)).toBeCloseTo(0, 4);
  });
  it('nits follows PQ (axis equals the PQ signal)', () => {
    expect(axisToUnit(0, 'nits', L8)).toBeCloseTo(0, 6);
    expect(axisToUnit(1, 'nits', L8)).toBeCloseTo(10000, 1);
    expect(axisToUnit(0.5081, 'nits', L8)).toBeCloseTo(100, 0);
  });
});

describe('unitToAxis', () => {
  it('inverts IRE', () => {
    expect(unitToAxis(50, 'ire', L8)).toBeCloseTo((16 + 0.5 * 219) / 255, 6);
  });
  it('inverts code10', () => {
    expect(unitToAxis(511.5, 'code10', L8)).toBeCloseTo(0.5, 6);
  });
  it('inverts nits', () => {
    expect(unitToAxis(10000, 'nits', L8)).toBeCloseTo(1, 3);
  });
});

describe('tickValues', () => {
  it('IRE ticks 0..100 by 10 land inside the legal band', () => {
    const t = tickValues('ire', L8);
    expect(t.length).toBe(11);
    expect(t[0]).toBeCloseTo(16 / 255, 6);
    expect(t[10]).toBeCloseTo(235 / 255, 6);
  });
  it('IRE ticks for full range span the axis', () => {
    const t = tickValues('ire', F8);
    expect(t[0]).toBeCloseTo(0, 6);
    expect(t[10]).toBeCloseTo(1, 6);
  });
  it('code8 ticks include the legal boundaries', () => {
    const nums = tickValues('code8', L8).map((a) => Math.round(axisToUnit(a, 'code8', L8)));
    expect(nums).toContain(16);
    expect(nums).toContain(235);
  });
  it('nits ticks are ascending and within the axis', () => {
    const t = tickValues('nits', L8);
    expect(t.length).toBeGreaterThan(5);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    expect(t[t.length - 1]!).toBeLessThanOrEqual(1);
  });
});

describe('legalBands', () => {
  it('exposes footroom and headroom as axis bands', () => {
    const b = legalBands(L8);
    expect(b.footroom[0]).toBeCloseTo(0, 6);
    expect(b.footroom[1]).toBeCloseTo(16 / 255, 6);
    expect(b.headroom[0]).toBeCloseTo(235 / 255, 6);
    expect(b.headroom[1]).toBeCloseTo(1, 6);
  });
  it('is empty for full range', () => {
    expect(legalBands(F8).footroom).toEqual([0, 0]);
    expect(legalBands(F8).headroom).toEqual([0, 0]);
  });
});

describe('unitSuffix', () => {
  it('names each unit', () => {
    expect(unitSuffix('ire')).toBe('IRE');
    expect(unitSuffix('mv')).toBe('mV');
    expect(unitSuffix('nits')).toBe('nits');
  });
});
```

- [ ] **Step 7: 实现 `src/core/scale/units.ts`**

```ts
import { nitsToPq, pqToNits } from '../color/transfer';
import { codeToAxis, legalAxisBounds, legalBounds, type RangeSpec } from './quantize';

export type Unit = 'ire' | 'code8' | 'code10' | 'mv' | 'nits';

const NITS_STEPS = [0.01, 0.1, 1, 10, 100, 203, 400, 1000, 4000, 10000];

export function axisToUnit(a: number, unit: Unit, spec: RangeSpec): number {
  switch (unit) {
    case 'ire': {
      const { black, white } = legalAxisBounds(spec);
      return ((a - black) / (white - black)) * 100;
    }
    case 'code8':
      return a * 255;
    case 'code10':
      return a * 1023;
    case 'mv':
      return (axisToUnit(a, 'ire', spec) / 100) * 700;
    case 'nits':
      return pqToNits(a);
  }
}

export function unitToAxis(value: number, unit: Unit, spec: RangeSpec): number {
  switch (unit) {
    case 'ire': {
      const { black, white } = legalAxisBounds(spec);
      return black + (value / 100) * (white - black);
    }
    case 'code8':
      return value / 255;
    case 'code10':
      return value / 1023;
    case 'mv':
      return unitToAxis((value / 700) * 100, 'ire', spec);
    case 'nits':
      return nitsToPq(Math.max(value, 0));
  }
}

export function tickValues(unit: Unit, spec: RangeSpec): number[] {
  const out: number[] = [];
  const push = (a: number): void => {
    if (a >= -1e-6 && a <= 1 + 1e-6) out.push(Math.min(1, Math.max(0, a)));
  };
  switch (unit) {
    case 'ire':
      for (let v = 0; v <= 100; v += 10) push(unitToAxis(v, 'ire', spec));
      break;
    case 'code8':
      for (const v of [0, 16, 32, 64, 96, 128, 160, 192, 224, 235, 255]) push(v / 255);
      break;
    case 'code10':
      for (const v of [0, 64, 128, 256, 384, 512, 640, 768, 896, 940, 1023]) push(v / 1023);
      break;
    case 'mv':
      for (let v = 0; v <= 700; v += 70) push(unitToAxis(v, 'mv', spec));
      break;
    case 'nits':
      for (const v of NITS_STEPS) push(nitsToPq(v));
      break;
  }
  return Array.from(new Set(out.map((a) => Number(a.toFixed(6))))).sort((a, b) => a - b);
}

export function legalBands(spec: RangeSpec): {
  footroom: [number, number];
  headroom: [number, number];
} {
  if (!spec.limited) return { footroom: [0, 0], headroom: [0, 0] };
  const { black, white, min, max } = legalBounds(spec);
  return {
    footroom: [codeToAxis(min, spec.depth), codeToAxis(black, spec.depth)],
    headroom: [codeToAxis(white, spec.depth), codeToAxis(max, spec.depth)],
  };
}

export function unitSuffix(unit: Unit): string {
  switch (unit) {
    case 'ire':
      return 'IRE';
    case 'code8':
      return '8b';
    case 'code10':
      return '10b';
    case 'mv':
      return 'mV';
    case 'nits':
      return 'nits';
  }
}
```

> 说明：`nits` 直接把轴坐标当 PQ 信号 `E'` 解读（HDR 10-bit 时 `a = code/1023` 正是 PQ 编码值），因此 `pqToNits` 是精确映射而非近似。SDR 内容切到 nits 标尺只是换一组参考刻度，UI 会标注 `PQ assumed`。

- [ ] **Step 8: 运行全部核心测试**

Run: `pnpm vitest run tests/transfer.test.ts tests/quantize.test.ts tests/units.test.ts`
Expected: 全部 passed。

- [ ] **Step 9: Commit**

```bash
git add src/core/color/transfer.ts src/core/scale tests/transfer.test.ts tests/quantize.test.ts tests/units.test.ts
git commit -m "feat(core): code-space axis, transfer functions and multi-unit scales"
```


---

### Task 4: CIE 光谱轨迹与色域几何

**Files:**
- Create: `src/core/color/locus.ts`
- Test: `tests/locus.test.ts`
- 已存在（Task 3）：`src/core/color/transfer.ts`（本任务直接使用，不再修改）

**Interfaces:**
- Consumes: `PrimariesId`、`PRIMARIES`（Task 2），`srgbToLinear` / `linearToSrgb` / `xyToLinearSrgb`（Task 3）
- Produces:
  - `CIE1931_LOCUS: ReadonlyArray<[number, number]>`（380–700 nm，10 nm 步长，33 采样，CIE 1931 2° 观察者）
  - `locusPoints(): [number, number][]`（升序光谱轨迹，不含紫边）
  - `locusPath(map?): string`（SVG path，`Z` 闭合紫边）
  - `gamutTriangle(id: PrimariesId): [number, number][]`
  - `SPECTRAL_WAVELENGTHS: readonly number[]`（与 `CIE1931_LOCUS` 一一对应）

- [ ] **Step 1: 写失败测试 `tests/locus.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { CIE1931_LOCUS, SPECTRAL_WAVELENGTHS, gamutTriangle, locusPath } from '../src/core/color/locus';

describe('CIE 1931 spectral locus', () => {
  it('has 33 samples from 380 to 700 nm at 10 nm', () => {
    expect(CIE1931_LOCUS.length).toBe(33);
    expect(SPECTRAL_WAVELENGTHS.length).toBe(33);
    expect(SPECTRAL_WAVELENGTHS[0]).toBe(380);
    expect(SPECTRAL_WAVELENGTHS[32]).toBe(700);
  });

  it('starts at the deep-violet end and ends at the 700 nm red end', () => {
    expect(CIE1931_LOCUS[0]).toEqual([0.1741, 0.005]);
    expect(CIE1931_LOCUS[CIE1931_LOCUS.length - 1]).toEqual([0.7347, 0.2653]);
  });

  it('peaks just above y = 0.83 near 520 nm', () => {
    const idx = SPECTRAL_WAVELENGTHS.indexOf(520);
    expect(CIE1931_LOCUS[idx]![1]).toBeCloseTo(0.8338, 4);
    const maxY = Math.max(...CIE1931_LOCUS.map((p) => p[1]));
    expect(maxY).toBeCloseTo(0.8338, 4);
  });

  it('has the 500 nm cyan tip at x = 0.0082', () => {
    const idx = SPECTRAL_WAVELENGTHS.indexOf(500);
    expect(CIE1931_LOCUS[idx]).toEqual([0.0082, 0.5384]);
  });

  it('keeps every sample inside the visible horseshoe box', () => {
    for (const [x, y] of CIE1931_LOCUS) {
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(0.75);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.84);
    }
  });

  it('x falls to a 500 nm minimum then rises (a real curve, not a box)', () => {
    const xs = CIE1931_LOCUS.map((p) => p[0]);
    const minIdx = xs.indexOf(Math.min(...xs));
    expect(SPECTRAL_WAVELENGTHS[minIdx]).toBe(500);
    expect(xs[minIdx]).toBeLessThan(0.01);
    expect(xs[xs.length - 1]!).toBeGreaterThan(0.7);
  });
});

describe('locusPath', () => {
  it('starts with M and closes with Z', () => {
    const p = locusPath();
    expect(p.startsWith('M')).toBe(true);
    expect(p.endsWith('Z')).toBe(true);
  });

  it('honours the provided mapping function', () => {
    const p = locusPath(([x, y]) => [x * 100, y * 100]);
    expect(p.startsWith('M17.4100,0.5000')).toBe(true);
  });
});

describe('gamutTriangle', () => {
  it('returns the primaries in R, G, B order', () => {
    expect(gamutTriangle('rec709')).toEqual([
      [0.64, 0.33],
      [0.3, 0.6],
      [0.15, 0.06],
    ]);
    expect(gamutTriangle('rec2020')[0]).toEqual([0.708, 0.292]);
  });

  it('every primaries triangle is inside the locus bounding box', () => {
    for (const id of ['rec709', 'p3', 'rec2020'] as const) {
      for (const [x, y] of gamutTriangle(id)) {
        expect(x).toBeGreaterThanOrEqual(0.13);
        expect(x).toBeLessThanOrEqual(0.71);
        expect(y).toBeGreaterThanOrEqual(0.04);
        expect(y).toBeLessThanOrEqual(0.8);
      }
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/locus.test.ts`
Expected: FAIL — `Cannot find module '../src/core/color/locus'`。

- [ ] **Step 3: 实现 `src/core/color/locus.ts`**

```ts
import { PRIMARIES, type PrimariesId } from './primaries';

/** Wavelength (nm) for each entry of CIE1931_LOCUS. */
export const SPECTRAL_WAVELENGTHS: readonly number[] = Array.from(
  { length: 33 },
  (_, i) => 380 + i * 10,
);

/** CIE 1931 2° observer chromaticity, 380..700 nm in 10 nm steps. */
export const CIE1931_LOCUS: ReadonlyArray<[number, number]> = [
  [0.1741, 0.005],  // 380
  [0.1738, 0.0049], // 390
  [0.1733, 0.0048], // 400
  [0.1726, 0.0048], // 410
  [0.1714, 0.0051], // 420
  [0.1689, 0.0069], // 430
  [0.1644, 0.0109], // 440
  [0.1566, 0.0177], // 450
  [0.144, 0.0297],  // 460
  [0.1241, 0.0578], // 470
  [0.0913, 0.1327], // 480
  [0.0454, 0.295],  // 490
  [0.0082, 0.5384], // 500
  [0.0139, 0.7502], // 510
  [0.0743, 0.8338], // 520
  [0.1547, 0.8059], // 530
  [0.2296, 0.7543], // 540
  [0.3016, 0.6923], // 550
  [0.3731, 0.6245], // 560
  [0.4441, 0.5547], // 570
  [0.5125, 0.4866], // 580
  [0.5752, 0.4242], // 590
  [0.627, 0.3725],  // 600
  [0.6658, 0.334],  // 610
  [0.6915, 0.3083], // 620
  [0.7079, 0.292],  // 630
  [0.719, 0.2809],  // 640
  [0.726, 0.274],   // 650
  [0.73, 0.27],     // 660
  [0.732, 0.268],   // 670
  [0.7334, 0.2666], // 680
  [0.7344, 0.2656], // 690
  [0.7347, 0.2653], // 700
];

export function locusPoints(): [number, number][] {
  return CIE1931_LOCUS.map(([x, y]) => [x, y]);
}

export function gamutTriangle(id: PrimariesId): [number, number][] {
  const { xy } = PRIMARIES[id];
  return [[...xy.r], [...xy.g], [...xy.b]];
}

export function locusPath(
  map: (xy: [number, number]) => [number, number] = ([x, y]) => [x, y],
): string {
  const [sx, sy] = map(CIE1931_LOCUS[0]!);
  const parts = [`M${sx.toFixed(4)},${sy.toFixed(4)}`];
  for (const p of CIE1931_LOCUS.slice(1)) {
    const [x, y] = map(p);
    parts.push(`L${x.toFixed(4)},${y.toFixed(4)}`);
  }
  return `${parts.join('')}Z`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/locus.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add src/core/color/locus.ts tests/locus.test.ts
git commit -m "feat(core): add CIE 1931 spectral locus and gamut triangles"
```

---

### Task 5: Video Range 识别与错标诊断

**Files:**
- Create: `src/core/range-detector.ts`, `src/core/scopes/stats.ts`
- Test: `tests/range-detector.test.ts`

**Interfaces:**
- Produces:
  - `type RangeMode = 'auto' | 'limited' | 'full'`
  - `interface ColorSpaceInfo { fullRange: boolean | null; matrix: MatrixId | null; primaries: PrimariesId | null; transfer: TransferId; format: string | null; source: 'webcodecs' | 'capture' | 'unknown' }`
  - `interface LumaStats { p001: number; p999: number; belowBlack: number; aboveWhite: number }`
  - `histogramStats(hist: Uint32Array, total: number): LumaStats`
  - `type RangeWarning = null | 'limited-treated-as-full' | 'full-treated-as-limited'`
  - `class RangeDetector { constructor(frameThreshold?: number); push(info: ColorSpaceInfo, stats: LumaStats): RangeDiagnosis; reset(): void }`
  - `interface RangeDiagnosis { effective: 'limited' | 'full'; warning: RangeWarning; confidence: number; source: ColorSpaceInfo['source'] | 'heuristic' }`

- [ ] **Step 1: 写失败测试 `tests/range-detector.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { RangeDetector } from '../src/core/range-detector';
import { histogramStats } from '../src/core/scopes/stats';

const info = (fullRange: boolean | null, source: 'webcodecs' | 'capture' | 'unknown' = 'webcodecs') => ({
  fullRange,
  matrix: 'bt709' as const,
  primaries: 'rec709' as const,
  transfer: 'bt709' as const,
  format: 'NV12',
  source,
});

const stats = (p001: number, p999: number, belowBlack = 0, aboveWhite = 0) => ({
  p001,
  p999,
  belowBlack,
  aboveWhite,
});

describe('histogramStats', () => {
  it('finds the 0.1% and 99.9% percentiles of a spike', () => {
    const hist = new Uint32Array(256);
    hist[50] = 1000;
    const s = histogramStats(hist, 1000);
    expect(s.p001).toBeCloseTo(50 / 255, 3);
    expect(s.p999).toBeCloseTo(50 / 255, 3);
    expect(s.belowBlack).toBe(0);
    expect(s.aboveWhite).toBe(0);
  });

  it('counts pixels below legal black and above legal white', () => {
    const hist = new Uint32Array(256);
    hist[8] = 50; // below 16/255
    hist[250] = 50; // above 235/255
    const s = histogramStats(hist, 200);
    expect(s.belowBlack).toBeCloseTo(0.25, 6);
    expect(s.aboveWhite).toBeCloseTo(0.25, 6);
  });
});

describe('RangeDetector', () => {
  it('trusts webcodecs metadata immediately', () => {
    const d = new RangeDetector();
    const r = d.push(info(false), stats(0, 1));
    expect(r.effective).toBe('limited');
    expect(r.source).toBe('webcodecs');
  });

  it('warns when full is declared but signal sits in legal window', () => {
    const d = new RangeDetector(3);
    let r = d.push(info(true), stats(0.06, 0.92));
    expect(r.warning).toBeNull();
    d.push(info(true), stats(0.06, 0.92));
    r = d.push(info(true), stats(0.06, 0.92));
    expect(r.warning).toBe('limited-treated-as-full');
  });

  it('warns when limited is declared but signal exceeds legal window', () => {
    const d = new RangeDetector(3);
    for (let i = 0; i < 3; i++) {
      d.push(info(false), stats(0.005, 0.995, 0.04, 0.03));
    }
    const r = d.push(info(false), stats(0.005, 0.995, 0.04, 0.03));
    expect(r.warning).toBe('full-treated-as-limited');
  });

  it('does not warn on a normally exposed full-range video', () => {
    const d = new RangeDetector(3);
    let r = d.push(info(true), stats(0.002, 0.99, 0.001, 0.001));
    for (let i = 0; i < 3; i++) r = d.push(info(true), stats(0.002, 0.99, 0.001, 0.001));
    expect(r.warning).toBeNull();
  });

  it('falls back to heuristics when metadata is missing', () => {
    const d = new RangeDetector();
    const r = d.push(info(null, 'capture'), stats(0.06, 0.92));
    expect(r.effective).toBe('limited');
    expect(r.source).toBe('heuristic');
  });

  it('honours hysteresis: single black frame does not trigger a warning', () => {
    const d = new RangeDetector(3);
    let r = d.push(info(true), stats(0.002, 0.99));
    r = d.push(info(true), stats(0.5, 0.52));
    r = d.push(info(true), stats(0.002, 0.99));
    expect(r.warning).toBeNull();
  });
});
```

- [ ] **Step 2: 实现 `src/core/scopes/stats.ts`**

```ts
export interface LumaStats {
  p001: number;
  p999: number;
  belowBlack: number;
  aboveWhite: number;
}

const BLACK_NORM = 16 / 255;
const WHITE_NORM = 235 / 255;

export function histogramStats(hist: Uint32Array, total: number): LumaStats {
  const bins = hist.length;
  const find = (targetFraction: number): number => {
    const target = total * targetFraction;
    let acc = 0;
    for (let i = 0; i < bins; i++) {
      acc += hist[i]!;
      if (acc >= target) return i / (bins - 1);
    }
    return 1;
  };
  let below = 0;
  let above = 0;
  for (let i = 0; i < bins; i++) {
    const n = hist[i]!;
    if (i / (bins - 1) < BLACK_NORM) below += n;
    if (i / (bins - 1) > WHITE_NORM) above += n;
  }
  return {
    p001: find(0.001),
    p999: find(0.999),
    belowBlack: total === 0 ? 0 : below / total,
    aboveWhite: total === 0 ? 0 : above / total,
  };
}
```

- [ ] **Step 3: 实现 `src/core/range-detector.ts`**

```ts
import type { MatrixId } from './color/matrices';
import type { PrimariesId } from './color/primaries';
import type { LumaStats } from './scopes/stats';

export type TransferId = 'bt709' | 'srgb' | 'pq' | 'hlg' | 'unknown';
export type RangeMode = 'auto' | 'limited' | 'full';
export type RangeWarning = null | 'limited-treated-as-full' | 'full-treated-as-limited';

export interface ColorSpaceInfo {
  fullRange: boolean | null;
  matrix: MatrixId | null;
  primaries: PrimariesId | null;
  transfer: TransferId;
  format: string | null;
  source: 'webcodecs' | 'capture' | 'unknown';
}

export interface RangeDiagnosis {
  effective: 'limited' | 'full';
  warning: RangeWarning;
  confidence: number;
  source: ColorSpaceInfo['source'] | 'heuristic';
}

const LEGAL_LO = 0.045;
const LEGAL_HI = 0.085;
const LEGAL_P999_LO = 0.9;
const LEGAL_P999_HI = 0.94;

export class RangeDetector {
  private consecutive = 0;
  private pendingWarning: RangeWarning = null;
  private locked: RangeWarning = null;
  private last: RangeDiagnosis = {
    effective: 'limited',
    warning: null,
    confidence: 0,
    source: 'unknown',
  };

  constructor(private readonly frameThreshold = 3) {}

  reset(): void {
    this.consecutive = 0;
    this.pendingWarning = null;
    this.locked = null;
  }

  push(info: ColorSpaceInfo, stats: LumaStats): RangeDiagnosis {
    const hasMeta = info.fullRange !== null;
    const effective: 'limited' | 'full' = hasMeta
      ? info.fullRange
        ? 'full'
        : 'limited'
      : this.inferRange(stats);

    const candidate = this.classify(effective, stats);
    if (candidate === this.pendingWarning) {
      this.consecutive += 1;
      if (this.consecutive >= this.frameThreshold) this.locked = candidate;
    } else {
      this.pendingWarning = candidate;
      this.consecutive = candidate === null ? 0 : 1;
      if (candidate === null) this.locked = null;
    }

    const confidence = hasMeta ? 1 : 0.6;
    this.last = {
      effective,
      warning: this.locked,
      confidence,
      source: hasMeta ? info.source : 'heuristic',
    };
    return this.last;
  }

  get current(): RangeDiagnosis {
    return this.last;
  }

  private inferRange(stats: LumaStats): 'limited' | 'full' {
    const looksLegal =
      stats.p001 >= LEGAL_LO && stats.p001 <= LEGAL_HI &&
      stats.p999 >= LEGAL_P999_LO && stats.p999 <= LEGAL_P999_HI;
    return looksLegal ? 'limited' : 'full';
  }

  private classify(effective: 'limited' | 'full', stats: LumaStats): RangeWarning {
    const looksLegal =
      stats.p001 >= LEGAL_LO && stats.p001 <= LEGAL_HI &&
      stats.p999 >= LEGAL_P999_LO && stats.p999 <= LEGAL_P999_HI;
    const looksFull = stats.p001 <= 0.02 && stats.p999 >= 0.98 &&
      (stats.belowBlack > 0.002 || stats.aboveWhite > 0.002);

    if (effective === 'full' && looksLegal) return 'limited-treated-as-full';
    if (effective === 'limited' && looksFull) return 'full-treated-as-limited';
    return null;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/range-detector.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add src/core/range-detector.ts src/core/scopes/stats.ts tests/range-detector.test.ts
git commit -m "feat(core): detect video range from metadata with mismatch heuristics"
```

---

### Task 6: CPU 参考实现（测试基准 + Canvas2D 降级）

**Files:**
- Create: `src/core/scopes/reference.ts`
- Test: `tests/reference.test.ts`

**为什么需要 CPU 实现:** GPU shader 无法单测。这里是**唯一权威定义**——Task 8 的 WGSL 必须逐位复现它的索引与取整约定；不一致就说明 shader 有 bug。它同时是 WebGPU 不可用时的降级路径。

**Interfaces:**
- Consumes: `LumaCoefficients` / `LUMA`（Task 2），`linearRgbToXyz` / `xyzToXY` / `xyzToUV` / `PrimariesId`（Task 2），`srgbToLinear`（Task 3），`axisMapping` / `RangeSpec`（Task 3）
- Produces:
  - `interface AxisMap { black: number; span: number }`
  - `const FULL_AXIS: AxisMap`（`{ black: 0, span: 1 }`）
  - `type WaveChannel = 0 | 1 | 2 | 3 | 4`（0 = Y，1/2/3 = R/G/B，4 = 三通道同时写三个平面）
  - `interface WaveformResult { cols: number; bins: number; planes: number; density: Uint32Array }`
  - `computeWaveform(rgba, w, h, cols, bins, c, channel, map?): WaveformResult`
  - `computeVectorscope(rgba, w, h, size, c, zoom?): Uint32Array`
  - `computeCie(rgba, w, h, size, primaries, coord): Uint32Array`
  - `CIE_BOUNDS: Record<'xy' | 'uv', [number, number, number, number]>`（UI 层复用，避免两处常量漂移）

**索引约定（GPU 必须一致）:**
```
density[plane * cols * bins + bin * cols + col]
bin  = clamp(floor(axis * bins), 0, bins - 1)
col  = clamp(floor(x / w * cols), 0, cols - 1)
axis = map.black + v * map.span      // v 为显示归一化 0..1
```

- [ ] **Step 1: 写失败测试 `tests/reference.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { LUMA } from '../src/core/color/matrices';
import { axisMapping } from '../src/core/scale/quantize';
import {
  FULL_AXIS,
  computeCie,
  computeVectorscope,
  computeWaveform,
} from '../src/core/scopes/reference';

const L8 = { limited: true, depth: 8 as const };
const F8 = { limited: false, depth: 8 as const };

function rgba(...px: [number, number, number][]): Uint8Array {
  const out = new Uint8Array(px.length * 4);
  px.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

describe('computeWaveform on a full-range axis', () => {
  it('puts mid-gray in the middle bin of every column', () => {
    const img = rgba([128, 128, 128], [128, 128, 128]);
    const r = computeWaveform(img, 2, 1, 2, 256, LUMA.bt709, 0, FULL_AXIS);
    const bin = Math.floor((128 / 255) * 256);
    expect(bin).toBe(128);
    expect(r.density[bin * 2 + 0]).toBe(1);
    expect(r.density[bin * 2 + 1]).toBe(1);
  });

  it('black and white land in the first and last bin', () => {
    const img = rgba([0, 0, 0], [255, 255, 255]);
    const r = computeWaveform(img, 2, 1, 2, 256, LUMA.bt709, 0, FULL_AXIS);
    expect(r.density[0]).toBe(1);
    expect(r.density[255 * 2 + 1]).toBe(1);
  });

  it('column index follows the horizontal position', () => {
    const img = rgba([10, 10, 10], [10, 10, 10], [10, 10, 10], [10, 10, 10]);
    const r = computeWaveform(img, 4, 1, 2, 64, LUMA.bt709, 0, FULL_AXIS);
    const bin = Math.floor((10 / 255) * 64);
    expect(r.density[bin * 2 + 0]).toBe(2);
    expect(r.density[bin * 2 + 1]).toBe(2);
  });
});

describe('computeWaveform on a limited-range axis', () => {
  const limitedAxis = () => axisMapping(L8);

  it('display mid-gray maps below the axis midpoint (legal compression)', () => {
    const img = rgba([128, 128, 128]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    const axis = (16 + 219 * (128 / 255)) / 255;
    const bin = Math.floor(axis * 256);
    expect(bin).toBe(126);
    expect(r.density[bin]).toBe(1);
  });

  it('display black sits at bin 16, not bin 0 (footroom is visible)', () => {
    const img = rgba([0, 0, 0]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    expect(r.density[0]).toBe(0);
    expect(r.density[16]).toBe(1);
  });

  it('display white sits at bin 235, not bin 255 (headroom is visible)', () => {
    const img = rgba([255, 255, 255]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    expect(r.density[255]).toBe(0);
    expect(r.density[235]).toBe(1);
  });

  it('limited and full axes never produce the same bin for white', () => {
    const img = rgba([255, 255, 255]);
    const a = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, limitedAxis());
    const b = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, axisMapping(F8));
    const binOf = (d: Uint32Array): number => d.findIndex((n) => n > 0);
    expect(binOf(a.density)).toBe(235);
    expect(binOf(b.density)).toBe(255);
  });
});

describe('computeWaveform channels and planes', () => {
  it('a single selected channel writes plane 0 only', () => {
    const img = rgba([255, 0, 0], [255, 0, 0]);
    const r = computeWaveform(img, 2, 1, 2, 256, LUMA.bt709, 1, FULL_AXIS);
    expect(r.planes).toBe(1);
    expect(r.density.length).toBe(2 * 256);
    expect(r.density[255 * 2 + 0]).toBe(1);
    expect(r.density[0]).toBe(0);
  });

  it('channel 4 writes all three planes in one pass', () => {
    const img = rgba([255, 0, 0]);
    const r = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 4, FULL_AXIS);
    const stride = 1 * 256;
    expect(r.planes).toBe(3);
    expect(r.density[0 * stride + 255]).toBe(1); // R
    expect(r.density[1 * stride + 0]).toBe(1); // G
    expect(r.density[2 * stride + 0]).toBe(1); // B
  });

  it('luma uses the matrix coefficients, not a fixed 0.299/0.587', () => {
    const img = rgba([0, 255, 0]);
    const bt709 = computeWaveform(img, 1, 1, 1, 256, LUMA.bt709, 0, FULL_AXIS);
    const bt601 = computeWaveform(img, 1, 1, 1, 256, LUMA.bt601, 0, FULL_AXIS);
    const binOf = (d: Uint32Array): number => d.findIndex((n) => n > 0);
    expect(binOf(bt709.density)).toBe(Math.floor(0.7152 * 256));
    expect(binOf(bt601.density)).toBe(Math.floor(0.587 * 256));
    expect(binOf(bt709.density)).not.toBe(binOf(bt601.density));
  });

  it('clamps out-of-range values instead of writing out of bounds', () => {
    const img = rgba([255, 255, 255]);
    const r = computeWaveform(img, 1, 1, 1, 16, LUMA.bt709, 0, { black: 0, span: 4 });
    expect(r.density[15]).toBe(1);
    expect(r.density.length).toBe(16);
  });
});

describe('computeVectorscope', () => {
  it('neutral gray sits at the exact center', () => {
    const size = 64;
    const r = computeVectorscope(rgba([128, 128, 128]), 1, 1, size, LUMA.bt709);
    expect(r[Math.floor(size / 2) * size + Math.floor(size / 2)]).toBe(1);
  });

  it('red lands up and left of center (Cr > 0, Cb < 0)', () => {
    const size = 128;
    const r = computeVectorscope(rgba([255, 0, 0]), 1, 1, size, LUMA.bt709);
    let found = -1;
    for (let i = 0; i < r.length; i++) if (r[i]! > 0) found = i;
    expect(found).toBeGreaterThanOrEqual(0);
    const x = found % size;
    const y = Math.floor(found / size);
    expect(x).toBeLessThan(size / 2);
    expect(y).toBeLessThan(size / 2);
  });

  it('zoom moves the same colour further from centre', () => {
    const size = 256;
    const img = rgba([200, 120, 90]);
    const one = computeVectorscope(img, 1, 1, size, LUMA.bt709, 1);
    const two = computeVectorscope(img, 1, 1, size, LUMA.bt709, 2);
    const find = (d: Uint32Array): [number, number] => {
      const i = d.findIndex((n) => n > 0);
      return [i % size, Math.floor(i / size)];
    };
    const [x1, y1] = find(one);
    const [x2, y2] = find(two);
    const half = size / 2;
    expect(Math.hypot(x2 - half, y2 - half)).toBeGreaterThan(
      Math.hypot(x1 - half, y1 - half) * 1.5,
    );
  });

  it('BT.709 red sits near 103 degrees from +Cb', () => {
    const size = 512;
    const r = computeVectorscope(rgba([255, 0, 0]), 1, 1, size, LUMA.bt709);
    const i = r.findIndex((n) => n > 0);
    const dx = (i % size) - size / 2;
    const dy = size / 2 - Math.floor(i / size);
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    expect(deg).toBeGreaterThan(100);
    expect(deg).toBeLessThan(106);
  });
});

describe('computeCie', () => {
  it('neutral white lands on D65', () => {
    const size = 512;
    const r = computeCie(rgba([255, 255, 255]), 1, 1, size, 'rec709', 'xy');
    const i = r.findIndex((n) => n > 0);
    const x = ((i % size) / size) * 0.8;
    const y = ((size - Math.floor(i / size)) / size) * 0.9;
    expect(x).toBeCloseTo(0.3127, 2);
    expect(y).toBeCloseTo(0.329, 2);
  });

  it('pure red lands on the Rec.709 red primary', () => {
    const size = 1024;
    const r = computeCie(rgba([255, 0, 0]), 1, 1, size, 'rec709', 'xy');
    const i = r.findIndex((n) => n > 0);
    const x = ((i % size) / size) * 0.8;
    const y = ((size - Math.floor(i / size)) / size) * 0.9;
    expect(x).toBeCloseTo(0.64, 1);
    expect(y).toBeCloseTo(0.33, 1);
  });

  it('black contributes nothing (no chromaticity defined)', () => {
    const r = computeCie(rgba([0, 0, 0]), 1, 1, 64, 'rec709', 'xy');
    expect(r.every((n) => n === 0)).toBe(true);
  });

  it('u-prime v-prime mode uses its own bounds', () => {
    const size = 512;
    const r = computeCie(rgba([255, 255, 255]), 1, 1, size, 'rec709', 'uv');
    const i = r.findIndex((n) => n > 0);
    const u = ((i % size) / size) * 0.62;
    const v = ((size - Math.floor(i / size)) / size) * 0.6;
    expect(u).toBeCloseTo(0.1978, 2);
    expect(v).toBeCloseTo(0.4683, 2);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/reference.test.ts`
Expected: FAIL — `Failed to resolve import "../src/core/scopes/reference"`。

- [ ] **Step 3: 实现 `src/core/scopes/reference.ts`**

```ts
import type { LumaCoefficients } from '../color/matrices';
import { linearRgbToXyz, xyzToUV, xyzToXY, type PrimariesId } from '../color/primaries';
import { srgbToLinear } from '../color/transfer';

export interface AxisMap {
  black: number;
  span: number;
}

export const FULL_AXIS: AxisMap = { black: 0, span: 1 };

export type WaveChannel = 0 | 1 | 2 | 3 | 4;

export interface WaveformResult {
  cols: number;
  bins: number;
  planes: number;
  density: Uint32Array;
}

function channelValue(
  r: number,
  g: number,
  b: number,
  c: LumaCoefficients,
  channel: 0 | 1 | 2 | 3,
): number {
  switch (channel) {
    case 1:
      return r;
    case 2:
      return g;
    case 3:
      return b;
    default:
      return c.kr * r + c.kg * g + c.kb * b;
  }
}

function axisBin(v: number, map: AxisMap, bins: number): number {
  const axis = map.black + v * map.span;
  const bin = Math.floor(axis * bins);
  return bin < 0 ? 0 : bin > bins - 1 ? bins - 1 : bin;
}

/** `noUncheckedIndexedAccess` makes `density[i] += 1` a type error; bump explicitly. */
function bump(density: Uint32Array, index: number): void {
  density[index] = (density[index] ?? 0) + 1;
}

export function computeWaveform(
  rgba: Uint8Array,
  w: number,
  h: number,
  cols: number,
  bins: number,
  c: LumaCoefficients,
  channel: WaveChannel,
  map: AxisMap = FULL_AXIS,
): WaveformResult {
  const planes = channel === 4 ? 3 : 1;
  const density = new Uint32Array(planes * cols * bins);
  const stride = cols * bins;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i]! / 255;
      const g = rgba[i + 1]! / 255;
      const b = rgba[i + 2]! / 255;
      const col = Math.min(cols - 1, Math.floor((x / w) * cols));
      if (channel === 4) {
        bump(density, 0 * stride + axisBin(r, map, bins) * cols + col);
        bump(density, 1 * stride + axisBin(g, map, bins) * cols + col);
        bump(density, 2 * stride + axisBin(b, map, bins) * cols + col);
      } else {
        // A single selected channel always lands in plane 0: the density buffer
        // only allocates the planes the resolve pass will actually read, so
        // writing plane 1 here would run past the end of the buffer.
        const v = channelValue(r, g, b, c, channel);
        bump(density, axisBin(v, map, bins) * cols + col);
      }
    }
  }
  return { cols, bins, planes, density };
}

export function computeVectorscope(
  rgba: Uint8Array,
  w: number,
  h: number,
  size: number,
  c: LumaCoefficients,
  zoom = 1,
): Uint32Array {
  const density = new Uint32Array(size * size);
  const half = size / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i]! / 255;
      const g = rgba[i + 1]! / 255;
      const b = rgba[i + 2]! / 255;
      const yy = c.kr * r + c.kg * g + c.kb * b;
      const cb = (b - yy) / (2 * (1 - c.kb));
      const cr = (r - yy) / (2 * (1 - c.kr));
      const px = Math.floor(half + cb * zoom * size);
      const py = Math.floor(half - cr * zoom * size);
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      bump(density, py * size + px);
    }
  }
  return density;
}

export const CIE_BOUNDS: Record<'xy' | 'uv', [number, number, number, number]> = {
  xy: [0, 0, 0.8, 0.9],
  uv: [0, 0, 0.62, 0.6],
};

export function computeCie(
  rgba: Uint8Array,
  w: number,
  h: number,
  size: number,
  primaries: PrimariesId,
  coord: 'xy' | 'uv',
): Uint32Array {
  const density = new Uint32Array(size * size);
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lin: [number, number, number] = [
        srgbToLinear(rgba[i]! / 255),
        srgbToLinear(rgba[i + 1]! / 255),
        srgbToLinear(rgba[i + 2]! / 255),
      ];
      const xyz = linearRgbToXyz(lin, primaries);
      const sum = xyz[0] + xyz[1] + xyz[2];
      if (sum < 1e-6) continue;
      const [cx, cy] = coord === 'xy' ? xyzToXY(xyz) : xyzToUV(xyz);
      const px = Math.floor(((cx - x0) / (x1 - x0)) * size);
      const py = Math.floor(size - ((cy - y0) / (y1 - y0)) * size);
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      bump(density, py * size + px);
    }
  }
  return density;
}

```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm vitest run tests/reference.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add src/core/scopes/reference.ts tests/reference.test.ts
git commit -m "test(core): add CPU reference scope kernels as the GPU oracle"
```

---

### Task 7: WebGPU 设备、信号纹理与内置测试台

**Files:**
- Create: `src/gpu/device.ts`, `src/gpu/signal-texture.ts`, `public/test-harness.html`, `public/harness.js`
- Test: `tests/signal-texture.test.ts`
- Modify: `vite.config.ts`（增加 `gpu` 入口，让测试台能 import）

**Interfaces:**
- Produces:
  - `interface CanvasGpu { device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat }`
  - `getDevice(): Promise<GPUDevice>` —— **全页共享一个 device**（多个示波器共用一个 `GPUDevice`，只各自持 canvas context）
  - `initCanvas(canvas: HTMLCanvasElement): Promise<CanvasGpu>`
  - `configureCanvas(gpu: CanvasGpu, width: number, height: number): void`（DPR 感知的 canvas 尺寸同步）
  - `shouldUpload(readyState: number, currentTime: number, lastKey: number, minDelta?: number): boolean` —— 纯函数，可单测
  - `class SignalTexture { constructor(device, source: HTMLVideoElement | VideoFrame); readonly texture; readonly width; readonly height; update(mediaTime?): boolean; destroy() }`

**为什么共享 device:** 每个 canvas 各建一个 `GPUDevice` 会重复分配队列与内存池，四个示波器就是四份。一个 device + 四个 context 是 Chromium 推荐做法。

- [ ] **Step 1: 写失败测试 `tests/signal-texture.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { shouldUpload } from '../src/gpu/signal-texture';

describe('shouldUpload', () => {
  it('refuses before the video has current data', () => {
    expect(shouldUpload(1, 1.0, -1)).toBe(false);
    expect(shouldUpload(0, 0, -1)).toBe(false);
  });

  it('accepts the first frame once ready', () => {
    expect(shouldUpload(2, 0.0, -1)).toBe(true);
    expect(shouldUpload(4, 1.5, -1)).toBe(true);
  });

  it('skips a frame that has already been uploaded', () => {
    expect(shouldUpload(4, 1.5, 1.5)).toBe(false);
  });

  it('skips sub-frame jitter by default', () => {
    expect(shouldUpload(4, 1.5001, 1.5)).toBe(false);
  });

  it('accepts a genuinely new frame', () => {
    expect(shouldUpload(4, 1.5417, 1.5)).toBe(true);
  });

  it('honours a custom minimum delta', () => {
    expect(shouldUpload(4, 1.62, 1.5, 0.2)).toBe(false);
    expect(shouldUpload(4, 1.72, 1.5, 0.2)).toBe(true);
  });

  it('still accepts frames that went backwards (seek)', () => {
    expect(shouldUpload(4, 0.2, 8.0)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/signal-texture.test.ts`
Expected: FAIL — cannot resolve `../src/gpu/signal-texture`。

- [ ] **Step 3: 实现 `src/gpu/device.ts`**

```ts
export interface CanvasGpu {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

let devicePromise: Promise<GPUDevice> | null = null;

/** One device for the whole page; every scope canvas shares it. */
export function getDevice(): Promise<GPUDevice> {
  if (!devicePromise) {
    devicePromise = (async () => {
      if (!('gpu' in navigator)) throw new Error('WebGPU unavailable');
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
      if (!adapter) throw new Error('No GPU adapter');
      return adapter.requestDevice();
    })();
    devicePromise.catch(() => {
      devicePromise = null;
    });
  }
  return devicePromise;
}

export async function initCanvas(canvas: HTMLCanvasElement): Promise<CanvasGpu> {
  const device = await getDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('webgpu context unavailable');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });
  return { device, context, format };
}

/** Keep the backing store in sync with CSS size and DPR. Returns true if resized. */
export function configureCanvas(gpu: CanvasGpu, cssWidth: number, cssHeight: number): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  const canvas = gpu.context.canvas as HTMLCanvasElement;
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' });
  return true;
}
```

- [ ] **Step 4: 实现 `src/gpu/signal-texture.ts`**

```ts
type Source = HTMLVideoElement | VideoFrame;

const FRAME_EPSILON = 1e-4;

/**
 * True when the current video frame has not been uploaded yet.
 * A video element reports readyState < 2 until it has decodable data.
 */
export function shouldUpload(
  readyState: number,
  currentTime: number,
  lastKey: number,
  minDelta = FRAME_EPSILON,
): boolean {
  if (readyState < 2) return false;
  if (lastKey < 0) return true;
  return Math.abs(currentTime - lastKey) >= minDelta;
}

export class SignalTexture {
  readonly texture: GPUTexture;
  readonly width: number;
  readonly height: number;
  private readonly device: GPUDevice;
  private lastFrameKey = -1;
  private closed = false;

  constructor(device: GPUDevice, private readonly source: Source) {
    this.device = device;
    this.width =
      source instanceof HTMLVideoElement ? source.videoWidth : source.displayWidth;
    this.height =
      source instanceof HTMLVideoElement ? source.videoHeight : source.displayHeight;
    if (this.width === 0 || this.height === 0) throw new Error('source has no dimensions');
    this.texture = device.createTexture({
      size: { width: this.width, height: this.height },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
  }

  update(mediaTime?: number): boolean {
    if (this.closed) return false;
    if (this.source instanceof HTMLVideoElement) {
      const t = mediaTime ?? this.source.currentTime;
      if (!shouldUpload(this.source.readyState, t, this.lastFrameKey)) return false;
      this.lastFrameKey = t;
    }
    try {
      this.device.queue.copyExternalImageToTexture(
        { source: this.source, flipY: false },
        { texture: this.texture },
        { width: this.width, height: this.height },
      );
    } catch {
      return false;
    }
    return true;
  }

  /** VideoFrame sources must be closed by the caller; this only frees the texture. */
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.texture.destroy();
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `pnpm vitest run tests/signal-texture.test.ts`
Expected: 7 passed。

- [ ] **Step 6: 写 `public/test-harness.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Video Scopes Test Harness</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; background: #0b0f12; color: #b9c6d0; font: 12px/1.5 ui-monospace, monospace; }
      h1 { font-size: 13px; font-weight: 500; margin: 16px; color: #d7e3ec; }
      .row { display: flex; gap: 16px; padding: 0 16px 16px; flex-wrap: wrap; }
      .col { display: flex; flex-direction: column; gap: 8px; }
      .label { color: #7d8b96; }
      canvas { background: #000; display: block; }
      video { width: 640px; display: block; background: #000; }
      .stage { position: relative; width: 640px; height: 340px; }
      .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
      .stage canvas.grat { pointer-events: none; }
      #status { color: #8cd9a5; }
    </style>
  </head>
  <body>
    <h1>Video Scopes Test Harness</h1>
    <div class="row">
      <div class="col">
        <span class="label">Pattern → captureStream → &lt;video&gt;</span>
        <canvas id="pattern" width="1280" height="720" style="width: 640px"></canvas>
        <video id="video" muted playsinline loop autoplay></video>
        <p id="status">initializing…</p>
      </div>
      <div class="col">
        <span class="label">Scope (GPU density + 2D graticule)</span>
        <div class="stage">
          <canvas class="gpu" id="scope-gpu"></canvas>
          <canvas class="grat" id="scope-grat"></canvas>
        </div>
      </div>
    </div>
    <script type="module" src="harness.js"></script>
  </body>
</html>
```

- [ ] **Step 7: 写 `public/harness.js`（生成 Limited/Full 两版 SMPTE 彩条 + 灰阶斜坡，走真实 `<video>`；本任务只做 signal blit）**

> 本任务**只验证信号上传**，用一个最简 blit 管线把 `SignalTexture` 直接画到 canvas 上，逐像素比对左右两侧。`ScopeRenderer` 尚未存在（Task 8 建立），所以测试台此时不 import 它。

```js
import { initCanvas, configureCanvas } from './gpu/harness-bundle.js';
import { SignalTexture } from './gpu/harness-bundle.js';

const params = new URLSearchParams(location.search);
const limited = params.get('range') !== 'full';

const pattern = document.getElementById('pattern');
const video = document.getElementById('video');
const gpuCanvas = document.getElementById('scope-gpu');
const status = document.getElementById('status');

function drawPattern(ctx, isLimited) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const enc = (v) => 255 * (isLimited ? 16 / 255 + (219 / 255) * v : v);
  const bars = [
    [1, 1, 1], [1, 1, 0], [0, 1, 1], [0, 1, 0],
    [1, 0, 1], [1, 0, 0], [0, 0, 1], [0, 0, 0],
  ];
  const barW = w / bars.length;
  bars.forEach((rgb, i) => {
    const c = rgb.map((v) => Math.round(enc(v * 0.75))).join(',');
    ctx.fillStyle = `rgb(${c})`;
    ctx.fillRect(Math.round(i * barW), 0, Math.ceil(barW), Math.round(h * 0.6));
  });
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    const v = i / (steps - 1);
    const c = Math.round(enc(v));
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(Math.round((i * w) / steps), Math.round(h * 0.6), Math.ceil(w / steps), h);
  }
}

drawPattern(pattern.getContext('2d'), limited);
video.srcObject = pattern.captureStream(30);
video.play().catch(() => {});

const BLIT_WGSL = `
@group(0) @binding(0) var t: texture_2d<f32>;
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f,3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(t, s, in.uv, 0.0).rgb, 1.0);
}
@group(0) @binding(1) var s: sampler;
`;

async function main() {
  const gpu = await initCanvas(gpuCanvas);
  const module = gpu.device.createShaderModule({ code: BLIT_WGSL });
  const pipeline = gpu.device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = gpu.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

  let signal = null;
  let frames = 0;
  let t0 = performance.now();

  function frame() {
    configureCanvas(gpu, gpuCanvas.clientWidth, gpuCanvas.clientHeight);

    if (video.readyState >= 2) {
      if (!signal || signal.width !== video.videoWidth) {
        signal?.destroy();
        signal = new SignalTexture(gpu.device, video);
      }
      if (signal.update(video.currentTime)) {
        const bind = gpu.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: signal.texture.createView() },
            { binding: 1, resource: sampler },
          ],
        });
        const encoder = gpu.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: gpu.context.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
        gpu.device.queue.submit([encoder.finish()]);

        frames++;
        const dt = performance.now() - t0;
        if (dt > 1000) {
          status.textContent =
            `signal ${signal.width}x${signal.height} · range=${limited ? 'limited' : 'full'} ` +
            `· ${((frames * 1000) / dt).toFixed(0)} fps`;
          frames = 0;
          t0 = performance.now();
        }
      }
    }
    requestAnimationFrame(frame);
  }
  frame();
}

main().catch((e) => {
  status.textContent = 'ERROR: ' + e.message;
  status.style.color = '#d87f7f';
});
```

- [ ] **Step 8: 让测试台能 import TS 产物**

建 `src/harness-entry.ts`：

```ts
export { initCanvas, configureCanvas, getDevice } from './gpu/device';
export { SignalTexture } from './gpu/signal-texture';
```

`vite.config.ts` 加 `harness` 模式，输出 `dist/gpu/harness-bundle.js`：

```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: mode !== 'harness',
    target: 'chrome121',
    minify: false,
    rollupOptions: {
      input:
        mode === 'harness'
          ? { 'gpu/harness-bundle': resolve(__dirname, 'src/harness-entry.ts') }
          : {
              content: resolve(__dirname, 'src/content/index.ts'),
              background: resolve(__dirname, 'src/background/service-worker.ts'),
            },
      output:
        mode === 'harness'
          ? { entryFileNames: '[name].js', format: 'es' }
          : { entryFileNames: '[name].js', format: 'iife', inlineDynamicImports: true },
    },
  },
  publicDir: mode === 'harness' ? false : 'public',
}));
```

`package.json` 增加 `"harness": "vite build --mode harness"`。

- [ ] **Step 10: Commit**

```bash
git add src/gpu src/harness-entry.ts public vite.config.ts tests/signal-texture.test.ts docs/screenshots
git commit -m "feat(gpu): shared device, signal texture and instrumented test harness"
```

---

### Task 8: 波形示波器（Compute 累加 + 荧光 Resolve + 码值刻度）

**Files:**
- Create: `src/gpu/shaders/accumulate.wgsl`, `src/gpu/shaders/resolve.wgsl`, `src/gpu/scope-renderer.ts`, `src/ui/graticule.ts`
- Test: `tests/graticule.test.ts`（刻度几何的单测）+ 测试台浏览器验证
- Modify: `public/harness.js`（加入 waveform 面板）

**Interfaces:**
- Consumes: `CanvasGpu`（Task 7），`SignalTexture`（Task 7），`LUMA` / `MatrixId`（Task 2），`PRIMARIES` / `PrimariesId`（Task 2），`axisMapping` / `RangeSpec`（Task 3），`Unit` / `tickValues` / `axisToUnit` / `legalBands` / `unitSuffix`（Task 3），`WaveformResult` 索引约定（Task 6）
- Produces:
  - `type ScopeMode = 'waveform-luma' | 'waveform-rgb' | 'waveform-parade' | 'vectorscope' | 'cie'`
  - `interface ScopeOptions { mode: ScopeMode; channel: 0 | 1 | 2 | 3; width: number; height: number; gain: number; gamma: number; zoom: number; units: Unit; range: RangeSpec; matrix: MatrixId; primaries: PrimariesId; coord: 'xy' | 'uv' }`
  - `DEFAULT_SCOPE_OPTIONS: ScopeOptions`
  - `class ScopeRenderer { constructor(gpu, opts); resize(w, h); setOptions(partial); render(signal, readStats?): Promise<Uint32Array | null>; destroy() }`
  - `drawWaveformGraticule(ctx, opts): void`
  - `axisToCanvasY(axis: number, plotTop: number, plotHeight: number, zoom?: number): number`
  - `canvasYToAxis(y: number, plotTop: number, plotHeight: number, zoom?: number): number`
  - `WAVE_PAD = { top: 8, right: 8, bottom: 16, left: 40 }`

**关键约束:** 波形纵坐标是**码值轴** `a = code/maxCode`。shader 接收 `black` / `span` 两个 uniform，计算 `axis = black + v * span`，`bin = floor(axis * bins)`。这与 Task 6 的 CPU 实现逐位一致，`tests/graticule.test.ts` 会锁住 `axisToCanvasY` 与它的一致性。

- [ ] **Step 1: 写失败测试 `tests/graticule.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { axisToCanvasY, canvasYToAxis } from '../src/ui/graticule';

const TOP = 8;
const HEIGHT = 400;

describe('waveform axis geometry', () => {
  it('axis 1 maps to the top of the plot', () => {
    expect(axisToCanvasY(1, TOP, HEIGHT)).toBeCloseTo(TOP, 6);
  });
  it('axis 0 maps to the bottom of the plot', () => {
    expect(axisToCanvasY(0, TOP, HEIGHT)).toBeCloseTo(TOP + HEIGHT, 6);
  });
  it('axis 0.5 maps to the vertical centre', () => {
    expect(axisToCanvasY(0.5, TOP, HEIGHT)).toBeCloseTo(TOP + HEIGHT / 2, 6);
  });
  it('limited legal black (16/255) is visibly above the bottom', () => {
    const y = axisToCanvasY(16 / 255, TOP, HEIGHT);
    expect(TOP + HEIGHT - y).toBeCloseTo((16 / 255) * HEIGHT, 6);
    expect(y).toBeLessThan(TOP + HEIGHT - 20);
  });
  it('limited legal white (235/255) is visibly below the top', () => {
    const y = axisToCanvasY(235 / 255, TOP, HEIGHT);
    expect(y).toBeGreaterThan(TOP + 20);
  });
  it('round-trips through canvasYToAxis', () => {
    for (const a of [0, 0.25, 0.5, 0.75, 1]) {
      expect(canvasYToAxis(axisToCanvasY(a, TOP, HEIGHT), TOP, HEIGHT)).toBeCloseTo(a, 9);
    }
  });
  it('zoom magnifies around axis 0', () => {
    const z2 = axisToCanvasY(0.5, TOP, HEIGHT, 2);
    expect(TOP + HEIGHT - z2).toBeCloseTo(HEIGHT, 6);
  });
  it('zoom 1 is the identity', () => {
    expect(axisToCanvasY(0.37, TOP, HEIGHT, 1)).toBeCloseTo(axisToCanvasY(0.37, TOP, HEIGHT), 9);
  });
  it('clamps zoomed-out-of-plot values to the plot edge instead of escaping', () => {
    const y = axisToCanvasY(0.9, TOP, HEIGHT, 2);
    expect(y).toBeGreaterThanOrEqual(TOP - 1e-6);
    expect(y).toBeLessThanOrEqual(TOP + HEIGHT + 1e-6);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/graticule.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ui/graticule"`。

- [ ] **Step 3: 写 `src/gpu/shaders/accumulate.wgsl`**

```wgsl
struct Params {
  size: vec4u,   // srcW, srcH, dstW, dstH
  opts: vec4u,   // accMode, channel(0..4), coordIsUV, signalKind(0=display,1=raw)
  coeff: vec4f,  // kr, kg, kb, zoom
  m0: vec4f,     // rgb -> xyz, row 0 (.w unused)
  m1: vec4f,
  m2: vec4f,
  axis: vec4f,   // black, span, gain, gamma
};

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> density: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> lumaHist: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> p: Params;

fn srgbToLinear(v: f32) -> f32 {
  return select(v / 12.92, pow((v + 0.055) / 1.055, 2.4), v > 0.04045);
}

/** Expand a display-normalised sample onto the code axis. */
fn blend(v: f32) -> f32 {
  return p.axis.x + v * p.axis.y;
}

/** Map a code-space 0..1 value onto a density bin. */
fn toBin(axis: f32, bins: u32) -> u32 {
  return min(bins - 1u, u32(clamp(axis, 0.0, 1.0) * f32(bins)));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let srcW = p.size.x;
  let srcH = p.size.y;
  let dstW = p.size.z;
  let dstH = p.size.w;
  if (gid.x >= srcW || gid.y >= srcH) { return; }

  let kr = p.coeff.x;
  let kg = p.coeff.y;
  let kb = p.coeff.z;
  let zoom = p.coeff.w;

  let px = textureLoad(src, vec2i(i32(gid.x), i32(gid.y)), 0).rgb;
  let axisR = clamp(blend(px.r), 0.0, 1.0);
  let axisG = clamp(blend(px.g), 0.0, 1.0);
  let axisB = clamp(blend(px.b), 0.0, 1.0);
  let axisY = kr * axisR + kg * axisG + kb * axisB;
  let cb = (axisB - axisY) / (2.0 * (1.0 - kb));
  let cr = (axisR - axisY) / (2.0 * (1.0 - kr));

  atomicAdd(&lumaHist[min(255u, u32(axisY * 255.0))], 1u);

  let col = min(dstW - 1u, u32(f32(gid.x) / f32(srcW) * f32(dstW)));
  let stride = dstW * dstH;
  let accMode = p.opts.x;

  if (accMode == 0u) {
    let ch = p.opts.y;
    // ch == 4 is the only case that allocates three planes (RGB overlay and
    // parade). Every single-channel selection writes plane 0, because the
    // density buffer is sized to 1 plane for those modes — writing plane 1
    // would be an out-of-bounds storage access.
    if (ch == 4u) {
      atomicAdd(&density[0u * stride + toBin(axisR, dstH) * dstW + col], 1u);
      atomicAdd(&density[1u * stride + toBin(axisG, dstH) * dstW + col], 1u);
      atomicAdd(&density[2u * stride + toBin(axisB, dstH) * dstW + col], 1u);
    } else {
      var v = axisY;
      if (ch == 1u) { v = axisR; }
      if (ch == 2u) { v = axisG; }
      if (ch == 3u) { v = axisB; }
      atomicAdd(&density[toBin(v, dstH) * dstW + col], 1u);
    }
  } else if (accMode == 2u) {
    let fw = f32(dstW);
    let fh = f32(dstH);
    let sx = (0.5 + cb * zoom) * fw;
    let sy = (0.5 - cr * zoom) * fh;
    if (sx >= 0.0 && sx < fw && sy >= 0.0 && sy < fh) {
      atomicAdd(&density[u32(sy) * dstW + u32(sx)], 1u);
    }
  } else {
    let lin = vec3f(srgbToLinear(axisR), srgbToLinear(axisG), srgbToLinear(axisB));
    let xyz = vec3f(dot(p.m0.xyz, lin), dot(p.m1.xyz, lin), dot(p.m2.xyz, lin));
    let sum = xyz.x + xyz.y + xyz.z;
    if (sum > 0.0001) {
      var cx = xyz.x / sum;
      var cy = xyz.y / sum;
      var hi = vec2f(0.8, 0.9);
      if (p.opts.z == 1u) {
        let d = xyz.x + 15.0 * xyz.y + 3.0 * xyz.z;
        cx = 4.0 * xyz.x / d;
        cy = 9.0 * xyz.y / d;
        hi = vec2f(0.62, 0.6);
      }
      let fw = f32(dstW);
      let fh = f32(dstH);
      let sx = cx / hi.x * fw;
      let sy = (1.0 - cy / hi.y) * fh;
      if (sx >= 0.0 && sx < fw && sy >= 0.0 && sy < fh) {
        atomicAdd(&density[u32(sy) * dstW + u32(sx)], 1u);
      }
    }
  }
}
```

> 这一版是**最终形态**：`signalKind` uniform 在此版本中仍被忽略（display 路径），Task 13 会为 raw 平面加 binding 4/5 并在 `main()` 内分叉。测试台在 Task 8 只跑 display 路径，因此此处不需要分支。

> **Uniform 布局必须与 WGSL 结构体逐字节对齐**：`Params` = 7×`vec4` = 112 B（分配 128 B 留余量）；`ResolveParams` = 4×`vec4` = 64 B（分配 64 B）。两侧字段顺序必须完全一致，否则 shader 会静默读到垃圾值——这是 WebGPU 最常见的「波形全黑」原因。

- [ ] **Step 4: 写 `src/gpu/shaders/resolve.wgsl`**

```wgsl
struct ResolveParams {
  size: vec4u,   // dstW, dstH, planes, resMode(0 luma, 1 parade, 2 rgbOverlay, 3 vectorscope, 4 cie)
  opts: vec4f,   // gain, gamma, zoom, coordIsUV
  tint: vec4f,   // luma tint rgb (waveform-luma only)
  coeff: vec4f,  // kr, kg, kb, unused
};

@group(0) @binding(0) var<storage, read> density: array<u32>;
@group(0) @binding(1) var<uniform> p: ResolveParams;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var pts = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(pts[i], 0.0, 1.0);
  o.uv = vec2f((pts[i].x + 1.0) * 0.5, (1.0 - pts[i].y) * 0.5);
  return o;
}

fn phosphor(count: f32, gain: f32, gamma: f32) -> f32 {
  let i = 1.0 - exp(-count * gain);
  return pow(i, 1.0 / max(gamma, 0.05));
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let dstW = p.size.x;
  let dstH = p.size.y;
  let planes = p.size.z;
  let mode = p.size.w;
  let gain = p.opts.x;
  let gamma = p.opts.y;
  let zoom = p.opts.z;

  let col = min(dstW - 1u, u32(in.uv.x * f32(dstW)));
  let row = min(dstH - 1u, u32(in.uv.y * f32(dstH)));
  let stride = dstW * dstH;

  var acc = vec4f(0.0);

  if (mode == 0u) {
    let n = f32(density[row * dstW + col]);
    let i = phosphor(n, gain, gamma);
    acc = vec4f(p.tint.rgb * i, i);
  } else if (mode == 1u) {
    // RGB parade: three equal horizontal slices, each showing one plane.
    let sliceW = max(dstW / 3u, 1u);
    let slice = min(col / sliceW, planes - 1u);
    let localCol = col - slice * sliceW;
    let srcCol = min(dstW - 1u, u32(f32(localCol) / f32(sliceW) * f32(dstW)));
    var tint = vec3f(0.25, 0.5, 1.0);
    if (slice == 0u) { tint = vec3f(1.0, 0.15, 0.15); }
    if (slice == 1u) { tint = vec3f(0.15, 1.0, 0.3); }
    let n = f32(density[slice * stride + row * dstW + srcCol]);
    let i = phosphor(n, gain, gamma);
    acc = vec4f(tint * i, i);
  } else if (mode == 2u) {
    // RGB overlay: additive blend of the three planes.
    var tint = vec3f(0.0);
    for (var ch = 0u; ch < 3u; ch++) {
      let n = f32(density[ch * stride + row * dstW + col]);
      let i = phosphor(n, gain, gamma);
      var c = vec3f(0.22, 0.45, 1.0);
      if (ch == 0u) { c = vec3f(1.0, 0.12, 0.12); }
      if (ch == 1u) { c = vec3f(0.12, 1.0, 0.28); }
      tint += c * i;
    }
    acc = vec4f(tint, clamp(max(tint.r, max(tint.g, tint.b)), 0.0, 1.0));
  } else if (mode == 3u) {
    // Vectorscope: tint by the chroma at this pixel.
    let n = f32(density[row * dstW + col]);
    let i = phosphor(n, gain, gamma);
    let cb = clamp((f32(col) + 0.5) / f32(dstW) - 0.5, -0.5, 0.5) / zoom;
    let cr = clamp(0.5 - (f32(row) + 0.5) / f32(dstH), -0.5, 0.5) / zoom;
    let kr = p.coeff.x;
    let kg = p.coeff.y;
    let kb = p.coeff.z;
    let y = 0.5;
    let rr = y + 2.0 * (1.0 - kr) * cr;
    let bb = y + 2.0 * (1.0 - kb) * cb;
    let gg = (y - kr * rr - kb * bb) / max(kg, 1e-4);
    let rgb = clamp(vec3f(rr, gg, bb), vec3f(0.0), vec3f(1.0));
    let tinted = mix(rgb, vec3f(0.55, 1.0, 0.75), 0.35);
    acc = vec4f(tinted * i, i);
  } else {
    // CIE: tint by the chromaticity at this pixel.
    let n = f32(density[row * dstW + col]);
    let i = phosphor(n, gain, gamma);
    var rgb = vec3f(0.8, 0.9, 1.0);
    if (p.opts.w > 0.5) {
      let u = (f32(col) + 0.5) / f32(dstW) * 0.62;
      let v = (1.0 - (f32(row) + 0.5) / f32(dstH)) * 0.6;
      let den = 6.0 * u - 16.0 * v + 12.0;
      let cx = select(0.0, (9.0 * u) / den, abs(den) > 1e-5);
      let cy = select(0.0, (4.0 * v) / den, abs(den) > 1e-5);
      rgb = clamp(vec3f(cx, cy, 1.0 - cx - cy) * 1.6, vec3f(0.0), vec3f(1.0));
    } else {
      let cx = (f32(col) + 0.5) / f32(dstW) * 0.8;
      let cy = (1.0 - (f32(row) + 0.5) / f32(dstH)) * 0.9;
      rgb = clamp(vec3f(cx, cy, 1.0 - cx - cy) * 1.6, vec3f(0.0), vec3f(1.0));
    }
    acc = vec4f(mix(rgb, vec3f(0.8, 0.9, 1.0), 0.2) * i, i);
  }

  if (acc.a <= 0.002) { discard; }
  return acc;
}
```

- [ ] **Step 5: 写 `src/gpu/scope-renderer.ts`**

```ts
import { LUMA, type MatrixId } from '../core/color/matrices';
import { PRIMARIES, type PrimariesId } from '../core/color/primaries';
import { axisMapping, type RangeSpec } from '../core/scale/quantize';
import type { Unit } from '../core/scale/units';
import type { CanvasGpu } from './device';
import type { SignalTexture } from './signal-texture';
import accumulateWgsl from './shaders/accumulate.wgsl?raw';
import resolveWgsl from './shaders/resolve.wgsl?raw';

export type ScopeMode = 'waveform-luma' | 'waveform-rgb' | 'waveform-parade' | 'vectorscope' | 'cie';

export interface ScopeOptions {
  mode: ScopeMode;
  channel: 0 | 1 | 2 | 3;
  width: number;
  height: number;
  gain: number;
  gamma: number;
  zoom: number;
  units: Unit;
  range: RangeSpec;
  matrix: MatrixId;
  primaries: PrimariesId;
  coord: 'xy' | 'uv';
  signalKind: 'display' | 'raw';
}

export const DEFAULT_SCOPE_OPTIONS: ScopeOptions = {
  mode: 'waveform-luma',
  channel: 0,
  width: 512,
  height: 256,
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  units: 'ire',
  range: { limited: true, depth: 8 },
  matrix: 'bt709',
  primaries: 'rec709',
  coord: 'xy',
  signalKind: 'display',
};

/** accumulate.wgsl `accMode` */
const ACC_MODE: Record<ScopeMode, number> = {
  'waveform-luma': 0,
  'waveform-rgb': 0,
  'waveform-parade': 0,
  vectorscope: 2,
  cie: 3,
};

/** resolve.wgsl `resMode` */
const RES_MODE: Record<ScopeMode, number> = {
  'waveform-luma': 0,
  'waveform-parade': 1,
  'waveform-rgb': 2,
  vectorscope: 3,
  cie: 4,
};

const PLANES: Record<ScopeMode, number> = {
  'waveform-luma': 1,
  'waveform-rgb': 3,
  'waveform-parade': 3,
  vectorscope: 1,
  cie: 1,
};

/** accumulate.wgsl `channel`: 4 means "write R, G and B planes in one pass". */
export function accChannel(o: ScopeOptions): number {
  if (o.mode === 'waveform-rgb' || o.mode === 'waveform-parade') return 4;
  if (o.mode === 'waveform-luma') return o.channel;
  return 0;
}

const PARAMS_SIZE = 128;
const RESOLVE_SIZE = 64;

export class ScopeRenderer {
  readonly options: ScopeOptions;
  private readonly accumulatePipeline: GPUComputePipeline;
  private readonly resolvePipeline: GPURenderPipeline;
  private densityBuffer: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private readonly resolveBuffer: GPUBuffer;
  private readonly histBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private histPending = false;
  private destroyed = false;

  constructor(
    private readonly gpu: CanvasGpu,
    options: ScopeOptions,
  ) {
    this.options = { ...options };
    const { device } = gpu;
    this.accumulatePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: device.createShaderModule({ code: accumulateWgsl }),
        entryPoint: 'main',
      },
    });
    const resolveModule = device.createShaderModule({ code: resolveWgsl });
    this.resolvePipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: resolveModule, entryPoint: 'vs' },
      fragment: { module: resolveModule, entryPoint: 'fs', targets: [{ format: gpu.format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.densityBuffer = this.createDensity();
    this.paramsBuffer = device.createBuffer({
      size: PARAMS_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.resolveBuffer = device.createBuffer({
      size: RESOLVE_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histBuffer = device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.readbackBuffer = device.createBuffer({
      size: 256 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  private createDensity(): GPUBuffer {
    const planes = PLANES[this.options.mode];
    return this.gpu.device.createBuffer({
      size: planes * this.options.width * this.options.height * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  resize(width: number, height: number): void {
    if (width === this.options.width && height === this.options.height) return;
    this.options.width = width;
    this.options.height = height;
    this.densityBuffer.destroy();
    this.densityBuffer = this.createDensity();
  }

  setOptions(partial: Partial<ScopeOptions>): void {
    const prev = { ...this.options };
    Object.assign(this.options, partial);
    const needsRealloc =
      PLANES[prev.mode] !== PLANES[this.options.mode] ||
      prev.width !== this.options.width ||
      prev.height !== this.options.height;
    if (needsRealloc) {
      this.densityBuffer.destroy();
      this.densityBuffer = this.createDensity();
    }
  }

  async render(signal: SignalTexture, readStats = false): Promise<Uint32Array | null> {
    if (this.destroyed) return null;
    const { device, context } = this.gpu;
    const o = this.options;
    const c = LUMA[o.matrix];
    const m = PRIMARIES[o.primaries].rgbToXyz;
    const map = axisMapping(o.range);

    const params = new ArrayBuffer(PARAMS_SIZE);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    u32.set([signal.width, signal.height, o.width, o.height], 0);
    u32.set([ACC_MODE[o.mode], accChannel(o), o.coord === 'uv' ? 1 : 0, o.signalKind === 'raw' ? 1 : 0], 4);
    f32.set([c.kr, c.kg, c.kb, o.zoom], 8);
    f32.set([m[0]![0], m[0]![1], m[0]![2], 0], 12);
    f32.set([m[1]![0], m[1]![1], m[1]![2], 0], 16);
    f32.set([m[2]![0], m[2]![1], m[2]![2], 0], 20);
    f32.set([map.black, map.span, o.gain, o.gamma], 24);
    device.queue.writeBuffer(this.paramsBuffer, 0, params);

    const rp = new ArrayBuffer(RESOLVE_SIZE);
    const ru = new Uint32Array(rp);
    const rf = new Float32Array(rp);
    ru.set([o.width, o.height, PLANES[o.mode], RES_MODE[o.mode]], 0);
    rf.set([o.gain, o.gamma, o.zoom, o.coord === 'uv' ? 1 : 0], 4);
    rf.set([0.45, 1.0, 0.6, 0], 8);
    rf.set([c.kr, c.kg, c.kb, 0], 12);
    device.queue.writeBuffer(this.resolveBuffer, 0, rp);

    const accBind = device.createBindGroup({
      layout: this.accumulatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: signal.texture.createView() },
        { binding: 1, resource: { buffer: this.densityBuffer } },
        { binding: 2, resource: { buffer: this.histBuffer } },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
      ],
    });
    const resBind = device.createBindGroup({
      layout: this.resolvePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.densityBuffer } },
        { binding: 1, resource: { buffer: this.resolveBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(this.densityBuffer);
    encoder.clearBuffer(this.histBuffer);

    const compute = encoder.beginComputePass();
    compute.setPipeline(this.accumulatePipeline);
    compute.setBindGroup(0, accBind);
    compute.dispatchWorkgroups(Math.ceil(signal.width / 8), Math.ceil(signal.height / 8));
    compute.end();

    const render = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        },
      ],
    });
    render.setPipeline(this.resolvePipeline);
    render.setBindGroup(0, resBind);
    render.draw(3);
    render.end();

    const wantStats = readStats && !this.histPending;
    if (wantStats) {
      encoder.copyBufferToBuffer(this.histBuffer, 0, this.readbackBuffer, 0, 1024);
      this.histPending = true;
    }
    device.queue.submit([encoder.finish()]);

    if (!wantStats) return null;
    await this.readbackBuffer.mapAsync(GPUMapMode.READ);
    const hist = new Uint32Array(this.readbackBuffer.getMappedRange().slice(0));
    this.readbackBuffer.unmap();
    this.histPending = false;
    return hist;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.densityBuffer.destroy();
    this.paramsBuffer.destroy();
    this.resolveBuffer.destroy();
    this.histBuffer.destroy();
    this.readbackBuffer.destroy();
  }
}
```

- [ ] **Step 6: 写 `src/ui/graticule.ts`（本任务只做波形部分，后续任务追加）**

```ts
import { axisToUnit, legalBands, tickValues, unitSuffix } from '../core/scale/units';
import type { ScopeOptions } from '../gpu/scope-renderer';

export const WAVE_PAD = { top: 8, right: 8, bottom: 16, left: 40 } as const;

const BG = '#0d1117';
const GRID = '#1b232b';
const GRID_MAJOR = '#33414d';
const LEGAL = '#5d7f93';
const BAND = 'rgba(255,255,255,0.035)';
const TEXT = '#7d8b96';

export function axisToCanvasY(axis: number, plotTop: number, plotHeight: number, zoom = 1): number {
  const clamped = Math.min(1, Math.max(0, axis * zoom));
  return plotTop + plotHeight * (1 - clamped);
}

export function canvasYToAxis(y: number, plotTop: number, plotHeight: number, zoom = 1): number {
  const rel = 1 - (y - plotTop) / plotHeight;
  return Math.min(1, Math.max(0, rel)) / zoom;
}

export function drawWaveformGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  // o.width / o.height are CSS pixels; the 2D context already carries a DPR transform.
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const plotTop = WAVE_PAD.top;
  const plotH = h - WAVE_PAD.top - WAVE_PAD.bottom;
  const plotLeft = WAVE_PAD.left;
  const plotW = w - WAVE_PAD.left - WAVE_PAD.right;
  if (plotW <= 0 || plotH <= 0) return;

  const bands = legalBands(o.range);
  if (bands.footroom[1] > bands.footroom[0]) {
    const y0 = axisToCanvasY(bands.footroom[1], plotTop, plotH, o.zoom);
    const y1 = axisToCanvasY(bands.footroom[0], plotTop, plotH, o.zoom);
    ctx.fillStyle = BAND;
    ctx.fillRect(plotLeft, y0, plotW, y1 - y0);
  }
  if (bands.headroom[1] > bands.headroom[0]) {
    const y0 = axisToCanvasY(bands.headroom[1], plotTop, plotH, o.zoom);
    const y1 = axisToCanvasY(bands.headroom[0], plotTop, plotH, o.zoom);
    ctx.fillStyle = BAND;
    ctx.fillRect(plotLeft, y0, plotW, y1 - y0);
  }

  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ticks = tickValues(o.units, o.range);
  for (const a of ticks) {
    const y = axisToCanvasY(a, plotTop, plotH, o.zoom);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.fillText(String(Math.round(axisToUnit(a, o.units, o.range))), plotLeft - 4, y);
  }

  const { black, white } = legalBands(o.range).footroom[1] > 0
    ? { black: bands.footroom[1], white: bands.headroom[0] }
    : { black: 0, white: 1 };
  ctx.strokeStyle = LEGAL;
  ctx.setLineDash([4, 3]);
  for (const a of [black, white]) {
    if (a <= 0 || a >= 1) continue;
    const y = axisToCanvasY(a, plotTop, plotH, o.zoom);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = GRID_MAJOR;
  ctx.strokeRect(plotLeft + 0.5, plotTop + 0.5, plotW - 1, plotH - 1);
  ctx.textAlign = 'left';
  ctx.fillStyle = TEXT;
  ctx.fillText(unitSuffix(o.units), 4, plotTop + 6);
}
```

> `drawGraticule` 这个名字在后续任务里会作为统一入口（按 `o.mode` 分发）。本任务先只提供 `drawWaveformGraticule`，Task 9/10 再补另外两个。

- [ ] **Step 7: 运行刻度几何单测**

Run: `pnpm vitest run tests/graticule.test.ts`
Expected: 全部 passed。

- [ ] **Step 8: 把测试台的 blit 换成 waveform 示波器并肉眼核对**

替换 Task 7 的 `harness.js`：保留彩条生成与 `<video>`，删掉 blit 管线，改用 `ScopeRenderer` + `drawWaveformGraticule`，复用已有的 `#scope-gpu` / `#scope-grat` 两层 canvas（grat 在上、GPU 在下，已在 Task 7 的 HTML 里用绝对定位叠好）。

`src/harness-entry.ts` 追加导出：

```ts
export { ScopeRenderer, DEFAULT_SCOPE_OPTIONS } from './gpu/scope-renderer';
export { drawWaveformGraticule } from './ui/graticule';
```

`public/harness.js` 的 `main()` 改为（本任务只有波形，直接调 `drawWaveformGraticule`；Task 9 会换成统一入口 `drawGraticule`）：

```js
async function main() {
  const gpu = await initCanvas(gpuCanvas);
  const renderer = new ScopeRenderer(gpu, {
    ...DEFAULT_SCOPE_OPTIONS,
    mode: params.get('mode') ?? 'waveform-luma',
    units: params.get('units') ?? 'ire',
    range: { limited, depth: 8 },
    width: 640,
    height: 340,
  });
  const gratCtx = gratCanvas.getContext('2d');

  let signal = null;
  let frames = 0;
  let t0 = performance.now();

  function frame() {
    configureCanvas(gpu, gpuCanvas.clientWidth, gpuCanvas.clientHeight);
    renderer.resize(gpuCanvas.width, gpuCanvas.height);

    if (gratCanvas.width !== gpuCanvas.clientWidth || gratCanvas.height !== gpuCanvas.clientHeight) {
      gratCanvas.width = gpuCanvas.clientWidth;
      gratCanvas.height = gpuCanvas.clientHeight;
    }

    if (video.readyState >= 2) {
      if (!signal || signal.width !== video.videoWidth) {
        signal?.destroy();
        signal = new SignalTexture(gpu.device, video);
      }
      if (signal.update(video.currentTime)) {
        renderer.render(signal).then(() => {
          frames++;
          const dt = performance.now() - t0;
          if (dt > 1000) {
            status.textContent =
              `signal ${signal.width}x${signal.height} · ${limited ? 'limited' : 'full'} ` +
              `· ${renderer.options.mode} · ${((frames * 1000) / dt).toFixed(0)} fps`;
            frames = 0;
            t0 = performance.now();
          }
        });
        drawWaveformGraticule(gratCtx, {
          ...renderer.options,
          width: gratCanvas.width,
          height: gratCanvas.height,
        });
      }
    }
    requestAnimationFrame(frame);
  }
  frame();
}
```

运行 `pnpm build && pnpm harness && npx http-server dist -p 4173 -c-1`。

Expected（`?range=limited&units=ire`）：
- 白条顶端落在 **75 IRE** 刻度线 ±0.5 IRE；
- 灰阶阶梯最暗级落在 **0 IRE**、最亮级落在 **100 IRE**；
- 底部约 6.3% 与顶部约 7.8% 有 Footroom/Headroom 浅带，16/235 处有虚线；
- 切 `?units=code8` 后同一波形的纵向位置**完全不变**，只有左侧标签变成 16/235（验证「换标尺不改几何」）。
截图存 `docs/screenshots/task8-waveform.png`。

- [ ] **Step 9: Commit**

```bash
git add src/gpu src/ui/graticule.ts tests/graticule.test.ts public docs/screenshots
git commit -m "feat(gpu): waveform scope on a code-value axis with compute accumulation"
```

---

### Task 9: 矢量示波器（靶标、肤色线、缩放）

**Files:**
- Modify: `src/ui/graticule.ts`（追加矢量刻度 + 统一分发入口）
- Test: `tests/vectorscope-geometry.test.ts`
- 复用：`ScopeRenderer` 的 `vectorscope` 模式（Task 8 已实现 compute 与 resolve 分支）

**Interfaces:**
- Consumes: `chromaTargets` / `SKIN_TONE_ANGLE_DEG` / `LUMA`（Task 2），`ScopeOptions`（Task 8）
- Produces:
  - `chromaToScreen(cb: number, cr: number, size: number, zoom: number, ox?: number, oy?: number): [number, number]`
  - `screenToChroma(x: number, y: number, size: number, zoom: number, ox?: number, oy?: number): [number, number]`
  - `drawVectorscopeGraticule(ctx, o: ScopeOptions): void`
  - `drawGraticule(ctx, o: ScopeOptions, gamuts?: PrimariesId[]): void`（按 `o.mode` 分发；Task 10 追加 CIE 分支）

**几何约定（与 shader 必须一致）:** 屏幕 `x = 0.5 + Cb·zoom`，`y = 0.5 − Cr·zoom`，均按画布边长归一化。`ox`/`oy` 允许把示波器画在非正方形画布的中心。

- [ ] **Step 1: 写失败测试 `tests/vectorscope-geometry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { LUMA, chromaTargets } from '../src/core/color/matrices';
import { chromaToScreen, screenToChroma } from '../src/ui/graticule';

describe('chromaToScreen', () => {
  it('zero chroma maps to the centre', () => {
    expect(chromaToScreen(0, 0, 512, 1)).toEqual([256, 256]);
  });
  it('positive Cr maps above the centre', () => {
    const [, y] = chromaToScreen(0, 0.25, 512, 1);
    expect(y).toBeLessThan(256);
  });
  it('positive Cb maps right of the centre', () => {
    const [x] = chromaToScreen(0.25, 0, 512, 1);
    expect(x).toBeGreaterThan(256);
  });
  it('respects a non-zero origin', () => {
    expect(chromaToScreen(0, 0, 512, 1, 100, 80)).toEqual([100, 80]);
  });
  it('round-trips through screenToChroma', () => {
    for (const [cb, cr] of [[-0.1, 0.2], [0.3, -0.4], [0, 0]] as [number, number][]) {
      const [x, y] = chromaToScreen(cb, cr, 400, 2);
      const [backCb, backCr] = screenToChroma(x, y, 400, 2);
      expect(backCb).toBeCloseTo(cb, 9);
      expect(backCr).toBeCloseTo(cr, 9);
    }
  });
});

describe('bar targets fall where the graticule will draw them', () => {
  const size = 512;
  it('BT.709 75% red target is up-left of centre', () => {
    const red = chromaTargets(LUMA.bt709, 0.75).find((t) => t.name === 'red')!;
    const [x, y] = chromaToScreen(red.cb, red.cr, size, 1);
    expect(x).toBeLessThan(size / 2);
    expect(y).toBeLessThan(size / 2);
  });
  it('every 75% target stays inside the visible circle at zoom 1', () => {
    for (const t of chromaTargets(LUMA.bt709, 0.75)) {
      expect(t.radius).toBeLessThan(0.5);
    }
  });
  it('100% targets sit outside 75% targets but still fit the circle', () => {
    const t75 = chromaTargets(LUMA.bt709, 0.75);
    const t100 = chromaTargets(LUMA.bt709, 1);
    for (let i = 0; i < t75.length; i++) {
      expect(t100[i]!.radius).toBeGreaterThan(t75[i]!.radius);
      expect(t100[i]!.radius).toBeLessThanOrEqual(0.6);
    }
  });
  it('target angle is invariant between 75% and 100%', () => {
    const t75 = chromaTargets(LUMA.bt709, 0.75);
    const t100 = chromaTargets(LUMA.bt709, 1);
    for (let i = 0; i < t75.length; i++) {
      expect(t100[i]!.angleDeg).toBeCloseTo(t75[i]!.angleDeg, 6);
    }
  });
  it('switching matrix moves the targets (601 vs 709 are not interchangeable)', () => {
    const a = chromaTargets(LUMA.bt709, 0.75).find((t) => t.name === 'red')!;
    const b = chromaTargets(LUMA.bt601, 0.75).find((t) => t.name === 'red')!;
    expect(a.angleDeg).not.toBeCloseTo(b.angleDeg, 1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/vectorscope-geometry.test.ts`
Expected: FAIL — `chromaToScreen is not a function`。

- [ ] **Step 3: 在 `src/ui/graticule.ts` 追加**

顶部 import 改为：

```ts
import { LUMA, SKIN_TONE_ANGLE_DEG, chromaTargets } from '../core/color/matrices';
import { axisToUnit, legalBands, tickValues, unitSuffix } from '../core/scale/units';
import type { PrimariesId } from '../core/color/primaries';
import type { ScopeOptions } from '../gpu/scope-renderer';
```

文件末尾追加：

```ts
export function chromaToScreen(
  cb: number,
  cr: number,
  size: number,
  zoom: number,
  ox = size / 2,
  oy = size / 2,
): [number, number] {
  return [ox + cb * zoom * size, oy - cr * zoom * size];
}

export function screenToChroma(
  x: number,
  y: number,
  size: number,
  zoom: number,
  ox = size / 2,
  oy = size / 2,
): [number, number] {
  return [(x - ox) / (zoom * size), (oy - y) / (zoom * size)];
}

export function drawVectorscopeGraticule(ctx: CanvasRenderingContext2D, o: ScopeOptions): void {
  const w = o.width;
  const h = o.height;
  const size = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const radius = (size / 2) * o.zoom;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = GRID_MAJOR;
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, radius * frac, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.stroke();

  const c = LUMA[o.matrix];
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (const level of [1, 0.75]) {
    const targets = chromaTargets(c, level);
    ctx.strokeStyle = level === 0.75 ? '#a8b3bd' : '#5a6470';
    for (const t of targets) {
      const [px, py] = chromaToScreen(t.cb, t.cr, size, o.zoom, cx, cy);
      if (Math.hypot(px - cx, py - cy) > radius + 2) continue;
      const s = Math.max(4, Math.min(16, t.radius * o.zoom * size * 0.14));
      ctx.strokeRect(px - s / 2, py - s / 2, s, s);
      if (level === 0.75) {
        ctx.fillStyle = '#a8b3bd';
        ctx.fillText(t.name[0]!.toUpperCase(), px + s / 2 + 2, py);
      }
    }
  }

  const ang = (SKIN_TONE_ANGLE_DEG * Math.PI) / 180;
  ctx.strokeStyle = '#d8a06a';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * radius * 0.95, cy - Math.sin(ang) * radius * 0.95);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = TEXT;
  ctx.fillText(
    `${o.matrix.toUpperCase()} · ${o.zoom}x${o.range.limited ? ' · limited' : ' · full'}`,
    8,
    14,
  );
}

/**
 * Single entry point used by the HUD. Dispatch keeps the caller ignorant of
 * which graticule implementation a mode needs.
 *
 * The `cie` branch is added in Task 10 together with `drawCieGraticule`, so
 * this task stays type-clean on its own.
 */
export function drawGraticule(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions,
  gamuts: readonly PrimariesId[] = ['rec709'],
): void {
  void gamuts;
  switch (o.mode) {
    case 'vectorscope':
      drawVectorscopeGraticule(ctx, o);
      break;
    default:
      drawWaveformGraticule(ctx, o);
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run tests/vectorscope-geometry.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: 浏览器验证**

测试台加一个 512×512 vectorscope canvas，喂 Limited 75% 彩条。
Expected：
- 六色点云中心落在对应靶标框内，目测偏差 < 2 px；
- 灰阶阶梯聚成中心一个白点；
- `zoom` 切到 4× 时靶标同步放大且仍落在圆周内；
- 把 `matrix` 从 `bt709` 切到 `bt601`，靶标明显位移（红从 102.9° 移到 108.7°）。
截图存 `docs/screenshots/task9-vectorscope.png`。

- [ ] **Step 6: Commit**

```bash
git add src/ui/graticule.ts tests/vectorscope-geometry.test.ts docs/screenshots
git commit -m "feat(ui): vectorscope graticule with matrix-accurate bar targets"
```

---

### Task 10: CIE 马蹄图示波器

**Files:**
- Modify: `src/ui/graticule.ts`（追加 CIE 底图与 `drawGraticule` 的 cie 分支）
- Test: `tests/cie-geometry.test.ts`
- 复用：`ScopeRenderer` 的 `cie` 模式与 `mode == 4` 的 resolve 分支（Task 8 已实现，含真实色度反解上色）

**Interfaces:**
- Consumes: `CIE1931_LOCUS` / `gamutTriangle`（Task 4），`xyToLinearSrgb` / `linearToSrgb`（Task 3），`CIE_BOUNDS`（Task 6）
- Produces:
  - `xyToScreen(x, y, w, h, coord): [number, number]`
  - `screenToXy(px, py, w, h, coord): [number, number]`
  - `uvToXy(u, v): [number, number]`，`xyToUv(x, y): [number, number]`
  - `drawCieGraticule(ctx, o: ScopeOptions & { gamuts: PrimariesId[] }): void`

**边界必须与 GPU 一致:** `CIE_BOUNDS` 从 `core/scopes/reference.ts` 导入，**不得在本文件重新定义**——两份常量漂移会让点云与底图错位。

- [ ] **Step 1: 写失败测试 `tests/cie-geometry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { CIE_BOUNDS } from '../src/core/scopes/reference';
import { screenToXy, uvToXy, xyToScreen, xyToUv } from '../src/ui/graticule';

describe('xyToScreen', () => {
  it('places D65 by the shared bounds', () => {
    const [px, py] = xyToScreen(0.3127, 0.329, 800, 900, 'xy');
    expect(px).toBeCloseTo((0.3127 / CIE_BOUNDS.xy[2]) * 800, 3);
    expect(py).toBeCloseTo(900 - (0.329 / CIE_BOUNDS.xy[3]) * 900, 3);
  });
  it('places the origin at the bottom-left corner', () => {
    expect(xyToScreen(0, 0, 800, 900, 'xy')).toEqual([0, 900]);
  });
  it('round-trips both coordinate systems', () => {
    for (const coord of ['xy', 'uv'] as const) {
      const [px, py] = xyToScreen(0.2, 0.45, 600, 580, coord);
      const [x, y] = screenToXy(px, py, 600, 580, coord);
      expect(x).toBeCloseTo(0.2, 9);
      expect(y).toBeCloseTo(0.45, 9);
    }
  });
});

describe('CIE 1976 conversion', () => {
  it('D65 xy converts to u-prime/v-prime (0.1978, 0.4683)', () => {
    const [u, v] = xyToUv(0.3127, 0.329);
    expect(u).toBeCloseTo(0.1978, 3);
    expect(v).toBeCloseTo(0.4683, 3);
  });
  it('round-trips xy -> uv -> xy', () => {
    for (const [x, y] of [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]] as [number, number][]) {
      const [u, v] = xyToUv(x, y);
      const [bx, by] = uvToXy(u, v);
      expect(bx).toBeCloseTo(x, 9);
      expect(by).toBeCloseTo(y, 9);
    }
  });
  it('the Rec.709 green primary stays above the D65 locus line in uv space', () => {
    const [, greenV] = xyToUv(0.3, 0.6);
    const [, whiteV] = xyToUv(0.3127, 0.329);
    expect(greenV).toBeGreaterThan(whiteV);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/cie-geometry.test.ts`
Expected: FAIL — `xyToScreen is not a function`。

- [ ] **Step 3: 在 `src/ui/graticule.ts` 追加**

顶部 import 补齐：

```ts
import { CIE1931_LOCUS, gamutTriangle } from '../core/color/locus';
import { linearToSrgb, xyToLinearSrgb } from '../core/color/transfer';
import { CIE_BOUNDS } from '../core/scopes/reference';
import type { PrimariesId } from '../core/color/primaries';
```

末尾追加：

```ts
export function xyToUv(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (9 * y) / d];
}

export function uvToXy(u: number, v: number): [number, number] {
  const d = 6 * u - 16 * v + 12;
  return [(9 * u) / d, (4 * v) / d];
}

export function xyToScreen(
  x: number,
  y: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
): [number, number] {
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  return [((x - x0) / (x1 - x0)) * w, h - ((y - y0) / (y1 - y0)) * h];
}

export function screenToXy(
  px: number,
  py: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
): [number, number] {
  const [x0, y0, x1, y1] = CIE_BOUNDS[coord];
  return [x0 + (px / w) * (x1 - x0), y0 + ((h - py) / h) * (y1 - y0)];
}

function chartToScreen(
  x: number,
  y: number,
  w: number,
  h: number,
  coord: 'xy' | 'uv',
): [number, number] {
  return coord === 'xy' ? xyToScreen(x, y, w, h, 'xy') : xyToScreen(...xyToUv(x, y), w, h, 'uv');
}

function locusHue(x: number, y: number): string {
  const [r, g, b] = xyToLinearSrgb([x, y]);
  const enc = (v: number): number =>
    Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.max(v, 0)))) * 255);
  return `rgb(${enc(r)},${enc(g)},${enc(b)})`;
}

export function drawCieGraticule(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions & { gamuts: PrimariesId[] },
): void {
  const w = o.width;
  const h = o.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);

  const pts = CIE1931_LOCUS.map((p) => chartToScreen(p[0], p[1], w, h, o.coord));

  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = '#141b21';
  ctx.fill();
  ctx.strokeStyle = '#4a5a66';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.lineWidth = 3;
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    const [lx, ly] = CIE1931_LOCUS[i]!;
    ctx.strokeStyle = locusHue(lx, ly);
    ctx.beginPath();
    ctx.moveTo(x, y);
    const next = pts[Math.min(i + 1, pts.length - 1)]!;
    ctx.lineTo(next[0], next[1]);
    ctx.stroke();
  }

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const GAMUT_COLOR: Record<PrimariesId, string> = {
    rec709: '#7fa8d8',
    p3: '#d8c07f',
    rec2020: '#d87f7f',
  };
  const GAMUT_LABEL: Record<PrimariesId, string> = {
    rec709: 'Rec.709',
    p3: 'P3',
    rec2020: 'Rec.2020',
  };
  for (const id of o.gamuts) {
    const tri = gamutTriangle(id).map((p) => chartToScreen(p[0], p[1], w, h, o.coord));
    ctx.beginPath();
    tri.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = GAMUT_COLOR[id];
    ctx.lineWidth = 1;
    ctx.stroke();
    const [lx, ly] = tri[1]!;
    ctx.fillStyle = GAMUT_COLOR[id];
    ctx.fillText(GAMUT_LABEL[id], lx + 4, ly);
  }

  const white = o.coord === 'xy' ? ([0.3127, 0.329] as const) : xyToUv(0.3127, 0.329);
  const [wx, wy] = xyToScreen(white[0], white[1], w, h, o.coord);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(wx - 5, wy);
  ctx.lineTo(wx + 5, wy);
  ctx.moveTo(wx, wy - 5);
  ctx.lineTo(wx, wy + 5);
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.fillText(
    `D65 · ${o.coord === 'xy' ? 'CIE 1931 xy' : "CIE 1976 u'v'"} · ${o.primaries}`,
    8,
    14,
  );
}
```

最后把 Task 9 里暂缺的 `cie` 分支补上，并去掉那处 `void gamuts;`：

```ts
export function drawGraticule(
  ctx: CanvasRenderingContext2D,
  o: ScopeOptions,
  gamuts: readonly PrimariesId[] = ['rec709'],
): void {
  switch (o.mode) {
    case 'vectorscope':
      drawVectorscopeGraticule(ctx, o);
      break;
    case 'cie':
      drawCieGraticule(ctx, { ...o, gamuts: [...gamuts] });
      break;
    default:
      drawWaveformGraticule(ctx, o);
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run tests/cie-geometry.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: 浏览器验证**

测试台加 512×512 CIE canvas，喂 Limited 75% 彩条，勾选 `rec709` 与 `p3` 两个色域。
Expected：
- 六个点簇分别落在 Rec.709 三角形顶点与边附近；
- 灰阶聚成 D65 十字上的白斑；
- 马蹄边缘有彩色波长描边，紫边闭合；
- 切到 `u'v'` 时形状按 CIE 1976 变形（马蹄更扁平），点云跟着移动。
截图存 `docs/screenshots/task10-cie.png`。

- [ ] **Step 6: Commit**

```bash
git add src/ui/graticule.ts tests/cie-geometry.test.ts docs/screenshots
git commit -m "feat(ui): CIE 1931/1976 chromaticity diagram with gamut overlays"
```

---

### Task 11: 视频检测、rVFC 调度与 Shadow DOM HUD

**Files:**
- Create: `src/content/video-detector.ts`, `src/content/frame-loop.ts`, `src/content/fullscreen.ts`, `src/ui/hud.ts`, `src/ui/settings.ts`
- Modify: `src/content/index.ts`

**Interfaces:**
- Produces:
  - `class VideoDetector { constructor(onChange: (v: HTMLVideoElement | null) => void); start(): void; stop(): void; get video(): HTMLVideoElement | null }`
  - `class FrameLoop { constructor(video: HTMLVideoElement, onFrame: (now: number, meta: VideoFrameCallbackMetadata) => void, targetFps?: number); start(): void; stop(): void; refreshOnce(): void }`
  - `interface HudState { visible: boolean; layout: 'single' | 'grid' | 'triple'; mode: ScopeMode; units: Unit; gain: number; gamma: number; zoom: number; rangeMode: RangeMode; gamuts: PrimariesId[] }`
  - `class Hud { constructor(initial: HudState, handlers: HudHandlers); mount(): void; unmount(): void; relayout(layout): void; panelCanvases(): PanelTargets[]; setDiagnosis(d: RangeDiagnosis): void; setColorInfo(info: ColorSpaceInfo): void; setPerf(fps: number, gpuMs: number | null): void }`
  - `interface HudHandlers { onStateChange(patch: Partial<HudState>): void }`（HUD 不参与绘制，也不读取 ScopeOptions）
  - `loadSettings(): Promise<HudState>`，`saveSettings(s: HudState): Promise<void>`

- [ ] **Step 1: 写 `src/content/video-detector.ts`**

```ts
function area(v: HTMLVideoElement): number {
  const r = v.getBoundingClientRect();
  return r.width * r.height;
}

export class VideoDetector {
  private current: HTMLVideoElement | null = null;
  private observer: MutationObserver | null = null;

  constructor(private readonly onChange: (v: HTMLVideoElement | null) => void) {}

  get video(): HTMLVideoElement | null {
    return this.current;
  }

  start(): void {
    this.scan();
    this.observer = new MutationObserver(() => this.scan());
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'style'],
    });
    document.addEventListener('fullscreenchange', this.scan);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener('fullscreenchange', this.scan);
    this.current = null;
  }

  private scan = (): void => {
    const videos = Array.from(document.querySelectorAll('video')).filter(
      (v) => v.videoWidth > 0 && v.videoHeight > 0 && !v.paused || v.videoWidth > 0,
    );
    if (videos.length === 0) {
      if (this.current) {
        this.current = null;
        this.onChange(null);
      }
      return;
    }
    const best = videos.sort((a, b) => area(b) - area(a))[0]!;
    if (best !== this.current) {
      this.current = best;
      this.onChange(best);
    }
  };
}
```

> 若视频尚未有尺寸（`videoWidth === 0`），`scan` 会被 MutationObserver 或 `loadedmetadata` 再次触发；在 `onChange` 里对 `best` 补一个 `once('loadedmetadata', scan)` 更稳，实现时加上。

- [ ] **Step 2: 写 `src/content/frame-loop.ts`**

```ts
export class FrameLoop {
  private handle = 0;
  private running = false;
  private lastEmit = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (now: number, meta: VideoFrameCallbackMetadata) => void,
    private readonly targetFps = 30,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = (now: number, meta: VideoFrameCallbackMetadata) => {
      if (!this.running) return;
      const minInterval = 1000 / this.targetFps;
      if (now - this.lastEmit >= minInterval) {
        this.lastEmit = now;
        this.onFrame(now, meta);
      }
      this.handle = this.video.requestVideoFrameCallback(tick);
    };
    this.handle = this.video.requestVideoFrameCallback(tick);
    this.video.addEventListener('seeked', this.refreshOnce);
  }

  refreshOnce = (): void => {
    this.lastEmit = 0;
  };

  stop(): void {
    this.running = false;
    if (this.handle) this.video.cancelVideoFrameCallback(this.handle);
    this.video.removeEventListener('seeked', this.refreshOnce);
  }
}
```

- [ ] **Step 3: 写 `src/content/fullscreen.ts`**

```ts
export function followFullscreen(host: HTMLElement): () => void {
  const place = (): void => {
    const fs = document.fullscreenElement;
    const parent = fs ?? document.body;
    if (host.parentElement !== parent) parent.appendChild(host);
  };
  document.addEventListener('fullscreenchange', place);
  place();
  return () => document.removeEventListener('fullscreenchange', place);
}
```

- [ ] **Step 4: 写 `src/ui/settings.ts`**

```ts
import type { ScopeMode } from '../gpu/scope-renderer';
import type { PrimariesId } from '../core/color/primaries';
import type { RangeMode } from '../core/range-detector';
import type { Unit } from '../core/scale/units';

export interface HudState {
  visible: boolean;
  layout: 'single' | 'grid' | 'triple';
  mode: ScopeMode;
  units: Unit;
  gain: number;
  gamma: number;
  zoom: number;
  rangeMode: RangeMode;
  /** CIE plot coordinate system; unused by the other scopes. */
  coord: 'xy' | 'uv';
  gamuts: PrimariesId[];
}

export const DEFAULT_STATE: HudState = {
  visible: false,
  layout: 'grid',
  mode: 'waveform-luma',
  units: 'ire',
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  rangeMode: 'auto',
  coord: 'xy',
  gamuts: ['rec709', 'p3'],
};

const KEY = 'video-scopes:state';

export async function loadSettings(): Promise<HudState> {
  const got = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_STATE, ...(got[KEY] ?? {}) } as HudState;
}

export async function saveSettings(s: HudState): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}
```

- [ ] **Step 5: 写 `src/ui/hud.ts`**

```ts
import type { HudState } from './settings';
import type { ScopeMode } from '../gpu/scope-renderer';
import type { PanelTargets } from '../content/scope-controller';
import type { ColorSpaceInfo, RangeDiagnosis } from '../core/range-detector';

export interface HudHandlers {
  onStateChange(patch: Partial<HudState>): void;
}

const HOST_ID = 'video-scopes-host';

export class Hud {
  private host: HTMLDivElement | null = null;
  private root: ShadowRoot | null = null;
  private canvases: Record<string, HTMLCanvasElement> = {};
  private statusEl: HTMLElement | null = null;
  private perfEl: HTMLElement | null = null;

  constructor(
    private state: HudState,
    private readonly handlers: HudHandlers,
  ) {}

  mount(): void {
    if (this.host) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText =
      'position:fixed;top:16px;right:16px;width:760px;z-index:2147483646;all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
          color: #b9c6d0; background: #0b0f12f2;
          border: 1px solid #ffffff1a; border-radius: 10px;
          box-shadow: 0 10px 30px #0009; overflow: hidden;
          resize: both; min-width: 320px; min-height: 180px;
        }
        header {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 8px; background: #12181d; cursor: move;
          user-select: none; border-bottom: 1px solid #ffffff14;
        }
        header .title { color: #d7e3ec; font-weight: 500; letter-spacing: .02em; }
        header .spacer { flex: 1; }
        .badge { padding: 1px 6px; border-radius: 999px; background: #1c262d; color: #8ea3b0; }
        .badge.warn { background: #3a2a12; color: #f0c070; }
        .badge.ok { background: #16291d; color: #8cd9a5; }
        .grid { display: grid; gap: 4px; padding: 6px; }
        .grid.single { grid-template-columns: 1fr; }
        .grid.grid { grid-template-columns: 1fr 1fr; }
        .grid.triple { grid-template-columns: 1fr; }
        .cell { position: relative; background: #0d1117; border-radius: 6px; overflow: hidden; }
        .cell canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
        .cell canvas.grat { pointer-events: none; }
        footer {
          display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
          padding: 6px 8px; border-top: 1px solid #ffffff14; background: #0f1418;
        }
        select, button {
          font: inherit; color: #cfe0ea; background: #16202a;
          border: 1px solid #ffffff20; border-radius: 5px; padding: 2px 4px;
        }
      </style>
      <div class="panel">
        <header>
          <span class="title">Video Scopes</span>
          <span class="badge" id="status">detecting…</span>
          <span class="badge" id="cs">–</span>
          <span class="badge warn" id="warn" hidden></span>
          <span class="spacer"></span>
          <span class="badge" id="perf">–</span>
          <button id="close" title="Close">✕</button>
        </header>
        <div class="grid ${this.state.layout}" id="grid"></div>
        <footer>
          <label>units
            <select id="units">
              <option value="ire">IRE</option>
              <option value="code8">8-bit</option>
              <option value="code10">10-bit</option>
              <option value="mv">mV</option>
              <option value="nits">nits</option>
            </select>
          </label>
          <label>range
            <select id="range">
              <option value="auto">auto</option>
              <option value="limited">limited</option>
              <option value="full">full</option>
            </select>
          </label>
          <label>gain <input id="gain" type="range" min="0.2" max="3" step="0.1"></label>
          <label>zoom <input id="zoom" type="range" min="1" max="8" step="1"></label>
          <label>layout
            <select id="layout">
              <option value="grid">grid</option>
              <option value="triple">triple</option>
              <option value="single">single</option>
            </select>
          </label>
          <label>cie
            <select id="coord">
              <option value="xy">1931 xy</option>
              <option value="uv">1976 u'v'</option>
            </select>
          </label>
        </footer>
      </div>`;
    this.host = host;
    this.root = root;
    document.body.appendChild(host);
    this.buildCells();
    this.wire();
    this.syncInputs();
  }

  /** Rebuild the grid when the layout preset changes. */
  relayout(layout: HudState['layout']): void {
    if (!this.root || layout === this.state.layout) return;
    this.state = { ...this.state, layout };
    const grid = this.root.getElementById('grid') as HTMLElement | null;
    if (!grid) return;
    grid.className = `grid ${layout}`;
    this.buildCells();
  }

  unmount(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.canvases = {};
  }

  /**
   * GPU + graticule canvas for every visible panel. The controller owns all
   * drawing, so this is the only canvas accessor the HUD exposes.
   */
  panelCanvases(): PanelTargets[] {
    return Object.entries(this.canvases)
      .filter(([k]) => k.endsWith(':gpu'))
      .map(([k, gpu]) => {
        const mode = k.split(':')[0] as ScopeMode;
        return { mode, gpu, grat: this.canvases[`${mode}:grat`]! };
      });
  }

  setColorInfo(info: ColorSpaceInfo): void {
    const el = this.root?.getElementById('cs') as HTMLElement | null;
    if (!el) return;
    el.textContent = [
      (info.matrix ?? '?').toUpperCase(),
      info.fullRange === null ? 'range ?' : info.fullRange ? 'full' : 'limited',
      info.transfer,
      info.format ?? '?',
    ].join(' · ');
  }

  setDiagnosis(d: RangeDiagnosis): void {
    if (!this.root) return;
    const status = this.root.getElementById('status') as HTMLElement | null;
    const warn = this.root.getElementById('warn') as HTMLElement | null;
    if (status) {
      status.textContent = `${d.effective} · ${Math.round(d.confidence * 100)}% · ${d.source}`;
      status.className = `badge ${d.effective === 'full' ? 'ok' : ''}`;
    }
    if (warn) {
      if (d.warning) {
        warn.hidden = false;
        warn.textContent =
          d.warning === 'limited-treated-as-full'
            ? '⚠ limited signal read as full'
            : '⚠ full signal read as limited';
      } else {
        warn.hidden = true;
      }
    }
  }

  setPerf(fps: number, gpuMs: number | null): void {
    if (!this.root) return;
    const el = this.root.getElementById('perf') as HTMLElement | null;
    if (el) el.textContent = `${fps.toFixed(0)} fps${gpuMs === null ? '' : ` · ${gpuMs.toFixed(2)} ms`}`;
  }

  private buildCells(): void {
    if (!this.root) return;
    const grid = this.root.getElementById('grid') as HTMLElement;
    const modes: ScopeMode[] =
      this.state.layout === 'grid'
        ? ['waveform-rgb', 'waveform-parade', 'vectorscope', 'cie']
        : this.state.layout === 'triple'
          ? ['waveform-luma', 'waveform-parade', 'vectorscope']
          : [this.state.mode];
    grid.innerHTML = modes
      .map(
        (m) => `<div class="cell" data-mode="${m}" style="aspect-ratio:${m === 'cie' || m === 'vectorscope' ? '1/1' : '2/1'}">
          <canvas class="grat"></canvas><canvas class="gpu"></canvas>
        </div>`,
      )
      .join('');
    this.canvases = {};
    for (const cell of Array.from(grid.querySelectorAll<HTMLElement>('.cell'))) {
      const mode = cell.dataset.mode as ScopeMode;
      const grat = cell.querySelector<HTMLCanvasElement>('canvas.grat')!;
      const gpu = cell.querySelector<HTMLCanvasElement>('canvas.gpu')!;
      this.canvases[`${mode}:grat`] = grat;
      this.canvases[`${mode}:gpu`] = gpu;
    }
  }

  private wire(): void {
    if (!this.root) return;
    const r = this.root;
    (r.getElementById('close') as HTMLElement).addEventListener('click', () =>
      this.handlers.onStateChange({ visible: false }),
    );
    (r.getElementById('units') as HTMLSelectElement).addEventListener('change', (e) =>
      this.handlers.onStateChange({ units: (e.target as HTMLSelectElement).value as HudState['units'] }),
    );
    (r.getElementById('range') as HTMLSelectElement).addEventListener('change', (e) =>
      this.handlers.onStateChange({ rangeMode: (e.target as HTMLSelectElement).value as HudState['rangeMode'] }),
    );
    (r.getElementById('gain') as HTMLInputElement).addEventListener('input', (e) =>
      this.handlers.onStateChange({ gain: Number((e.target as HTMLInputElement).value) }),
    );
    (r.getElementById('zoom') as HTMLInputElement).addEventListener('input', (e) =>
      this.handlers.onStateChange({ zoom: Number((e.target as HTMLInputElement).value) }),
    );
    (r.getElementById('layout') as HTMLSelectElement).addEventListener('change', (e) =>
      this.handlers.onStateChange({ layout: (e.target as HTMLSelectElement).value as HudState['layout'] }),
    );
    (r.getElementById('coord') as HTMLSelectElement).addEventListener('change', (e) =>
      this.handlers.onStateChange({ coord: (e.target as HTMLSelectElement).value as HudState['coord'] }),
    );
    const header = r.querySelector('header') as HTMLElement;
    let drag: { x: number; y: number; left: number; top: number } | null = null;
    header.addEventListener('pointerdown', (e) => {
      const rect = (this.host as HTMLElement).getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener('pointermove', (e) => {
      if (!drag || !this.host) return;
      this.host.style.left = `${drag.left + e.clientX - drag.x}px`;
      this.host.style.top = `${drag.top + e.clientY - drag.y}px`;
      this.host.style.right = 'auto';
    });
    header.addEventListener('pointerup', () => (drag = null));
  }

  private syncInputs(): void {
    if (!this.root) return;
    (this.root.getElementById('units') as HTMLSelectElement).value = this.state.units;
    (this.root.getElementById('range') as HTMLSelectElement).value = this.state.rangeMode;
    (this.root.getElementById('gain') as HTMLInputElement).value = String(this.state.gain);
    (this.root.getElementById('zoom') as HTMLInputElement).value = String(this.state.zoom);
    (this.root.getElementById('layout') as HTMLSelectElement).value = this.state.layout;
    (this.root.getElementById('coord') as HTMLSelectElement).value = this.state.coord;
  }

}
```

> `Hud` 只负责 DOM 与交互回调，**不碰 canvas 绘制**。刻度与示波器的绘制全部由 `ScopeController`（Task 12）负责，避免两处各自持有 canvas 尺寸与 DPR 逻辑而互相覆盖。

}
```

- [ ] **Step 6: 重写 `src/content/index.ts` 装配**

```ts
import { VideoDetector } from './video-detector';
import { FrameLoop } from './frame-loop';
import { followFullscreen } from './fullscreen';
import { Hud } from '../ui/hud';
import { DEFAULT_STATE, loadSettings, saveSettings, type HudState } from '../ui/settings';

let enabled = false;
let detector: VideoDetector | null = null;
let loop: FrameLoop | null = null;
let hud: Hud | null = null;
let state: HudState = DEFAULT_STATE;

let frameCount = 0;
let lastPerfAt = performance.now();

const HOST_ID = 'video-scopes-host';

async function enable(): Promise<void> {
  if (enabled) return;
  enabled = true;
  state = await loadSettings();

  hud = new Hud(
    { ...state, visible: true },
    {
      onStateChange(patch) {
        state = { ...state, ...patch };
        void saveSettings(state);
        if (patch.visible === false) void disable();
        if (patch.layout) hud?.relayout(patch.layout);
      },
    },
  );
  hud.mount();
  followFullscreen(document.getElementById(HOST_ID)!);

  detector = new VideoDetector((video) => {
    loop?.stop();
    loop = null;
    if (!video) return;
    loop = new FrameLoop(video, onFrame, 30);
    loop.start();
  });
  detector.start();
}

async function disable(): Promise<void> {
  if (!enabled) return;
  enabled = false;
  loop?.stop();
  loop = null;
  detector?.stop();
  detector = null;
  hud?.unmount();
  hud = null;
}

/**
 * Task 11 drives the loop but does not render yet: the GPU pipeline lands in
 * Task 12. Keeping the callback here means the rVFC wiring is already proven.
 */
async function onFrame(): Promise<void> {
  if (!detector?.video || !hud) return;
  frameCount += 1;
  const now = performance.now();
  if (now - lastPerfAt > 1000) {
    hud.setPerf((frameCount * 1000) / (now - lastPerfAt), null);
    frameCount = 0;
    lastPerfAt = now;
  }
}

function toggle(): void {
  void (enabled ? disable() : enable());
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'toggle-scopes') toggle();
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault();
    toggle();
  }
});

void (async () => {
  const s = await loadSettings();
  if (s.visible) void enable();
})();
```

> 本任务交付「能开能关、能跟随全屏、能统计帧率」的 HUD，**不画任何示波器**。GPU 装配在 Task 12，届时只替换 `onFrame` 的实现，`enable`/`disable` 结构不变。

- [ ] **Step 7: 类型检查与手动验证**

Run: `pnpm build`
Expected: 无 TS 错误。
载入扩展，在 YouTube 页面按 `Alt+S`。
Expected: 右上浮出四宫格面板，标题栏可拖动、面板可缩放，`status` 显示 `detecting…`（GPU 未接入），按 `Alt+S` 关闭。截图存 `docs/screenshots/task11-hud.png`。

- [ ] **Step 8: Commit**

```bash
git add src/content src/ui docs/screenshots
git commit -m "feat(ui): shadow DOM HUD with rVFC driven frame loop and fullscreen follow"
```

---

### Task 12: 色彩元数据提取、Range 状态栏与 GPU 装配

**Files:**
- Create: `src/content/color-space.ts`
- Modify: `src/content/index.ts`（完整渲染循环）、`src/ui/hud.ts`（状态栏细节）

**Interfaces:**
- Produces:
  - `normalizeColorSpace(frame: VideoFrame | null): ColorSpaceInfo`
  - `readVideoColorSpace(video: HTMLVideoElement): ColorSpaceInfo`（内部 `new VideoFrame(video)` 后立即 `close()`）
  - `applyRangeMode(mode: RangeMode, info: ColorSpaceInfo, diagnosis: RangeDiagnosis): RangeSpec`

- [ ] **Step 1: 写 `src/content/color-space.ts`**

```ts
import type { MatrixId } from '../core/color/matrices';
import type { PrimariesId } from '../core/color/primaries';
import type { ColorSpaceInfo, RangeDiagnosis, RangeMode, TransferId } from '../core/range-detector';
import type { RangeSpec } from '../core/scale/quantize';

function mapMatrix(m: VideoMatrixCoefficients | string | null): MatrixId | null {
  switch (m) {
    case 'bt709':
      return 'bt709';
    case 'smpte170m':
    case 'bt470bg':
      return 'bt601';
    case 'bt2020-ncl':
      return 'bt2020';
    default:
      return null;
  }
}

function mapPrimaries(p: VideoColorPrimaries | string | null): PrimariesId | null {
  switch (p) {
    case 'bt709':
      return 'rec709';
    case 'smpte432':
      return 'p3';
    case 'bt2020':
      return 'rec2020';
    default:
      return null;
  }
}

function mapTransfer(t: VideoTransferCharacteristics | string | null): TransferId {
  switch (t) {
    case 'bt709':
      return 'bt709';
    case 'iec61966-2-1':
      return 'srgb';
    case 'pq':
      return 'pq';
    case 'hlg':
      return 'hlg';
    default:
      return 'unknown';
  }
}

export function normalizeColorSpace(frame: VideoFrame | null, format: string | null = null): ColorSpaceInfo {
  if (!frame) {
    return { fullRange: null, matrix: null, primaries: null, transfer: 'unknown', format, source: 'unknown' };
  }
  const cs = frame.colorSpace;
  return {
    fullRange: cs.fullRange ?? null,
    matrix: mapMatrix(cs.matrix),
    primaries: mapPrimaries(cs.primaries),
    transfer: mapTransfer(cs.transfer),
    format: frame.format ?? format,
    source: 'webcodecs',
  };
}

export function readVideoColorSpace(video: HTMLVideoElement): ColorSpaceInfo {
  try {
    const frame = new VideoFrame(video);
    try {
      return normalizeColorSpace(frame);
    } finally {
      frame.close();
    }
  } catch {
    return { fullRange: null, matrix: null, primaries: null, transfer: 'unknown', format: null, source: 'unknown' };
  }
}

export function applyRangeMode(
  mode: RangeMode,
  info: ColorSpaceInfo,
  diagnosis: RangeDiagnosis,
): RangeSpec {
  const limited =
    mode === 'limited' ? true : mode === 'full' ? false : diagnosis.effective === 'limited';
  const depth: 8 | 10 = info.transfer === 'pq' || info.transfer === 'hlg' ? 10 : 8;
  return { limited, depth };
}
```

- [ ] **Step 2: 写 `src/content/scope-controller.ts`（唯一持有 GPU 资源的地方）**

**为什么单独一个类:** 资源生命周期（device/context/texture/renderer）与 DOM、与消息、与 rVFC 都无关。把它隔离出来才能测、才能在视频切换时不泄漏。

```ts
import { configureCanvas, getDevice, initCanvas, type CanvasGpu } from '../gpu/device';
import { SignalTexture } from '../gpu/signal-texture';
import { ScopeRenderer, type ScopeMode, type ScopeOptions } from '../gpu/scope-renderer';
import { drawGraticule } from '../ui/graticule';
import type { PrimariesId } from '../core/color/primaries';

export interface PanelTargets {
  mode: ScopeMode;
  gpu: HTMLCanvasElement;
  grat: HTMLCanvasElement;
}

export interface ControllerCallbacks {
  onDiagnosis(hist: Uint32Array, total: number): void;
}

export class ScopeController {
  private readonly gpus = new Map<ScopeMode, CanvasGpu>();
  private readonly renderers = new Map<ScopeMode, ScopeRenderer>();
  private signal: SignalTexture | null = null;
  private busy = false;
  private destroyed = false;

  constructor(
    private targets: PanelTargets[],
    private optionsFor: (mode: ScopeMode) => ScopeOptions,
    private readonly callbacks: ControllerCallbacks,
    private readonly gamuts: () => readonly PrimariesId[],
  ) {}

  setTargets(targets: PanelTargets[]): void {
    this.disposeRenderers();
    this.targets = targets;
  }

  setOptionsFor(fn: (mode: ScopeMode) => ScopeOptions): void {
    this.optionsFor = fn;
    for (const r of this.renderers.values()) r.setOptions(this.optionsFor(r.options.mode));
  }

  /** Rebuild the signal texture when the video element or its dimensions change. */
  attach(video: HTMLVideoElement): void {
    if (this.signal && this.signal.width === video.videoWidth && this.signal.height === video.videoHeight) {
      return;
    }
    void this.rebuildSignal(video);
  }

  private async rebuildSignal(video: HTMLVideoElement): Promise<void> {
    const device = await getDevice();
    if (this.destroyed) return;
    if (video.videoWidth === 0 || video.videoHeight === 0) return;
    this.signal?.destroy();
    this.signal = new SignalTexture(device, video);
  }

  async frame(video: HTMLVideoElement): Promise<void> {
    if (this.destroyed || this.busy) return;
    this.attach(video);
    if (!this.signal) return;
    if (!this.signal.update(video.currentTime)) return;

    this.busy = true;
    try {
      let first = true;
      for (const t of this.targets) {
        const renderer = await this.rendererFor(t);
        if (!renderer) continue;
        const hist = await renderer.render(this.signal, first);
        if (first && hist) {
          this.callbacks.onDiagnosis(hist, this.signal.width * this.signal.height);
        }
        first = false;
        this.drawGraticule(t);
      }
    } finally {
      this.busy = false;
    }
  }

  private async rendererFor(t: PanelTargets): Promise<ScopeRenderer | null> {
    const existing = this.renderers.get(t.mode);
    if (existing) return existing;
    if (t.gpu.clientWidth === 0 || t.gpu.clientHeight === 0) return null;
    const gpu = await initCanvas(t.gpu);
    if (this.destroyed) return null;
    this.gpus.set(t.mode, gpu);
    const renderer = new ScopeRenderer(gpu, this.optionsFor(t.mode));
    this.renderers.set(t.mode, renderer);
    return renderer;
  }

  private drawGraticule(t: PanelTargets): void {
    const renderer = this.renderers.get(t.mode);
    if (!renderer) return;
    const ctx = t.grat.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.max(1, Math.round(t.grat.clientWidth * dpr));
    const h = Math.max(1, Math.round(t.grat.clientHeight * dpr));
    if (t.grat.width !== w || t.grat.height !== h) {
      t.grat.width = w;
      t.grat.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraticule(
      ctx,
      { ...renderer.options, width: t.grat.clientWidth, height: t.grat.clientHeight },
      this.gamuts(),
    );
  }

  resize(): void {
    for (const [mode, gpu] of this.gpus) {
      const t = this.targets.find((x) => x.mode === mode);
      if (!t) continue;
      if (configureCanvas(gpu, t.gpu.clientWidth, t.gpu.clientHeight)) {
        this.renderers.get(mode)?.resize(
          (gpu.context.canvas as HTMLCanvasElement).width,
          (gpu.context.canvas as HTMLCanvasElement).height,
        );
      }
    }
  }

  private disposeRenderers(): void {
    for (const r of this.renderers.values()) r.destroy();
    this.renderers.clear();
    this.gpus.clear();
  }

  destroy(): void {
    this.destroyed = true;
    this.disposeRenderers();
    this.signal?.destroy();
    this.signal = null;
  }
}
```

- [ ] **Step 3: 重写 `src/content/index.ts` 接上 controller**

```ts
import { VideoDetector } from './video-detector';
import { FrameLoop } from './frame-loop';
import { followFullscreen } from './fullscreen';
import { readVideoColorSpace, applyRangeMode } from './color-space';
import { ScopeController, type PanelTargets } from './scope-controller';
import { Hud } from '../ui/hud';
import { DEFAULT_STATE, loadSettings, saveSettings, type HudState } from '../ui/settings';
import { DEFAULT_SCOPE_OPTIONS, type ScopeMode, type ScopeOptions } from '../gpu/scope-renderer';
import { RangeDetector, type ColorSpaceInfo } from '../core/range-detector';
import { histogramStats } from '../core/scopes/stats';
import type { RangeSpec } from '../core/scale/quantize';

const HOST_ID = 'video-scopes-host';

let enabled = false;
let detector: VideoDetector | null = null;
let loop: FrameLoop | null = null;
let hud: Hud | null = null;
let controller: ScopeController | null = null;
let state: HudState = DEFAULT_STATE;

let colorInfo: ColorSpaceInfo = {
  fullRange: null,
  matrix: null,
  primaries: null,
  transfer: 'unknown',
  format: null,
  source: 'unknown',
};
let effectiveRange: RangeSpec = { limited: true, depth: 8 };
const rangeDetector = new RangeDetector(3);

let frameCount = 0;
let lastPerfAt = performance.now();

function optionsForMode(mode: ScopeMode): ScopeOptions {
  return {
    ...DEFAULT_SCOPE_OPTIONS,
    mode,
    width: 512,
    height: 256,
    gain: state.gain,
    gamma: DEFAULT_STATE.gamma,
    zoom: state.zoom,
    units: state.units,
    range: effectiveRange,
    matrix: colorInfo.matrix ?? 'bt709',
    primaries: colorInfo.primaries ?? 'rec709',
    coord: state.coord,
  };
}

function panelTargets(): PanelTargets[] {
  return hud?.panelCanvases() ?? [];
}

function onDiagnosis(hist: Uint32Array, total: number): void {
  const d = rangeDetector.push(colorInfo, histogramStats(hist, total));
  hud?.setDiagnosis(d);
  effectiveRange = applyRangeMode(state.rangeMode, colorInfo, d);
  controller?.setOptionsFor(optionsForMode);
}

async function onFrame(): Promise<void> {
  const video = detector?.video;
  if (!video || !hud || !controller) return;

  colorInfo = readVideoColorSpace(video);
  hud.setColorInfo(colorInfo);

  controller.resize();
  await controller.frame(video);

  frameCount += 1;
  const now = performance.now();
  if (now - lastPerfAt > 1000) {
    hud.setPerf((frameCount * 1000) / (now - lastPerfAt), null);
    frameCount = 0;
    lastPerfAt = now;
  }
}

async function enable(): Promise<void> {
  if (enabled) return;
  enabled = true;
  state = await loadSettings();

  hud = new Hud(
    { ...state, visible: true },
    {
      onStateChange(patch) {
        state = { ...state, ...patch };
        void saveSettings(state);
        if (patch.visible === false) {
          void disable();
          return;
        }
        if (patch.layout) {
          hud?.relayout(patch.layout);
          controller?.setTargets(panelTargets());
        }
        controller?.setOptionsFor(optionsForMode);
      },
    },
  );
  hud.mount();
  followFullscreen(document.getElementById(HOST_ID)!);

  controller = new ScopeController(
    panelTargets(),
    optionsForMode,
    { onDiagnosis },
    () => state.gamuts,
  );

  detector = new VideoDetector((video) => {
    loop?.stop();
    loop = null;
    if (!video) return;
    loop = new FrameLoop(video, onFrame, 30);
    loop.start();
  });
  detector.start();
}

async function disable(): Promise<void> {
  if (!enabled) return;
  enabled = false;
  loop?.stop();
  loop = null;
  detector?.stop();
  detector = null;
  controller?.destroy();
  controller = null;
  hud?.unmount();
  hud = null;
  rangeDetector.reset();
}

function toggle(): void {
  void (enabled ? disable() : enable());
}

chrome.runtime.onMessage.addListener((msg: { type?: string }) => {
  if (msg?.type === 'toggle-scopes') toggle();
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.code === 'KeyS') {
    e.preventDefault();
    toggle();
  }
});

void (async () => {
  const saved = await loadSettings();
  if (saved.visible) void enable();
})();
```

`layout` 与 `coord` 下拉、`#cs` 徽章都已在 Task 11 的 HUD 模板与 `wire()` 里实现。本任务只需确认 `onStateChange` 分支里对 `layout` 的处理会调用 `relayout()` 并刷新 controller 的 targets（见下一步）。

- [ ] **Step 4: 给 `ScopeController` 补单测（真实 GPU 之外的可测部分）**

`ScopeController` 依赖 WebGPU，无法在 node 里跑。把它的两个纯逻辑抽到 `src/core/scopes/plan.ts`，并测它们：

```ts
// src/core/scopes/plan.ts
import type { RangeSpec } from '../scale/quantize';
import type { Unit } from '../scale/units';

export interface PlanInput {
  units: Unit;
  range: RangeSpec;
  matrix: string;
  primaries: string;
  coord: 'xy' | 'uv';
  gain: number;
  gamma: number;
  zoom: number;
  channel: 0 | 1 | 2 | 3;
}

/** Values that must force a full pipeline rebuild (shader/uniform topology change). */
export function requiresRebuild(prev: PlanInput, next: PlanInput): boolean {
  return (
    prev.range.limited !== next.range.limited ||
    prev.range.depth !== next.range.depth ||
    prev.matrix !== next.matrix ||
    prev.primaries !== next.primaries ||
    prev.coord !== next.coord
  );
}

/** Values that only need a uniform refresh (no allocation). */
export function requiresUniformUpdate(prev: PlanInput, next: PlanInput): boolean {
  return (
    prev.gain !== next.gain ||
    prev.gamma !== next.gamma ||
    prev.zoom !== next.zoom ||
    prev.channel !== next.channel ||
    prev.units !== next.units
  );
}
```

测试：

```ts
// tests/plan.test.ts
import { describe, expect, it } from 'vitest';
import { requiresRebuild, requiresUniformUpdate, type PlanInput } from '../src/core/scopes/plan';

const base: PlanInput = {
  units: 'ire',
  range: { limited: true, depth: 8 },
  matrix: 'bt709',
  primaries: 'rec709',
  coord: 'xy',
  gain: 0.9,
  gamma: 0.9,
  zoom: 1,
  channel: 0,
};

describe('requiresRebuild', () => {
  it('is false for a pure gain change', () => {
    expect(requiresRebuild(base, { ...base, gain: 2 })).toBe(false);
  });
  it('is true when the range flips limited -> full', () => {
    expect(requiresRebuild(base, { ...base, range: { limited: false, depth: 8 } })).toBe(true);
  });
  it('is true when the bit depth changes', () => {
    expect(requiresRebuild(base, { ...base, range: { limited: true, depth: 10 } })).toBe(true);
  });
  it('is true when the matrix changes', () => {
    expect(requiresRebuild(base, { ...base, matrix: 'bt2020' })).toBe(true);
  });
  it('is true when switching xy -> uv', () => {
    expect(requiresRebuild(base, { ...base, coord: 'uv' })).toBe(true);
  });
  it('is false when only units change (units are labels, not geometry)', () => {
    expect(requiresRebuild(base, { ...base, units: 'code10' })).toBe(false);
  });
});

describe('requiresUniformUpdate', () => {
  it('is true for zoom', () => {
    expect(requiresUniformUpdate(base, { ...base, zoom: 4 })).toBe(true);
  });
  it('is true for units', () => {
    expect(requiresUniformUpdate(base, { ...base, units: 'mv' })).toBe(true);
  });
  it('is false when nothing relevant changes', () => {
    expect(requiresUniformUpdate(base, { ...base })).toBe(false);
  });
});
```

Run: `pnpm vitest run tests/plan.test.ts`
Expected: 9 passed。

- [ ] **Step 5: 验证 range 识别**

在测试台用 `?range=limited` 的彩条（`captureStream` 编码后 Chrome 通常报 `fullRange: false` 或 `true`，以实际 `frame.colorSpace` 为准，控制台打印核对）。
Expected：
- 状态栏显示 `limited · 100% · webcodecs`，且 `8-bit · BT.709 · NV12`（编码器不同可能显示 `VP8`/`VP9`）；
- 打开一个「Full 码值但被当成 Limited」的素材（`?range=full` 配 limited 覆盖）时，3 帧后出现 `⚠ limited signal read as full`；
- 手动切 `range` 下拉为 `full`/`limited`，波形纵向标尺立刻变化。

- [ ] **Step 6: Commit**

```bash
git add src/content src/ui src/core/scopes/plan.ts tests/plan.test.ts
git commit -m "feat(content): metadata-driven range diagnosis wired into the scope pipeline"
```

---

### Task 13: Raw Plane 模式（精确码值，绕过显示色彩管理）

**Files:**
- Create: `src/gpu/raw-planes.ts`
- Modify: `src/gpu/shaders/accumulate.wgsl`（新增 raw 分支）、`src/gpu/scope-renderer.ts`（多两个 texture binding）、`src/gpu/signal-texture.ts`（抽出 `SourceLike` 接口）
- Test: `tests/raw-layout.test.ts`

**为什么需要这个模式:** display 模式拿到的是浏览器色彩管理**之后**的 RGBA。对 SDR Rec.709 内容，`importExternalTexture`/`copyExternalImageToTexture` 的结果与源码值只差一次 range 展开，够用。但对 PQ/HLG、或非 Rec.709 原色的内容，显示编码后的 RGB 已经丢失了源信号的绝对码值——那时只能用 `VideoFrame.copyTo()` 取原始 YUV 平面。

**Interfaces:**
- Produces:
  - `interface PlaneLayout { yOffset: number; uvOffset: number; vOffset: number; yStride: number; chromaStride: number; chromaWidth: number; chromaHeight: number }`
  - `i420Layout(width: number, height: number): PlaneLayout`
  - `class RawPlaneTexture { readonly y: GPUTexture; readonly uv: GPUTexture; readonly width; readonly height; destroy(): void }`
  - `async function copyFrameToPlanes(frame: VideoFrame, device: GPUDevice): Promise<RawPlaneTexture>`
  - `type SourceLike = { kind: 'display'; texture: SignalTexture } | { kind: 'raw'; planes: RawPlaneTexture }`

**为什么不用「上采样成全分辨率 RGBA」:** 1080p 每帧要额外 8 MB CPU 写 + 8 MB 上传，30 fps 就是 480 MB/s，纯浪费。两个平面（`r8unorm` 全分辨率 Y + `rg8unorm` 半分辨率 UV）总共 3 MB，且 chroma 采样由 GPU 的双线性免费完成——这也正是 YUV 4:2:0 的语义。

- [ ] **Step 1: 写失败测试 `tests/raw-layout.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { i420Layout } from '../src/gpu/raw-planes';

describe('i420Layout', () => {
  it('places Y first, then U, then V for 1920x1080', () => {
    const l = i420Layout(1920, 1080);
    expect(l.yOffset).toBe(0);
    expect(l.yStride).toBe(1920);
    expect(l.chromaStride).toBe(960);
    expect(l.chromaWidth).toBe(960);
    expect(l.chromaHeight).toBe(540);
    expect(l.uvOffset).toBe(1920 * 1080);
    expect(l.vOffset).toBe(1920 * 1080 + 960 * 540);
  });

  it('total size matches frame.allocationSize for I420', () => {
    const w = 640;
    const h = 360;
    const l = i420Layout(w, h);
    const total = l.vOffset + l.chromaStride * l.chromaHeight;
    expect(total).toBe(w * h + 2 * (w / 2) * (h / 2));
  });

  it('rejects odd dimensions, which I420 cannot represent without padding', () => {
    expect(() => i420Layout(1919, 1080)).toThrow(/even/);
    expect(() => i420Layout(1920, 1081)).toThrow(/even/);
  });

  it('handles the smallest legal plane', () => {
    const l = i420Layout(2, 2);
    expect(l.chromaWidth).toBe(1);
    expect(l.chromaHeight).toBe(1);
    expect(l.vOffset).toBe(4 + 1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run tests/raw-layout.test.ts`
Expected: FAIL — cannot resolve `../src/gpu/raw-planes`。

- [ ] **Step 3: 实现 `src/gpu/raw-planes.ts`**

```ts
export interface PlaneLayout {
  yOffset: number;
  uvOffset: number;
  vOffset: number;
  yStride: number;
  chromaStride: number;
  chromaWidth: number;
  chromaHeight: number;
}

/** Tightly packed I420 (4:2:0 8-bit): Y plane, then U, then V, no row padding. */
export function i420Layout(width: number, height: number): PlaneLayout {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error('I420 requires even dimensions');
  }
  const chromaWidth = width / 2;
  const chromaHeight = height / 2;
  const ySize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  return {
    yOffset: 0,
    uvOffset: ySize,
    vOffset: ySize + chromaSize,
    yStride: width,
    chromaStride: chromaWidth,
    chromaWidth,
    chromaHeight,
  };
}

export class RawPlaneTexture {
  readonly width: number;
  readonly height: number;

  constructor(
    readonly y: GPUTexture,
    readonly uv: GPUTexture,
    width: number,
    height: number,
  ) {
    this.width = width;
    this.height = height;
  }

  destroy(): void {
    this.y.destroy();
    this.uv.destroy();
  }
}

/**
 * Copy a decoded VideoFrame's I420 planes into two r8/rg8 textures.
 * The frame stays owned by the caller and must be closed by it.
 */
export async function copyFrameToPlanes(
  frame: VideoFrame,
  device: GPUDevice,
): Promise<RawPlaneTexture> {
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  const layout = i420Layout(width, height);

  const buffer = new Uint8Array(frame.allocationSize({ format: 'I420' }));
  await frame.copyTo(buffer, {
    format: 'I420',
    rect: { x: 0, y: 0, width, height },
    layout: [
      { offset: layout.yOffset, stride: layout.yStride },
      { offset: layout.uvOffset, stride: layout.chromaStride },
      { offset: layout.vOffset, stride: layout.chromaStride },
    ],
  });

  const yTex = device.createTexture({
    size: { width, height },
    format: 'r8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  device.queue.writeTexture(
    { texture: yTex },
    buffer.subarray(layout.yOffset, layout.uvOffset),
    { bytesPerRow: layout.yStride, rowsPerImage: height },
    { width, height },
  );

  // Interleave U and V into one rg8 plane so the shader needs a single sample.
  const uv = new Uint8Array(layout.chromaWidth * layout.chromaHeight * 2);
  for (let i = 0; i < layout.chromaWidth * layout.chromaHeight; i++) {
    uv[i * 2] = buffer[layout.uvOffset + i]!;
    uv[i * 2 + 1] = buffer[layout.vOffset + i]!;
  }
  const uvTex = device.createTexture({
    size: { width: layout.chromaWidth, height: layout.chromaHeight },
    format: 'rg8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
  });
  device.queue.writeTexture(
    { texture: uvTex },
    uv,
    { bytesPerRow: layout.chromaWidth * 2, rowsPerImage: layout.chromaHeight },
    { width: layout.chromaWidth, height: layout.chromaHeight },
  );

  return new RawPlaneTexture(yTex, uvTex, width, height);
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm vitest run tests/raw-layout.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 在 `accumulate.wgsl` 增加 raw 分支**

先加两个 binding（写在 `@group(0) @binding(3)` 之后）：

```wgsl
@group(0) @binding(4) var yPlane: texture_2d<f32>;   // r8unorm, full resolution
@group(0) @binding(5) var uvPlane: texture_2d<f32>;  // rg8unorm, half resolution
```

然后**整体替换** `main()` 为下面的版本。它把「取信号」和「分派」彻底分开：raw 与 display 只在上半段分叉，下半段所有示波器共用同一条路径，因此不存在两套索引逻辑漂移的风险。

```wgsl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let srcW = p.size.x;
  let srcH = p.size.y;
  let dstW = p.size.z;
  let dstH = p.size.w;
  if (gid.x >= srcW || gid.y >= srcH) { return; }

  let black = p.axis.x;
  let span = p.axis.y;
  let kr = p.coeff.x;
  let kg = p.coeff.y;
  let kb = p.coeff.z;
  let zoom = p.coeff.w;
  let raw = p.opts.w == 1u;

  // ---- signal acquisition: everything below is in code space -------------
  var axisY = 0.0;      // 0..1 on the code-value axis
  var axisR = 0.0;
  var axisG = 0.0;
  var axisB = 0.0;
  var cb = 0.0;         // -0.5..0.5
  var cr = 0.0;

  if (raw) {
    let uv = textureLoad(uvPlane, vec2i(i32(gid.x) >> 1, i32(gid.y) >> 1), 0).rg;
    let yCode = textureLoad(yPlane, vec2i(i32(gid.x), i32(gid.y)), 0).r;
    axisY = yCode;
    cb = (uv.r - 128.0 / 255.0) * (255.0 / 224.0);
    cr = (uv.g - 128.0 / 255.0) * (255.0 / 224.0);
    // YUV -> R'G'B' for the CIE diagram only; code values, then linearised there.
    let yNorm = (yCode - black) / max(span, 1e-4);
    let rr = yNorm + 2.0 * (1.0 - kr) * cr * 2.0;
    let bb = yNorm + 2.0 * (1.0 - kb) * cb * 2.0;
    let gg = (yNorm - kr * rr - kb * bb) / max(kg, 1e-4);
    axisR = clamp(rr, 0.0, 1.0);
    axisG = clamp(gg, 0.0, 1.0);
    axisB = clamp(bb, 0.0, 1.0);
  } else {
    let px = textureLoad(src, vec2i(i32(gid.x), i32(gid.y)), 0).rgb;
    axisR = clamp(blend(px.r), 0.0, 1.0);
    axisG = clamp(blend(px.g), 0.0, 1.0);
    axisB = clamp(blend(px.b), 0.0, 1.0);
    let luma = kr * axisR + kg * axisG + kb * axisB;
    axisY = luma;
    cb = (axisB - luma) / (2.0 * (1.0 - kb));
    cr = (axisR - luma) / (2.0 * (1.0 - kr));
  }

  atomicAdd(
    &lumaHist[min(255u, u32(axisY * 255.0))],
    1u,
  );

  let col = min(dstW - 1u, u32(f32(gid.x) / f32(srcW) * f32(dstW)));
  let stride = dstW * dstH;
  let accMode = p.opts.x;

  if (accMode == 0u) {
    let ch = p.opts.y;
    // ch == 4 is the only case that allocates three planes (RGB overlay and
    // parade). Every single-channel selection writes plane 0, because the
    // density buffer is sized to 1 plane for those modes — writing plane 1
    // would be an out-of-bounds storage access.
    if (ch == 4u) {
      atomicAdd(&density[0u * stride + toBin(axisR, dstH) * dstW + col], 1u);
      atomicAdd(&density[1u * stride + toBin(axisG, dstH) * dstW + col], 1u);
      atomicAdd(&density[2u * stride + toBin(axisB, dstH) * dstW + col], 1u);
    } else {
      var v = axisY;
      if (ch == 1u) { v = axisR; }
      if (ch == 2u) { v = axisG; }
      if (ch == 3u) { v = axisB; }
      atomicAdd(&density[toBin(v, dstH) * dstW + col], 1u);
    }
  } else if (accMode == 2u) {
    let fw = f32(dstW);
    let fh = f32(dstH);
    let sx = (0.5 + cb * zoom) * fw;
    let sy = (0.5 - cr * zoom) * fh;
    if (sx >= 0.0 && sx < fw && sy >= 0.0 && sy < fh) {
      atomicAdd(&density[u32(sy) * dstW + u32(sx)], 1u);
    }
  } else {
    let lin = vec3f(srgbToLinear(axisR), srgbToLinear(axisG), srgbToLinear(axisB));
    let xyz = vec3f(dot(p.m0.xyz, lin), dot(p.m1.xyz, lin), dot(p.m2.xyz, lin));
    let sum = xyz.x + xyz.y + xyz.z;
    if (sum > 0.0001) {
      var cx = xyz.x / sum;
      var cy = xyz.y / sum;
      var hi = vec2f(0.8, 0.9);
      if (p.opts.z == 1u) {
        let d = xyz.x + 15.0 * xyz.y + 3.0 * xyz.z;
        cx = 4.0 * xyz.x / d;
        cy = 9.0 * xyz.y / d;
        hi = vec2f(0.62, 0.6);
      }
      let fw = f32(dstW);
      let fh = f32(dstH);
      let sx = cx / hi.x * fw;
      let sy = (1.0 - cy / hi.y) * fh;
      if (sx >= 0.0 && sx < fw && sy >= 0.0 && sy < fh) {
        atomicAdd(&density[u32(sy) * dstW + u32(sx)], 1u);
      }
    }
  }
}
```

配套两个 helper，放在 `main()` 之前：

```wgsl
/** Map a code-space 0..1 value onto a density bin. */
fn toBin(axis: f32, bins: u32) -> u32 {
  return min(bins - 1u, u32(clamp(axis, 0.0, 1.0) * f32(bins)));
}

/** Expand a display-normalised sample onto the code axis (black/span uniform). */
fn blend(v: f32) -> f32 {
  return p.axis.x + v * p.axis.y;
}
```

> raw 模式下 `axisY` 直接是 `Ycode/255`，**不再**经过 `blend`——否则会把 limited 的 16–235 又压缩一次，正是本模式要避免的错误。display 模式下 `blend` 才生效。
>
> 注意 CPU 参考实现里的 `axisBin`（Task 6）与这里的 `toBin` + `blend` 是同一个语义：`floor(clamp(black + v*span, 0, 1) * bins)`。Task 6 的单测就是 shader 的验收基准，两者取整方式必须一致（`u32()` 对正数等同于 `floor`）。

- [ ] **Step 6: 在 `scope-renderer.ts` 绑定两个平面纹理**

构造函数里加一个 1×1 的占位纹理，保证 display 模式下 bind group 依然完整：

```ts
  private readonly dummyY: GPUTexture;
  private readonly dummyUV: GPUTexture;
  private readonly sampler: GPUSampler;
```

```ts
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.dummyY = device.createTexture({
      size: { width: 1, height: 1 },
      format: 'r8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    device.queue.writeTexture({ texture: this.dummyY }, new Uint8Array([0]), { bytesPerRow: 1 }, { width: 1, height: 1 });
    this.dummyUV = device.createTexture({
      size: { width: 1, height: 1 },
      format: 'rg8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });
    device.queue.writeTexture({ texture: this.dummyUV }, new Uint8Array([128, 128]), { bytesPerRow: 2 }, { width: 1, height: 1 });
```

bind group 增加两项：

```ts
        { binding: 4, resource: planes?.y.createView() ?? this.dummyY.createView() },
        { binding: 5, resource: planes?.uv.createView() ?? this.dummyUV.createView() },
```

`render()` 签名改为：

```ts
  async render(source: SourceLike, readStats = false): Promise<Uint32Array | null> {
    const texture = source.kind === 'display' ? source.texture : null;
    const planes = source.kind === 'raw' ? source.planes : null;
    const srcW = texture?.width ?? planes!.width;
    const srcH = texture?.height ?? planes!.height;
    ...
```

display 模式下 `binding: 0` 绑 `texture.texture.createView()`；raw 模式下绑 `this.dummyY.createView()`（occupancy 由 binding 4/5 提供）。

`destroy()` 里补 `this.dummyY.destroy(); this.dummyUV.destroy();`。

- [ ] **Step 7: 验证**

测试台加 `?signal=raw` 开关，走 `new VideoFrame(video)` → `copyFrameToPlanes` → `render({ kind: 'raw', planes })`。
Expected：
- 同一 limited 彩条，raw 模式与 display 模式的白条 IRE 相差 < 0.5 IRE，黑位相差 < 0.5 IRE；
- raw 模式下切到 `10-bit` 轴，波形整体高度不变（因为 Y 仍是 8-bit 码值）——这一条用于确认轴映射没被重复套用。
截图存 `docs/screenshots/task13-raw.png`。

- [ ] **Step 8: Commit**

```bash
git add src/gpu tests/raw-layout.test.ts docs/screenshots
git commit -m "feat(gpu): raw I420 plane path for exact code-value scopes"
```

---

### Task 14: 像素探针与 Document PiP

**Files:**
- Create: `src/ui/probe.ts`
- Modify: `src/content/index.ts`、`src/ui/hud.ts`

**Interfaces:**
- Produces:
  - `class Probe { constructor(video: HTMLVideoElement, hud: Hud); enable(): void; disable(): void }` — 按住 `Alt` 时显示 `+` 光标并采样视频像素，回调 `onSample(rgb: [number,number,number], pos: {x,y})`。
  - `openPipWindow(host: HTMLElement): Promise<Window>` — `documentPictureInPicture.requestWindow({ width: 900, height: 520 })` 后把 host 移入。

- [ ] **Step 1: 实现 `src/ui/probe.ts`**

```ts
export interface ProbeSample {
  rgb: [number, number, number];
  normalized: [number, number, number];
  x: number;
  y: number;
}

export class Probe {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private active = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onSample: (s: ProbeSample) => void,
  ) {}

  enable(): void {
    if (this.active) return;
    this.active = true;
    this.video.addEventListener('pointermove', this.handle);
  }

  disable(): void {
    this.active = false;
    this.video.removeEventListener('pointermove', this.handle);
  }

  private handle = (e: PointerEvent): void => {
    if (!e.altKey) return;
    const rect = this.video.getBoundingClientRect();
    const scaleX = this.video.videoWidth / rect.width;
    const scaleY = this.video.videoHeight / rect.height;
    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);
    if (x < 0 || y < 0 || x >= this.video.videoWidth || y >= this.video.videoHeight) return;
    this.canvas.width = 1;
    this.canvas.height = 1;
    try {
      this.ctx.drawImage(this.video, x, y, 1, 1, 0, 0, 1, 1);
      const d = this.ctx.getImageData(0, 0, 1, 1).data;
      this.onSample({
        rgb: [d[0]!, d[1]!, d[2]!],
        normalized: [d[0]! / 255, d[1]! / 255, d[2]! / 255],
        x,
        y,
      });
    } catch {
      // tainted canvas — L3 path handles capture elsewhere
    }
  };
}
```

- [ ] **Step 2: 在 HUD 中显示探针读数并在示波器画面上画十字线**

在 `Hud` 增加 `showProbe(s: ProbeSample)`：把码值与 Cb/Cr 写进 `status`，并在每个 `*:grat` canvas 上用高亮色（`#ffcf6e`）画 1px 十字，位置按当前 `ScopeOptions` 换算（waveform: `x = s.x / videoWidth * width`，`y = 1 - v`；vectorscope/cie 同理用 `chromaToScreen`/`xyToScreen`）。

- [ ] **Step 3: 实现 PiP 入口**

```ts
export async function openPipWindow(host: HTMLElement): Promise<Window> {
  const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: { width: number; height: number }): Promise<Window> } }).documentPictureInPicture;
  if (!dpip) throw new Error('documentPictureInPicture unavailable');
  const win = await dpip.requestWindow({ width: 900, height: 520 });
  win.document.body.style.margin = '0';
  win.document.body.appendChild(host);
  return win;
}
```

在 HUD 标题栏加一个 `⧉` 按钮调用它。

- [ ] **Step 4: 验证**

按住 `Alt` 在视频上移动：状态栏实时显示 `code (R,G,B)`；四个示波器上十字线跟着走。点击 `⧉`：示波器出现在独立置顶窗口，拖到第二屏后原视频页面不被遮挡。
截图存 `docs/screenshots/task14-probe-pip.png`。

- [ ] **Step 5: Commit**

```bash
git add src/ui src/content docs/screenshots
git commit -m "feat(ui): pixel probe crosshair and document picture-in-picture window"
```

---

### Task 15: 跨源兜底（L2 DNR + L3 tabCapture/Element Restriction）

**Files:**
- Create: `src/background/offscreen.ts`, `src/background/capture.ts`, `offscreen.html`
- Modify: `manifest.json`（加 `tabCapture`、`offscreen`、`declarativeNetRequest`）、`src/background/service-worker.ts`、`src/content/index.ts`（捕获状态提示）、`vite.config.ts`（offscreen 入口）

**Interfaces:**
- Produces:
  - `async function startElementCapture(tabId: number): Promise<{ streamId: string }>`（background 侧）
  - offscreen 文档消息协议：`{ type: 'capture:start', streamId }` / `{ type: 'capture:frame', bitmapTransfer }`
  - content 侧 `SignalSource` 扩展为 `{ kind: 'capture' }`，用 `MediaStreamTrackProcessor` 产出 `VideoFrame` 喂给 `SignalTexture`

- [ ] **Step 1: manifest 增加权限与 offscreen 文档**

```json
"permissions": ["activeTab", "scripting", "storage", "tabCapture", "offscreen", "declarativeNetRequestWithHostAccess"],
"host_permissions": ["<all_urls>"],
"web_accessible_resources": [{ "resources": ["offscreen.html"], "matches": ["<all_urls>"] }]
```

- [ ] **Step 2: 写 `src/background/capture.ts`**

```ts
export async function getTabStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) reject(new Error(chrome.runtime.lastError?.message ?? 'no stream id'));
      else resolve(id);
    });
  });
}

export async function ensureOffscreen(): Promise<void> {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA as chrome.offscreen.Reason],
    justification: 'Analyze video pixels for waveform scopes',
  });
}
```

- [ ] **Step 3: 写 `offscreen.html` + `src/background/offscreen.ts`**

```html
<!doctype html>
<html><head><meta charset="utf-8"></head><body><script src="offscreen.js"></script></body></html>
```

```ts
let track: MediaStreamTrack | null = null;
let processor: MediaStreamTrackProcessor<VideoFrame> | null = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'capture:start') {
    void start(msg.streamId).then(() => sendResponse({ ok: true })).catch((e: Error) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.type === 'capture:stop') {
    processor?.readable.cancel().catch(() => {});
    track?.stop();
    track = null;
    processor = null;
    sendResponse({ ok: true });
  }
  return undefined;
});

async function start(streamId: string): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error chrome-specific constraints
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  });
  track = stream.getVideoTracks()[0] ?? null;
  if (!track) throw new Error('no video track');
  processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  const pump = async (): Promise<void> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) return;
      const bitmap = await createImageBitmap(value);
      value.close();
      chrome.runtime.sendMessage({ type: 'capture:frame' }).catch(() => {});
      (globalThis as unknown as { lastBitmap?: ImageBitmap }).lastBitmap = bitmap;
      bitmap.close();
    }
  };
  void pump();
}
```

> 注意：offscreen 文档无法直接把 `ImageBitmap` 交给页面 canvas（跨进程），真正的像素通路是 content script **自己**用 `getUserMedia` 消费同一 `streamId`（同源要求满足时）。因此更稳的实现是：background 只负责 `getMediaStreamId`，content script 调用 `getUserMedia` 拿到流后直接 `new MediaStreamTrackProcessor` 在本页面上传 GPU。若 content script 因同源限制拿不到流，再退回 offscreen 并让 offscreen 用 `OffscreenCanvas` 做分析、把密度结果（小 buffer，几 KB）传回页面渲染。此步骤请按「先 content 侧消费」实现，offscreen 仅作备用路径。

- [ ] **Step 4: content 侧捕获（Element Restriction 优先）**

```ts
async function startCapture(video: HTMLVideoElement): Promise<MediaStreamTrack> {
  const streamId = await chrome.runtime.sendMessage({ type: 'capture:getStreamId' });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error chrome-specific
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  });
  const track = stream.getVideoTracks()[0]!;
  const restrictTo = (track as unknown as { restrictTo?: (t: unknown) => Promise<void> }).restrictTo;
  const RestrictionTarget = (window as unknown as { RestrictionTarget?: { fromElement(el: Element): Promise<unknown> } }).RestrictionTarget;
  if (restrictTo && RestrictionTarget) {
    try {
      await restrictTo.call(track, await RestrictionTarget.fromElement(video));
      return track;
    } catch {
      /* fall through to crop */
    }
  }
  const cropTo = (track as unknown as { cropTo?: (t: unknown) => Promise<void> }).cropTo;
  const CropTarget = (window as unknown as { CropTarget?: { fromElement(el: Element): Promise<unknown> } }).CropTarget;
  if (cropTo && CropTarget) {
    try {
      await cropTo.call(track, await CropTarget.fromElement(video));
    } catch {
      /* full tab */
    }
  }
  return track;
}
```

捕获到的 track 用 `new MediaStreamTrackProcessor({ track })` 逐帧 `VideoFrame`，喂 `new SignalTexture(device, frame)`（注意每帧都要在渲染后 `frame.close()`）。

- [ ] **Step 5: L2 DNR 规则（用户显式开启才生效）**

```ts
export async function installCorsRules(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [9001],
    addRules: [
      {
        id: 9001,
        priority: 1,
        action: {
          type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
          responseHeaders: [
            { header: 'access-control-allow-origin', operation: 'set', value: '*' },
          ],
        },
        condition: { resourceTypes: ['media' as chrome.declarativeNetRequest.ResourceType] },
      },
    ],
  });
}
```

> L2 只对**已经允许跨域读取**的媒体源有效；很多站点的签名 URL 会因 ACAO 与实际 Origin 不匹配而仍失败，这是预期，失败即转 L3。UI 上必须在开关旁标注「会修改响应头，仅用于分析」。

- [ ] **Step 6: 验证**

1. 找一条同源视频（本地 `file://` 或自建页）→ 走 L1，状态栏无提示。
2. 在 YouTube 上开启 → 若 tainted，则自动请求 tabCapture（浏览器会弹共享提示），成功后状态栏显示 `capture · heuristic`，示波器正常。
3. 在 `chrome://extensions` 的 errors 面板确认无未捕获异常。

- [ ] **Step 7: Commit**

```bash
git add manifest.json src/background src/content offscreen.html vite.config.ts
git commit -m "feat(capture): tab capture with element restriction and DNR cors fallback"
```

---

## 验收清单（对照 spec §9）

- [ ] `pnpm test` 全绿：`matrices` `primaries` `transfer` `quantize` `units` `locus` `range-detector` `reference` `signal-texture` `graticule` `vectorscope-geometry` `cie-geometry` `plan` `raw-layout`。
- [ ] 测试台 `?range=limited`：波形 75% 白条落在 75 IRE ±0.5，黑位在 0 IRE（轴高 6.3%）而非贴底；矢量六靶标偏差 < 2 px；CIE 三原色落顶点 ±0.004。
- [ ] 同一素材切换 `units`（ire → code8 → code10 → mv → nits）后**波形几何完全不变**，只有标签变化。这条是「码值轴」正确性的直接判据。
- [ ] Limited 与 Full 两版彩条的黑位在白/黑位高度上肉眼可区分（6.3% vs 0%）。
- [ ] Range 诊断：对「Limited 码值但标为 Full」的素材 3 帧后告警；对正常素材连续 10 秒不误报；手动切 `Force Full/Limited` 后纵向标尺立即变化。
- [ ] 1080p60 页面四示波器全开，perf 徽章 fps ≥ 55；单帧 compute 分派无 `GPUValidationError`。
- [ ] YouTube 按 `f` 全屏后 HUD 仍在可视区；`Alt+S` 关闭后 `device.lost` 未触发、无 WebGPU 泄漏警告。
- [ ] 关闭 HUD 再打开 5 次，`performance.memory` 无持续增长（说明 `destroy()` 覆盖了 texture/buffer）。
- [ ] README 写完 spec §8 的四条已知限制（显示参考信号、DRM、L3 分辨率、跨源无 CORS）。

## 已知的取舍（写进 README）

1. **默认观测显示参考信号。** `copyExternalImageToTexture` 拿到的是浏览器色彩管理之后的 RGB。对 SDR Rec.709 内容，range 展开已被 `blend()` 还原，观测有效；对 PQ/HLG 或非 Rec.709 原色，必须切 Raw Plane 模式才准。
2. **nits 标尺假设 PQ。** 轴坐标被直接当 PQ 信号解读。SDR 内容切到 nits 只是换一组参考刻度，UI 会标注 `PQ assumed`。
3. **Raw 模式不提供 RGB Parade。** 只有 Y/U/V 平面，没有逐通道 R/G/B；parade 会把 Y 复制到三栏并在标签上标注 `Y only`。
4. **L3 tabCapture 的分辨率等于视频在页面上的显示尺寸**，不是源分辨率；range 只能靠统计推断，状态栏会显示 `heuristic`。
