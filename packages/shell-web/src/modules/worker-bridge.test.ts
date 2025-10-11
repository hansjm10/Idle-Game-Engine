import { describe, expect, it, vi } from 'vitest';

import {
  CommandSource,
  WorkerBridgeImpl,
  type RuntimeStateSnapshot,
} from './worker-bridge.js';

type MessageListener<TData = unknown> = (event: { data: TData }) => void;

class MockWorker {
  public readonly postMessage = vi.fn<(data: unknown) => void>();
  public readonly terminate = vi.fn<void, []>();

  private readonly listeners = new Map<string, Set<MessageListener>>();

  addEventListener<TData>(
    type: string,
    listener: MessageListener<TData>,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener as MessageListener);
  }

  removeEventListener<TData>(
    type: string,
    listener: MessageListener<TData>,
  ): void {
    const registry = this.listeners.get(type);
    registry?.delete(listener as MessageListener);
  }

  emitMessage<TData>(type: string, data: TData): void {
    const registry = this.listeners.get(type);
    if (!registry) {
      return;
    }
    for (const listener of registry) {
      listener({ data });
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('WorkerBridgeImpl', () => {
  it('wraps player commands and posts them to the worker', () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    bridge.sendCommand('PING', { issuedAt: 123 });

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const envelope = worker.postMessage.mock.calls[0]![0] as {
      type: string;
      source: CommandSource;
      command: { type: string; payload: unknown; timestamp: number };
    };

    expect(envelope).toMatchObject({
      type: 'COMMAND',
      source: CommandSource.PLAYER,
      command: {
        type: 'PING',
        payload: { issuedAt: 123 },
      },
    });
    expect(typeof envelope.command.timestamp).toBe('number');
  });

  it('notifies subscribers when state updates arrive from the worker', () => {
    const worker = new MockWorker();
    const bridge =
      new WorkerBridgeImpl<RuntimeStateSnapshot>(worker as unknown as Worker);
    const handler = vi.fn<void, [RuntimeStateSnapshot]>();
    bridge.onStateUpdate(handler);

    worker.emitMessage('message', {
      type: 'STATE_UPDATE',
      state: { currentStep: 7 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ currentStep: 7 });

    bridge.offStateUpdate(handler);
    worker.emitMessage('message', {
      type: 'STATE_UPDATE',
      state: { currentStep: 8 },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('disposes the worker and prevents additional commands', () => {
    const worker = new MockWorker();
    const bridge = new WorkerBridgeImpl(worker as unknown as Worker);

    expect(worker.listenerCount('message')).toBe(1);

    bridge.dispose();

    expect(worker.listenerCount('message')).toBe(0);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'TERMINATE' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(() => bridge.sendCommand('PING', {})).toThrow(
      'WorkerBridge has been disposed',
    );
  });
});
