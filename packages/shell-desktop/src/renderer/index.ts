import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import { createWebGpuRenderer } from '@idle-engine/renderer-webgpu';
import type {
  AssetId,
  AssetManifest,
  RenderCommandBuffer,
  Sha256Hex,
} from '@idle-engine/renderer-contract';
import type { IdleEngineApi, ShellInputEventEnvelope } from '../ipc.js';
import type { InputEventModifiers, PointerInputEvent, WheelInputEvent } from '@idle-engine/core';
import type { WebGpuBitmapFont, WebGpuRenderer } from '@idle-engine/renderer-webgpu';

const output = document.querySelector<HTMLPreElement>('#output');
const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
const errorBanner = document.querySelector<HTMLParagraphElement>('#error-banner');

const SAMPLE_PACK_SLUG = '@idle-engine/sample-pack';
const SAMPLE_PACK_ASSETS_ROOT_URL = new URL(
  `../../../content-sample/content/compiled/${SAMPLE_PACK_SLUG}.assets/`,
  import.meta.url,
);
const SAMPLE_PACK_RENDERER_MANIFEST_URL = new URL(
  'renderer-assets.manifest.json',
  SAMPLE_PACK_ASSETS_ROOT_URL,
);

type GeneratedFontGlyph = Readonly<{
  codePoint: number;
  x: number;
  y: number;
  width: number;
  height: number;
  xOffsetPx: number;
  yOffsetPx: number;
  xAdvancePx: number;
}>;

type GeneratedFontMetadata = Readonly<{
  schemaVersion: 1;
  id: string;
  technique: 'msdf';
  baseFontSizePx: number;
  lineHeightPx: number;
  glyphs: readonly GeneratedFontGlyph[];
  fallbackCodePoint?: number;
  msdf: {
    pxRange: number;
  };
}>;

