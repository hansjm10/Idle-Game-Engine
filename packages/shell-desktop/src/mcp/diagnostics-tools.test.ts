import { describe, expect, it, vi } from 'vitest';
import {
  registerDiagnosticsTools,
  type DiagnosticsLogEntry,
  type DiagnosticsMcpController,
  type RendererDiagnosticsStatus,
  type WebGpuHealthProbe,
} from './diagnostics-tools.js';

type ToolHandler = (args: unknown) => Promise<unknown>;

const parseToolJson = (result: unknown): unknown => {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Expected tool result to be an object');
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Expected tool result to have content');
  }

  const first = content[0] as { type?: unknown; text?: unknown };
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected tool result content[0] to be text');
  }

  return JSON.parse(first.text) as unknown;
};

const buildLogs = (): readonly DiagnosticsLogEntry[] => ([
  {
    id: 1,
    timestampMs: 100,
    source: 'main',
    subsystem: 'sim',
    severity: 'info',
    message: 'Sim initialized',
  },
  {
    id: 2,
    timestampMs: 200,
    source: 'renderer',
    subsystem: 'webgpu',
    severity: 'warn',
    message: 'WebGPU device lost',
  },
  {
    id: 3,
    timestampMs: 300,
    source: 'renderer',
    subsystem: 'webgpu',
    severity: 'error',
    message: 'WebGPU recovery failed',
  },
  {
    id: 4,
    timestampMs: 400,
    source: 'main',
    subsystem: 'mcp',
    severity: 'info',
    message: 'MCP server started',
  },
]);

describe('shell-desktop MCP diagnostics tools', () => {
  const registerTools = (
    controllerOverrides: Partial<DiagnosticsMcpController> = {},
  ): Readonly<{ tools: Map<string, ToolHandler> }> => {
    const tools = new Map<string, ToolHandler>();

    const controller: DiagnosticsMcpController = {
      getRendererStatus: () => undefined,
      getLogs: () => buildLogs(),
      getWebGpuHealth: () => ({
        status: 'ok',
        lastEventTimestampMs: 400,
      }),
      ...controllerOverrides,
    };

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerDiagnosticsTools(server, controller);
    return { tools };
  };

  it('registers the diagnostics tool surface', () => {
    const { tools } = registerTools();

    expect(Array.from(tools.keys()).sort()).toEqual([
      'logs.since',
      'logs.tail',
      'probe.webgpuHealth',
      'renderer.status',
    ]);
  });

  it('returns renderer status and WebGPU probe data', async () => {
    const rendererStatus: RendererDiagnosticsStatus = {
      outputText: 'IPC ok\nSim running\nWebGPU ok.',
      errorBannerText: 'none',
      rendererState: 'running',
      updatedAtMs: 1234,
    };
    const webGpuHealth: WebGpuHealthProbe = {
      status: 'recovered',
      lastLossReason: 'Device reset',
      lastEventTimestampMs: 1200,
    };

    const { tools } = registerTools({
      getRendererStatus: () => rendererStatus,
      getWebGpuHealth: () => webGpuHealth,
    });

    const rendererStatusHandler = tools.get('renderer.status');
    const rendererStatusPayload = parseToolJson(await rendererStatusHandler?.({}));
    expect(rendererStatusPayload).toEqual({
      ok: true,
      status: rendererStatus,
    });

    const probeHandler = tools.get('probe.webgpuHealth');
    const probePayload = parseToolJson(await probeHandler?.({}));
    expect(probePayload).toEqual({
      ok: true,
      health: webGpuHealth,
    });
  });

  it('tails and queries logs with structured filters', async () => {
    const { tools } = registerTools();

    const tailHandler = tools.get('logs.tail');
    const tailPayload = parseToolJson(await tailHandler?.({ limit: 2 })) as {
      entries?: Array<{ id?: unknown }>;
      totalMatched?: unknown;
      nextCursor?: unknown;
    };
    expect(tailPayload.totalMatched).toBe(4);
    expect(tailPayload.nextCursor).toBe(4);
    expect(tailPayload.entries?.map((entry) => entry.id)).toEqual([3, 4]);

    const filteredTailPayload = parseToolJson(await tailHandler?.({
      source: 'renderer',
      subsystem: 'webgpu',
      severity: 'error',
    })) as {
      entries?: Array<{ id?: unknown }>;
      totalMatched?: unknown;
      nextCursor?: unknown;
    };
    expect(filteredTailPayload.totalMatched).toBe(1);
    expect(filteredTailPayload.nextCursor).toBe(3);
    expect(filteredTailPayload.entries?.map((entry) => entry.id)).toEqual([3]);

    const sinceHandler = tools.get('logs.since');
    const sincePayload = parseToolJson(await sinceHandler?.({
      cursor: 1,
      source: 'renderer',
    })) as {
      entries?: Array<{ id?: unknown }>;
      totalMatched?: unknown;
      nextCursor?: unknown;
    };
    expect(sincePayload.totalMatched).toBe(2);
    expect(sincePayload.nextCursor).toBe(3);
    expect(sincePayload.entries?.map((entry) => entry.id)).toEqual([2, 3]);
  });

  it('rejects invalid log query payloads', async () => {
    const { tools } = registerTools();

    const tailHandler = tools.get('logs.tail');
    await expect(tailHandler?.({ limit: 0 })).rejects.toThrow(/limit/);
    await expect(tailHandler?.({ subsystem: ' ' })).rejects.toThrow(/subsystem/);
    await expect(tailHandler?.({ severity: 'fatal' })).rejects.toThrow(/severity/);

    const sinceHandler = tools.get('logs.since');
    await expect(sinceHandler?.({})).rejects.toThrow(/cursor/);
    await expect(sinceHandler?.({ cursor: -1 })).rejects.toThrow(/cursor/);
  });
});
