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

/**
 * Effective DPR of the window that owns `canvas`.
 *
 * A Document PiP window is an independent browsing context whose DPR ignores
 * browser page zoom on the opener tab and adapts to whichever display the
 * floating window sits on. Reading global `window.devicePixelRatio` from the
 * content script gave the wrong DPR whenever the page was zoomed or on another
 * monitor, desynchronising the plot box from the graticule.
 */
export function canvasDpr(canvas: HTMLCanvasElement): number {
  const win = canvas.ownerDocument?.defaultView ?? window;
  return Math.min(win.devicePixelRatio || 1, 2.5);
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
  const canvas = gpu.context.canvas as HTMLCanvasElement;
  const dpr = canvasDpr(canvas);
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'premultiplied' });
  return true;
}