function getIdleEngineApi(): IdleEngineApi {
  return globalThis.idleEngine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${key}: expected a finite number.`);
  }
  return value;
}

function parseFontMetadata(
  candidate: unknown,
  assetId: string,
): GeneratedFontMetadata {
  if (!isRecord(candidate)) {
    throw new TypeError('Invalid font metadata: expected an object.');
  }

  const schemaVersion = candidate['schemaVersion'];
  if (schemaVersion !== 1) {
    throw new TypeError('Invalid font metadata: expected schemaVersion 1.');
  }

  const id = candidate['id'];
  if (typeof id !== 'string' || id !== assetId) {
    throw new TypeError(`Invalid font metadata: expected id "${assetId}".`);
  }

  const technique = candidate['technique'];
  if (technique !== 'msdf') {
    throw new TypeError(
      `Invalid font metadata: expected msdf technique for ${assetId}.`,
    );
  }

  const baseFontSizePx = extractFiniteNumber(candidate, 'baseFontSizePx');
  const lineHeightPx = extractFiniteNumber(candidate, 'lineHeightPx');

  const glyphsCandidate = candidate['glyphs'];
  if (!Array.isArray(glyphsCandidate)) {
    throw new TypeError(
      `Invalid font metadata: expected glyphs array for ${assetId}.`,
    );
  }

  const glyphs: GeneratedFontGlyph[] = [];
  for (const glyphCandidate of glyphsCandidate) {
    if (!isRecord(glyphCandidate)) {
      continue;
    }

    glyphs.push({
      codePoint: extractFiniteNumber(glyphCandidate, 'codePoint'),
      x: extractFiniteNumber(glyphCandidate, 'x'),
      y: extractFiniteNumber(glyphCandidate, 'y'),
      width: extractFiniteNumber(glyphCandidate, 'width'),
      height: extractFiniteNumber(glyphCandidate, 'height'),
      xOffsetPx: extractFiniteNumber(glyphCandidate, 'xOffsetPx'),
      yOffsetPx: extractFiniteNumber(glyphCandidate, 'yOffsetPx'),
      xAdvancePx: extractFiniteNumber(glyphCandidate, 'xAdvancePx'),
    });
  }

  const msdfCandidate = candidate['msdf'];
  if (!isRecord(msdfCandidate)) {
    throw new TypeError(
      `Invalid font metadata: expected msdf config for ${assetId}.`,
    );
  }

  const pxRange = extractFiniteNumber(msdfCandidate, 'pxRange');

  const fallbackCandidate = candidate['fallbackCodePoint'];
  const fallbackCodePoint =
    fallbackCandidate === undefined
      ? undefined
      : extractFiniteNumber(candidate, 'fallbackCodePoint');

  return {
    schemaVersion: 1,
    id,
    technique,
    baseFontSizePx,
    lineHeightPx,
    glyphs,
    ...(fallbackCodePoint === undefined ? {} : { fallbackCodePoint }),
    msdf: { pxRange },
  };
}

async function readAssetBytes(api: IdleEngineApi, url: URL): Promise<Uint8Array> {
  const buffer = await api.readAsset(url.toString());
  return new Uint8Array(buffer);
}

async function readAssetJson(api: IdleEngineApi, url: URL): Promise<unknown> {
  const bytes = await readAssetBytes(api, url);
  const decoded = new TextDecoder().decode(bytes);
  return JSON.parse(decoded) as unknown;
}

async function loadPngAsset(
  api: IdleEngineApi,
  url: URL,
): Promise<GPUImageCopyExternalImageSource> {
  const bytes = await readAssetBytes(api, url);
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const blob = new Blob([ownedBytes], { type: 'image/png' });

  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob);
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadSamplePackRendererManifest(api: IdleEngineApi): Promise<AssetManifest> {
  const candidate = await readAssetJson(api, SAMPLE_PACK_RENDERER_MANIFEST_URL);
  return candidate as AssetManifest;
}

async function loadSamplePackFont(
  api: IdleEngineApi,
  assetId: AssetId,
  _contentHash: Sha256Hex,
): Promise<WebGpuBitmapFont> {
  const encodedAssetId = encodeURIComponent(encodeURIComponent(assetId));
  const fontRootUrl = new URL(`fonts/${encodedAssetId}/`, SAMPLE_PACK_ASSETS_ROOT_URL);
  const [metadataCandidate, atlasImage] = await Promise.all([
    readAssetJson(api, new URL('font.json', fontRootUrl)),
    loadPngAsset(api, new URL('atlas.png', fontRootUrl)),
  ]);

  const metadata = parseFontMetadata(metadataCandidate, assetId);

  return {
    image: atlasImage,
    baseFontSizePx: metadata.baseFontSizePx,
    lineHeightPx: metadata.lineHeightPx,
    glyphs: metadata.glyphs,
    ...(metadata.fallbackCodePoint === undefined
      ? {}
      : { fallbackCodePoint: metadata.fallbackCodePoint }),
    technique: metadata.technique,
    msdf: metadata.msdf,
  };
}

function stripAtlasDraws(rcb: RenderCommandBuffer): RenderCommandBuffer {
  const draws = (rcb as { draws?: unknown }).draws;
  if (!Array.isArray(draws)) {
    return rcb;
  }

  const filtered = draws.filter((draw) => {
    if (!isRecord(draw)) {
      return true;
    }
    return draw.kind !== 'image' && draw.kind !== 'text';
  });

  if (filtered.length === draws.length) {
    return rcb;
  }

  return {
    ...rcb,
    draws: filtered as RenderCommandBuffer['draws'],
  };
}

async function run(): Promise<void> {
  if (!output || !canvas) {
    return;
  }

  const outputElement = output;
  const canvasElement = canvas;
  const idleEngineApi = getIdleEngineApi();

  type RendererLogSeverity = 'debug' | 'info' | 'warn' | 'error';
  type RendererWebGpuHealthStatus = 'ok' | 'lost' | 'recovered';

  let ipcStatus = 'IPC pending…';
  let simStatus = 'Sim pending…';
  let webgpuStatus = 'WebGPU pending…';
  let rendererState = 'initializing';
  let webgpuHealthStatus: RendererWebGpuHealthStatus = 'lost';
  let webgpuLastLossReason: string | undefined = 'WebGPU status pending.';

  const sendRendererLog = (
    severity: RendererLogSeverity,
    subsystem: string,
    message: string,
    metadata?: Readonly<Record<string, unknown>>,
  ): void => {
    try {
      idleEngineApi.sendRendererLog({
        severity,
        subsystem,
        message,
        ...(metadata === undefined ? {} : { metadata }),
      });
    } catch {
      // Keep renderer UI flow resilient even when diagnostics transport fails.
    }
  };

  const deriveErrorBannerText = (): string | undefined => {
    const candidates = [ipcStatus, simStatus, webgpuStatus];
    return candidates.find((value) => /\b(error|failed|crashed|lost|stopped)\b/i.test(value));
  };

  const setErrorBannerText = (nextText: string | undefined): void => {
    if (!errorBanner) {
      return;
    }

    if (nextText === undefined) {
      errorBanner.textContent = '';
      errorBanner.hidden = true;
      return;
    }

    errorBanner.textContent = nextText;
    errorBanner.hidden = false;
  };

  const publishRendererDiagnostics = (): void => {
    try {
      const bannerText = errorBanner?.hidden === true
        ? undefined
        : errorBanner?.textContent?.trim() || undefined;

      idleEngineApi.sendRendererDiagnostics({
        outputText: outputElement.textContent ?? '',
        ...(bannerText === undefined ? {} : { errorBannerText: bannerText }),
        rendererState,
        webgpu: {
          status: webgpuHealthStatus,
          ...(webgpuLastLossReason === undefined ? {} : { lastLossReason: webgpuLastLossReason }),
        },
      });
    } catch {
      // Keep renderer UI flow resilient even when diagnostics transport fails.
    }
  };

  function updateOutput(): void {
    outputElement.textContent = [ipcStatus, simStatus, webgpuStatus].join('\n');
    setErrorBannerText(deriveErrorBannerText());
    publishRendererDiagnostics();
  }

  updateOutput();

  try {
    const pong = await idleEngineApi.ping('hello');
    ipcStatus = `IPC ok: ${pong}`;
    sendRendererLog('info', 'ipc', 'Renderer ping succeeded.');
  } catch (error: unknown) {
    ipcStatus = `IPC error: ${String(error)}`;
    sendRendererLog('error', 'ipc', 'Renderer ping failed.', { error: String(error) });
  }

  updateOutput();

  const clearColorRgba = 0x18_2a_44_ff;
  let renderer: WebGpuRenderer | undefined;
  let rendererAssetsLoaded = false;
  let animationFrame: number | undefined;
  let renderFrame = 0;
  let recovering = false;
  let latestRcb: RenderCommandBuffer | undefined;
  let unsubscribeFrames: (() => void) | undefined;
  let unsubscribeSimStatus: (() => void) | undefined;

  const loadRendererAssets = async (targetRenderer: WebGpuRenderer): Promise<string | undefined> => {
    try {
      await targetRenderer.loadAssets(
        await loadSamplePackRendererManifest(idleEngineApi),
        {
          loadImage: async (assetId: AssetId, _contentHash: Sha256Hex) => {
            throw new Error(`Missing image loader for asset ${assetId}.`);
          },
          loadFont: (assetId, contentHash) =>
            loadSamplePackFont(idleEngineApi, assetId, contentHash),
        },
      );

      rendererAssetsLoaded = true;
      return undefined;
    } catch (error: unknown) {
      rendererAssetsLoaded = false;
      return String(error);
    }
  };

  try {
    unsubscribeSimStatus = idleEngineApi.onSimStatus((status) => {
      if (status.kind === 'starting') {
        simStatus = 'Sim starting…';
        rendererState = 'starting';
      } else if (status.kind === 'running') {
        simStatus = 'Sim running.';
        if (rendererState === 'starting') {
          rendererState = 'running';
        }
      } else {
        const exitCode = status.exitCode === undefined ? '' : ` (exitCode=${status.exitCode})`;
        simStatus = `Sim ${status.kind}${exitCode}: ${status.reason}. Reload to restart.`;
        rendererState = status.kind;
        sendRendererLog('error', 'sim', `Sim ${status.kind}.`, {
          reason: status.reason,
          ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
        });
      }
      updateOutput();
    });
  } catch (error: unknown) {
    simStatus = `Sim error: ${String(error)}`;
    rendererState = 'sim-error';
    sendRendererLog('error', 'sim', 'Failed to subscribe to sim status updates.', { error: String(error) });
    updateOutput();
  }

  try {
    unsubscribeFrames = idleEngineApi.onFrame((frame) => {
      latestRcb = frame;
      simStatus = `Sim step=${frame.frame.step} simTimeMs=${frame.frame.simTimeMs}`;
      if (rendererState === 'starting') {
        rendererState = 'running';
      }
      updateOutput();
    });
  } catch (error: unknown) {
    simStatus = `Sim error: ${String(error)}`;
    rendererState = 'sim-error';
    sendRendererLog('error', 'sim', 'Failed to subscribe to frame updates.', { error: String(error) });
    updateOutput();
  }

  addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !event.repeat) {
      idleEngineApi.sendControlEvent({
        intent: 'collect',
        phase: 'start',
      });
    }
  });

  const buildPointerModifiers = (event: MouseEvent): InputEventModifiers => ({
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  });

  const buildPointerInputEvent = (
    intent: PointerInputEvent['intent'],
    phase: PointerInputEvent['phase'],
    event: PointerEvent,
  ): PointerInputEvent => {
    const rect = canvasElement.getBoundingClientRect();
    return {
      kind: 'pointer',
      intent,
      phase,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      button: event.button,
      buttons: event.buttons,
      pointerType: event.pointerType as PointerInputEvent['pointerType'],
      modifiers: buildPointerModifiers(event),
    };
  };

  const buildWheelInputEvent = (event: WheelEvent): WheelInputEvent => {
    const rect = canvasElement.getBoundingClientRect();
    return {
      kind: 'wheel',
      intent: 'mouse-wheel',
      phase: 'repeat',
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaZ: event.deltaZ,
      deltaMode: event.deltaMode as WheelInputEvent['deltaMode'],
      modifiers: buildPointerModifiers(event),
    };
  };

  const sendTypedInputEvent = (envelope: ShellInputEventEnvelope): void => {
    idleEngineApi.sendInputEvent(envelope);
  };

  const sendPointerEvent = (
    intent: PointerInputEvent['intent'],
    phase: PointerInputEvent['phase'],
    event: PointerEvent,
  ): void => {
    sendTypedInputEvent({
      schemaVersion: 1,
      event: buildPointerInputEvent(intent, phase, event),
    });
  };

  const sendWheelEvent = (event: WheelEvent): void => {
    sendTypedInputEvent({
      schemaVersion: 1,
      event: buildWheelInputEvent(event),
    });
  };

  let pendingPointerMove: PointerEvent | undefined;
  let pointerMoveRaf: number | undefined;

  const flushPointerMove = (): void => {
    const event = pendingPointerMove;
    pendingPointerMove = undefined;
    pointerMoveRaf = undefined;
    if (!event) {
      return;
    }
    sendPointerEvent('mouse-move', 'repeat', event);
  };

  canvasElement.addEventListener('pointerdown', (event) => {
    sendPointerEvent('mouse-down', 'start', event);
  });

  canvasElement.addEventListener('pointerup', (event) => {
    sendPointerEvent('mouse-up', 'end', event);
  });

  canvasElement.addEventListener('pointermove', (event) => {
    pendingPointerMove = event;
    if (pointerMoveRaf !== undefined) {
      return;
    }
    // Coalesce pointer moves to one event per frame.
    pointerMoveRaf = requestAnimationFrame(() => {
      flushPointerMove();
    });
  });

  canvasElement.addEventListener('wheel', (event) => {
    sendWheelEvent(event);
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
    scene: {
      camera: latestRcb?.scene?.camera ?? { x: 0, y: 0, zoom: 1 },
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
    const strippedRcb = rendererAssetsLoaded ? rcb : stripAtlasDraws(rcb);

    try {
      renderer.resize();
      renderer.render(strippedRcb);
    } catch (error: unknown) {
      sendRendererLog('error', 'webgpu', 'Renderer frame render failed; attempting recovery.', {
        error: String(error),
      });
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
    rendererState = 'recovering';
    webgpuHealthStatus = 'lost';
    webgpuLastLossReason = reason;
    stopLoop();
    renderer?.dispose();
    renderer = undefined;
    rendererAssetsLoaded = false;

    webgpuStatus = `WebGPU lost (${reason}). Attempting recovery…`;
    sendRendererLog('warn', 'webgpu', 'WebGPU device lost; attempting recovery.', { reason });
    updateOutput();

    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      renderer = await createWebGpuRenderer(canvasElement, {
        onDeviceLost: (error) => {
          void recover(error.reason ?? 'unknown');
        },
      });

      renderFrame = 0;
      const assetsError = await loadRendererAssets(renderer);
      webgpuStatus = assetsError
        ? `WebGPU ok (recovered). Assets unavailable: ${assetsError}`
        : 'WebGPU ok (recovered). Assets loaded.';
      webgpuHealthStatus = 'recovered';
      rendererState = 'running';
      if (assetsError) {
        sendRendererLog('warn', 'webgpu', 'WebGPU recovered, but renderer assets failed to load.', {
          assetsError,
        });
      } else {
        sendRendererLog('info', 'webgpu', 'WebGPU recovered and renderer assets loaded.');
      }
      updateOutput();
      animationFrame = requestAnimationFrame(render);
    } catch (error: unknown) {
      webgpuStatus = `WebGPU recovery failed: ${String(error)}`;
      webgpuHealthStatus = 'lost';
      webgpuLastLossReason = String(error);
      rendererState = 'webgpu-error';
      sendRendererLog('error', 'webgpu', 'WebGPU recovery failed.', { error: String(error) });
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

    const assetsError = renderer ? await loadRendererAssets(renderer) : undefined;
    webgpuStatus = assetsError
      ? `WebGPU ok. Assets unavailable: ${assetsError}`
      : 'WebGPU ok. Assets loaded.';
    webgpuHealthStatus = 'ok';
    webgpuLastLossReason = undefined;
    rendererState = 'running';
    if (assetsError) {
      sendRendererLog('warn', 'webgpu', 'WebGPU initialized, but renderer assets failed to load.', {
        assetsError,
      });
    } else {
      sendRendererLog('info', 'webgpu', 'WebGPU initialized and renderer assets loaded.');
    }
    updateOutput();
    animationFrame = requestAnimationFrame(render);
  } catch (error: unknown) {
    webgpuStatus = `WebGPU error: ${String(error)}`;
    webgpuHealthStatus = 'lost';
    webgpuLastLossReason = String(error);
    rendererState = 'webgpu-error';
    sendRendererLog('error', 'webgpu', 'WebGPU initialization failed.', { error: String(error) });
    updateOutput();
  }

  addEventListener('beforeunload', () => {
    if (pointerMoveRaf !== undefined) {
      cancelAnimationFrame(pointerMoveRaf);
      pointerMoveRaf = undefined;
      pendingPointerMove = undefined;
    }
    stopLoop();
    resizeObserver.disconnect();
    unsubscribeFrames?.();
    unsubscribeSimStatus?.();
    renderer?.dispose();
    rendererAssetsLoaded = false;
    rendererState = 'stopped';
    publishRendererDiagnostics();
    sendRendererLog('info', 'renderer', 'Renderer disposed during unload.');
  });
}

void run();
