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
