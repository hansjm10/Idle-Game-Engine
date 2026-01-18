import { RENDERER_CONTRACT_SCHEMA_VERSION } from '../../node_modules/@idle-engine/renderer-contract/dist/index.js';
import { createWebGpuRenderer } from '../../node_modules/@idle-engine/renderer-webgpu/dist/index.js';
import type { RenderCommandBuffer } from '../../node_modules/@idle-engine/renderer-contract/dist/index.js';
import type { WebGpuRenderer } from '../../node_modules/@idle-engine/renderer-webgpu/dist/index.js';

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
    const pong = await window.idleEngine.ping('hello');
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

    renderer.render(rcb);
    renderFrame += 1;
    animationFrame = window.requestAnimationFrame(render);
  };

  const stopLoop = (): void => {
    if (animationFrame !== undefined) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
  };

  const recover = async (reason: string): Promise<void> => {
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
      animationFrame = window.requestAnimationFrame(render);
    } catch (error: unknown) {
      webgpuStatus = `WebGPU recovery failed: ${String(error)}`;
      updateOutput();
    } finally {
      recovering = false;
    }
  };

  try {
    renderer = await createWebGpuRenderer(canvasElement, {
      onDeviceLost: (error) => {
        void recover(error.reason ?? 'unknown');
      },
    });
    webgpuStatus = 'WebGPU ok.';
    updateOutput();
    animationFrame = window.requestAnimationFrame(render);
  } catch (error: unknown) {
    webgpuStatus = `WebGPU error: ${String(error)}`;
    updateOutput();
  }

  window.addEventListener('beforeunload', () => {
    stopLoop();
    resizeObserver.disconnect();
    renderer?.dispose();
  });
}

void run();
