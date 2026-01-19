import { RENDERER_CONTRACT_SCHEMA_VERSION } from '../../../renderer-contract/dist/index.js';
import { createWebGpuRenderer } from '../../../renderer-webgpu/dist/index.js';
import type { RenderCommandBuffer } from '../../../renderer-contract/dist/index.js';
import type { WebGpuRenderer } from '../../../renderer-webgpu/dist/index.js';

const output = document.querySelector<HTMLPreElement>('#output');
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');

async function run(): Promise<void> {
  if (!output || !canvas) {
    return;
  }

  const outputElement = output;
  const canvasElement = canvas;

  let ipcStatus = 'IPC pending…';
  let webgpuStatus = 'WebGPU pending…';

  function updateOutput(): void {
    outputElement.textContent = [ipcStatus, webgpuStatus].join('\n');
  }

  updateOutput();

  try {
    const pong = await (globalThis as unknown as Window).idleEngine.ping('hello');
    ipcStatus = `IPC ok: ${pong}`;
  } catch (error: unknown) {
    ipcStatus = `IPC error: ${String(error)}`;
  }

  updateOutput();

  const clearColorRgba = 0x18_2a_44_ff;
  let renderer: WebGpuRenderer | undefined;
  let animationFrame: number | undefined;
  let renderFrame = 0;
  let recovering = false;

  const resizeObserver = new ResizeObserver(() => {
    renderer?.resize();
  });
  resizeObserver.observe(canvasElement);

  const render = (): void => {
    if (!renderer) {
      return;
    }

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 0,
        simTimeMs: 0,
        renderFrame,
        contentHash: 'content:dev',
      },
      passes: [{ id: 'world' }],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: clearColorRgba,
        },
      ],
    };

    try {
      renderer.resize();
      renderer.render(rcb);
    } catch (error: unknown) {
      void recover(String(error));
      return;
    }
    renderFrame += 1;
    animationFrame = requestAnimationFrame(render);
  };

  function stopLoop(): void {
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
  }

  async function recover(reason: string): Promise<void> {
    if (recovering) {
      return;
    }

    recovering = true;
    stopLoop();
    renderer?.dispose();
    renderer = undefined;

    webgpuStatus = `WebGPU lost (${reason}). Attempting recovery…`;
    updateOutput();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      renderer = await createWebGpuRenderer(canvasElement, {
        onDeviceLost: (error) => {
          void recover(error.reason ?? 'unknown');
        },
      });
      renderFrame = 0;
      webgpuStatus = 'WebGPU ok (recovered).';
      updateOutput();
      animationFrame = requestAnimationFrame(render);
    } catch (error: unknown) {
      webgpuStatus = `WebGPU recovery failed: ${String(error)}`;
      updateOutput();
    } finally {
      recovering = false;
    }
  }

  try {
    renderer = await createWebGpuRenderer(canvasElement, {
      onDeviceLost: (error) => {
        void recover(error.reason ?? 'unknown');
      },
    });
    webgpuStatus = 'WebGPU ok.';
    updateOutput();
    animationFrame = requestAnimationFrame(render);
  } catch (error: unknown) {
    webgpuStatus = `WebGPU error: ${String(error)}`;
    updateOutput();
  }

  addEventListener('beforeunload', () => {
    stopLoop();
    resizeObserver.disconnect();
    renderer?.dispose();
  });
}

void run();
