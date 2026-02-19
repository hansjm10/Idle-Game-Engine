import { describe, expect, it, vi } from 'vitest';
import { registerInputTools, type InputMcpController } from './input-tools.js';
import type { ShellControlEvent } from '../ipc.js';

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

describe('shell-desktop MCP input tools', () => {
  it('registers input.controlEvent', () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerInputTools(server, {
      sendControlEvent: (_event: ShellControlEvent) => undefined,
    } satisfies InputMcpController);

    expect(Array.from(tools.keys()).sort()).toEqual(['input.controlEvent']);
  });

  it('validates and forwards control events', async () => {
    const tools = new Map<string, ToolHandler>();

    const sendControlEvent = vi.fn();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerInputTools(server, { sendControlEvent } as unknown as InputMcpController);

    const handler = tools.get('input.controlEvent');
    const rawResult = await handler?.({ intent: 'collect', phase: 'start' });

    expect(sendControlEvent).toHaveBeenCalledWith({ intent: 'collect', phase: 'start' });

    const result = parseToolJson(rawResult);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
  });

  it('rejects invalid control event payloads', async () => {
    const tools = new Map<string, ToolHandler>();

    const server = {
      registerTool: vi.fn((name: string, _definition: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      }),
    };

    registerInputTools(server, { sendControlEvent: () => undefined });

    const handler = tools.get('input.controlEvent');

    await expect(handler?.({})).rejects.toThrow(/intent/);
    await expect(handler?.({ intent: '', phase: 'start' })).rejects.toThrow(/intent/);
    await expect(handler?.({ intent: 'ok', phase: 'nope' })).rejects.toThrow(/phase/);
    await expect(handler?.({ intent: 'ok', phase: 'start', metadata: 'nope' })).rejects.toThrow(/metadata/);
    await expect(handler?.({ intent: 'ok', phase: 'start', value: 'nope' })).rejects.toThrow(/value/);
  });
});

