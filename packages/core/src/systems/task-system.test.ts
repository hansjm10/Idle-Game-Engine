import { describe, expect, it } from 'vitest';

import type { TickContext } from './system-types.js';
import {
  TaskSchedulerState,
  createTaskSystem,
} from './task-system.js';

describe('task-system', () => {
  it('schedules tasks, respects pause/resume, and emits completion events', () => {
    const scheduler = new TaskSchedulerState();
    scheduler.schedule({ id: 'task-a', durationMs: 100 });
    scheduler.schedule({ id: 'task-b', durationMs: 200 });
    scheduler.pause('task-b');

    const events: Array<{ type: string; payload: unknown }> = [];
    const system = createTaskSystem({
      state: scheduler,
      autoClearCompleted: false,
    });

    system.tick(createContext(events, 100));

    const taskA = scheduler.get('task-a');
    expect(taskA?.status).toBe('completed');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'task:completed',
      payload: {
        taskId: 'task-a',
        payload: undefined,
        completedAtStep: 0,
      },
    });

    scheduler.resume('task-b');
    system.tick(createContext(events, 100));

    const taskB = scheduler.get('task-b');
    expect(taskB?.status).toBe('running');
    expect(events).toHaveLength(1);

    system.tick(createContext(events, 100, 2));
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: 'task:completed',
      payload: {
        taskId: 'task-b',
        payload: undefined,
        completedAtStep: 2,
      },
    });
  });
});

function createContext(
  events: Array<{ type: string; payload: unknown }>,
  deltaMs: number,
  step = 0,
): TickContext {
  return {
    deltaMs,
    step,
    events: {
      publish(type, payload) {
        events.push({ type, payload });
        return {
          accepted: true,
          state: 'accepted',
          type,
          channel: 0,
          bufferSize: 0,
          remainingCapacity: 0,
          dispatchOrder: events.length,
          softLimitActive: false,
        };
      },
    },
  };
}

