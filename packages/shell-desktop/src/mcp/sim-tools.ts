import { CommandPriority } from '@idle-engine/core';
import type { Command } from '@idle-engine/core';
import type { AnySchema, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import * as z from 'zod/v4';

export type SimMcpStatusState = 'starting' | 'running' | 'paused' | 'stopped' | 'crashed';

export type SimMcpStatus = Readonly<{
  state: SimMcpStatusState;
  stepSizeMs: number;
  nextStep: number;
  reason?: string;
  exitCode?: number;
}>;

export type SimMcpController = Readonly<{
  getStatus: () => SimMcpStatus;
  start: () => SimMcpStatus;
  stop: () => SimMcpStatus;
  pause: () => SimMcpStatus;
  resume: () => SimMcpStatus;
  step: (steps: number) => SimMcpStatus;
  enqueue: (commands: readonly Command[]) => Readonly<{ enqueued: number }>;
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

const buildTextResult = (value: unknown): TextToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

const assertObject = (value: unknown, message: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }

  return value as Record<string, unknown>;
};

const assertOptionalFiniteNumber = (value: unknown, message: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(message);
  }

  return value;
};

const assertOptionalCommandPriority = (value: unknown): CommandPriority | undefined => {
  const candidate = assertOptionalFiniteNumber(
    value,
    'Invalid sim.enqueue command: expected { priority?: number }',
  );

  if (candidate === undefined) {
    return undefined;
  }

  if (!Number.isInteger(candidate)) {
    throw new TypeError('Invalid sim.enqueue command: expected { priority?: 0 | 1 | 2 }');
  }

  if (
    candidate !== CommandPriority.SYSTEM &&
    candidate !== CommandPriority.PLAYER &&
    candidate !== CommandPriority.AUTOMATION
  ) {
    throw new TypeError('Invalid sim.enqueue command: expected { priority?: 0 | 1 | 2 }');
  }

  return candidate as CommandPriority;
};

const normalizeCommandForEnqueue = (
  candidate: unknown,
  options: Readonly<{ stepSizeMs: number; nextStep: number }>,
): Command => {
  const record = assertObject(candidate, 'Invalid sim.enqueue command: expected an object');

  const type = record['type'];
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new TypeError('Invalid sim.enqueue command: expected { type: string }');
  }

  const stepCandidate = assertOptionalFiniteNumber(
    record['step'],
    'Invalid sim.enqueue command: expected { step?: number }',
  );

  const priorityCandidate = assertOptionalCommandPriority(record['priority']);

  const requestId = record['requestId'];
  if (requestId !== undefined && typeof requestId !== 'string') {
    throw new TypeError('Invalid sim.enqueue command: expected { requestId?: string }');
  }

  const step = Math.max(
    options.nextStep,
    stepCandidate === undefined ? options.nextStep : Math.floor(stepCandidate),
  );

  const command: Command = {
    type,
    payload: record['payload'],
    priority: priorityCandidate ?? CommandPriority.PLAYER,
    step,
    timestamp: step * options.stepSizeMs,
  };

  return requestId === undefined ? command : { ...command, requestId };
};

const parseStepCount = (args: unknown): number => {
  const record = assertObject(args, 'Invalid sim.step payload: expected an object');
  const candidate = record['steps'];
  if (candidate === undefined) {
    return 1;
  }
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new TypeError('Invalid sim.step payload: expected { steps?: number }');
  }
  const steps = Math.floor(candidate);
  if (steps < 1 || steps !== candidate) {
    throw new TypeError('Invalid sim.step payload: expected { steps: integer >= 1 }');
  }
  return steps;
};

export function registerSimTools(server: ToolRegistrar, controller: SimMcpController): void {
  server.registerTool(
    'sim.status',
    {
      title: 'Sim status',
      description: 'Returns the current simulation status (step, step size, lifecycle state).',
    },
    async () => buildTextResult(controller.getStatus()),
  );

  server.registerTool(
    'sim.start',
    {
      title: 'Sim start',
      description: 'Starts the simulation tick loop if it is not running.',
    },
    async () => buildTextResult({ ok: true, status: controller.start() }),
  );

  server.registerTool(
    'sim.stop',
    {
      title: 'Sim stop',
      description: 'Stops the simulation and disposes the worker.',
    },
    async () => buildTextResult({ ok: true, status: controller.stop() }),
  );

  server.registerTool(
    'sim.pause',
    {
      title: 'Sim pause',
      description: 'Pauses the simulation tick loop while keeping the worker alive.',
    },
    async () => buildTextResult({ ok: true, status: controller.pause() }),
  );

  server.registerTool(
    'sim.resume',
    {
      title: 'Sim resume',
      description: 'Resumes the simulation tick loop after pausing.',
    },
    async () => buildTextResult({ ok: true, status: controller.resume() }),
  );

  server.registerTool(
    'sim.step',
    {
      title: 'Sim step',
      description: 'Advances the simulation by N steps while paused.',
      inputSchema: {
        steps: z.number().optional(),
      },
    },
    async (args: unknown) => {
      const steps = parseStepCount(args);
      return buildTextResult({ ok: true, status: controller.step(steps) });
    },
  );

  server.registerTool(
    'sim.enqueue',
    {
      title: 'Sim enqueue',
      description: 'Enqueues runtime commands onto the simulation command queue deterministically.',
      inputSchema: {
        commands: z.array(z.unknown()),
      },
    },
    async (args: unknown) => {
      const record = assertObject(args, 'Invalid sim.enqueue payload: expected an object');
      const rawCommands = record['commands'];
      if (!Array.isArray(rawCommands)) {
        throw new TypeError('Invalid sim.enqueue payload: expected { commands: Command[] }');
      }

      const status = controller.getStatus();
      const commands = rawCommands.map((command) =>
        normalizeCommandForEnqueue(command, { stepSizeMs: status.stepSizeMs, nextStep: status.nextStep }),
      );

      controller.enqueue(commands);

      return buildTextResult({ ok: true, enqueued: commands.length });
    },
  );
}
