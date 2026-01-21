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
  let simStatus = 'Sim pending…';
  let webgpuStatus = 'WebGPU pending…';

  function updateOutput(): void {
    outputElement.textContent = [ipcStatus, simStatus, webgpuStatus].join('\n');
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
  let latestRcb: RenderCommandBuffer | undefined;
  let unsubscribeFrames: (() => void) | undefined;
  let unsubscribeSimStatus: (() => void) | undefined;

  try {
    unsubscribeSimStatus = (globalThis as unknown as Window).idleEngine.onSimStatus((status) => {
      if (status.kind === 'starting') {
        simStatus = 'Sim starting…';
      } else if (status.kind === 'running') {
        simStatus = 'Sim running.';
      } else {
        const exitCode = status.exitCode === undefined ? '' : ` (exitCode=${status.exitCode})`;
        simStatus = `Sim ${status.kind}${exitCode}: ${status.reason}. Reload to restart.`;
      }
      updateOutput();
    });
  } catch (error: unknown) {
    simStatus = `Sim error: ${String(error)}`;
    updateOutput();
  }

  try {
    unsubscribeFrames = (globalThis as unknown as Window).idleEngine.onFrame((frame) => {
      latestRcb = frame;
      simStatus = `Sim step=${frame.frame.step} simTimeMs=${frame.frame.simTimeMs}`;
      updateOutput();
    });
  } catch (error: unknown) {
    simStatus = `Sim error: ${String(error)}`;
    updateOutput();
  }

  addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !event.repeat) {
      (globalThis as unknown as Window).idleEngine.sendControlEvent({
        intent: 'collect',
        phase: 'start',
      });
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    renderer?.resize();
  });
  resizeObserver.observe(canvasElement);

  const buildFallbackRcb = (frameCount: number): RenderCommandBuffer => ({
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      step: latestRcb?.frame.step ?? 0,
      simTimeMs: latestRcb?.frame.simTimeMs ?? 0,
      renderFrame: frameCount,
      contentHash: 'content:dev',
    },
    passes: [{ id: 'world' }, { id: 'ui' }],
    draws: [
      {
        kind: 'clear',
        passId: 'world',
        sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        colorRgba: clearColorRgba,
      },
      {
        kind: 'rect',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        x: 20,
        y: 20,
        width: 240,
        height: 120,
        colorRgba: 0x00_00_00_80,
      },
      {
        kind: 'scissorPush',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
        x: 32,
        y: 32,
        width: 216,
        height: 96,
      },
      {
        kind: 'rect',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
        x: 32,
        y: 32,
        width: 300,
        height: 32,
        colorRgba: 0x2a_4f_8a_ff,
      },
      {
        kind: 'rect',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
        x: 32,
        y: 72,
        width: 300,
        height: 32,
        colorRgba: 0x8a_2a_4f_ff,
      },
      {
        kind: 'scissorPop',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 4 },
      },
    ],
  });

  const render = (): void => {
    if (!renderer) {
      return;
    }

    const rcb = latestRcb ?? buildFallbackRcb(renderFrame);

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
    unsubscribeFrames?.();
    unsubscribeSimStatus?.();
    renderer?.dispose();
  });
}

void run();
