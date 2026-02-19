import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import * as z from 'zod/v4';

export type DiagnosticsLogSource = 'main' | 'renderer';
export type DiagnosticsLogSeverity = 'debug' | 'info' | 'warn' | 'error';
export type DiagnosticsWebGpuHealthStatus = 'ok' | 'lost' | 'recovered';

export type DiagnosticsLogEntry = Readonly<{
  id: number;
  timestampMs: number;
  source: DiagnosticsLogSource;
  subsystem: string;
  severity: DiagnosticsLogSeverity;
  message: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type RendererDiagnosticsStatus = Readonly<{
  outputText: string;
  errorBannerText?: string;
  rendererState?: string;
  updatedAtMs: number;
}>;

export type WebGpuHealthProbe = Readonly<{
  status: DiagnosticsWebGpuHealthStatus;
  lastLossReason?: string;
  lastEventTimestampMs?: number;
}>;

export type DiagnosticsMcpController = Readonly<{
  getRendererStatus: () => RendererDiagnosticsStatus | undefined;
  getLogs: () => readonly DiagnosticsLogEntry[];
  getWebGpuHealth: () => WebGpuHealthProbe;
}>;

type TextToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

type ToolRegistrar = Readonly<{
  registerTool: (
    name: string,
    config: Readonly<{ title: string; description: string; inputSchema?: AnySchema | ZodRawShapeCompat }>,
    handler: (...args: unknown[]) => Promise<TextToolResult>,
  ) => void;
}>;

const LOG_FILTER_SCHEMA = z.object({
  source: z.enum(['main', 'renderer']).optional(),
  subsystem: z.string().trim().min(1).optional(),
  severity: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
}).strict();

const LOGS_SINCE_ARGS_SCHEMA = LOG_FILTER_SCHEMA.extend({
  cursor: z.number().int().min(0),
}).strict();

const buildTextResult = (value: unknown): TextToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

function filterLogs(
  logs: readonly DiagnosticsLogEntry[],
  options: Readonly<{
    source?: DiagnosticsLogSource;
    subsystem?: string;
    severity?: DiagnosticsLogSeverity;
  }>,
): DiagnosticsLogEntry[] {
  return logs.filter((entry) => {
    if (options.source !== undefined && entry.source !== options.source) {
      return false;
    }
    if (options.subsystem !== undefined && entry.subsystem !== options.subsystem) {
      return false;
    }
    if (options.severity !== undefined && entry.severity !== options.severity) {
      return false;
    }

    return true;
  });
}

export function registerDiagnosticsTools(server: ToolRegistrar, controller: DiagnosticsMcpController): void {
  server.registerTool(
    'renderer.status',
    {
      title: 'Renderer status',
      description: 'Returns renderer UI diagnostics including output text, banner text, and last renderer state.',
    },
    async () => buildTextResult({ ok: true, status: controller.getRendererStatus() ?? null }),
  );

  server.registerTool(
    'logs.tail',
    {
      title: 'Logs tail',
      description: 'Returns the latest structured shell-desktop diagnostic logs with optional filters.',
      inputSchema: LOG_FILTER_SCHEMA.shape,
    },
    async (args: unknown) => {
      const parsed = LOG_FILTER_SCHEMA.parse(args ?? {});
      const limit = parsed.limit ?? 100;

      const filtered = filterLogs(controller.getLogs(), {
        source: parsed.source,
        subsystem: parsed.subsystem,
        severity: parsed.severity,
      });
      const entries = filtered.slice(Math.max(0, filtered.length - limit));

      return buildTextResult({
        ok: true,
        entries,
        totalMatched: filtered.length,
        nextCursor: entries.at(-1)?.id ?? null,
      });
    },
  );

  server.registerTool(
    'logs.since',
    {
      title: 'Logs since',
      description: 'Returns structured shell-desktop diagnostic logs newer than a cursor ID.',
      inputSchema: LOGS_SINCE_ARGS_SCHEMA.shape,
    },
    async (args: unknown) => {
      const parsed = LOGS_SINCE_ARGS_SCHEMA.parse(args);
      const limit = parsed.limit ?? 100;

      const filtered = filterLogs(controller.getLogs(), {
        source: parsed.source,
        subsystem: parsed.subsystem,
        severity: parsed.severity,
      }).filter((entry) => entry.id > parsed.cursor);

      const entries = filtered.slice(0, limit);

      return buildTextResult({
        ok: true,
        cursor: parsed.cursor,
        entries,
        totalMatched: filtered.length,
        nextCursor: entries.at(-1)?.id ?? parsed.cursor,
      });
    },
  );

  server.registerTool(
    'probe.webgpuHealth',
    {
      title: 'Probe WebGPU health',
      description: 'Returns structured WebGPU health state suitable for deterministic assertions.',
    },
    async () => buildTextResult({ ok: true, health: controller.getWebGpuHealth() }),
  );
}
