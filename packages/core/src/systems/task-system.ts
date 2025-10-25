import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';

export type TaskStatus = 'scheduled' | 'running' | 'paused' | 'completed';

export interface TaskDefinition {
  readonly id: string;
  readonly durationMs: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface TaskRecord extends TaskDefinition {
  remainingMs: number;
  status: TaskStatus;
  completedAtStep?: number;
  completionNotified?: boolean;
}

export class TaskSchedulerState {
  private readonly order: string[] = [];
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly pendingNotifications = new Set<string>();

  schedule(task: TaskDefinition): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task "${task.id}" is already scheduled.`);
    }
    if (!Number.isFinite(task.durationMs) || task.durationMs <= 0) {
      throw new Error('Task duration must be a positive finite number.');
    }
    const record: TaskRecord = {
      id: task.id,
      durationMs: task.durationMs,
      payload: task.payload,
      remainingMs: task.durationMs,
      status: 'running',
    };
    this.tasks.set(task.id, record);
    insertTaskId(this.order, task.id);
  }

  pause(taskId: string): void {
    const task = this.require(taskId);
    if (task.status === 'running') {
      task.status = 'paused';
    }
  }

  resume(taskId: string): void {
    const task = this.require(taskId);
    if (task.status === 'paused') {
      task.status = 'running';
    }
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  list(): readonly TaskRecord[] {
    return this.order.map((id) => this.tasks.get(id)!).filter(Boolean);
  }

  advance(deltaMs: number, step: number): readonly TaskRecord[] {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return [];
    }

    const completed: TaskRecord[] = [];

    for (const taskId of this.order) {
      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'running') {
        continue;
      }

      task.remainingMs = Math.max(0, task.remainingMs - deltaMs);
      if (task.remainingMs === 0) {
        task.status = 'completed';
        task.completedAtStep = step;
        this.pendingNotifications.add(task.id);
        completed.push(task);
      }
    }

    return completed;
  }

  clearCompleted(): void {
    for (const [taskId, task] of this.tasks.entries()) {
      if (task.status === 'completed' && task.completionNotified) {
        this.pendingNotifications.delete(taskId);
        this.tasks.delete(taskId);
        const index = this.order.indexOf(taskId);
        if (index >= 0) {
          this.order.splice(index, 1);
        }
      }
    }
  }

  markNotified(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) {
      task.completionNotified = true;
      this.pendingNotifications.delete(taskId);
    }
  }

  getPendingCompletions(): readonly TaskRecord[] {
    if (this.pendingNotifications.size === 0) {
      return [];
    }

    const pending: TaskRecord[] = [];
    for (const taskId of this.order) {
      if (!this.pendingNotifications.has(taskId)) {
        continue;
      }

      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'completed' || task.completionNotified) {
        this.pendingNotifications.delete(taskId);
        continue;
      }

      pending.push(task);
    }

    return pending;
  }

  private require(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" is not tracked by the scheduler.`);
    }
    return task;
  }
}

export interface TaskSystemOptions {
  readonly state: TaskSchedulerState;
  readonly id?: string;
  readonly autoClearCompleted?: boolean;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export function createTaskSystem(options: TaskSystemOptions): SystemDefinition {
  const {
    state,
    id = 'tasks',
    autoClearCompleted = true,
    before,
    after,
  } = options;

  return {
    id,
    before,
    after,
    tick(context: TickContext) {
      state.advance(context.deltaMs, context.step);
      const pending = state.getPendingCompletions();
      for (const task of pending) {
        const result = context.events.publish('task:completed', {
          taskId: task.id,
          payload: task.payload,
          completedAtStep: task.completedAtStep ?? context.step,
        });
        if (result.accepted) {
          state.markNotified(task.id);
        }
      }

      if (autoClearCompleted) {
        state.clearCompleted();
      }
    },
  };
}

function insertTaskId(order: string[], taskId: string): void {
  const index = findInsertIndex(order, taskId);
  order.splice(index, 0, taskId);
}

function findInsertIndex(order: string[], taskId: string): number {
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (order[mid]! < taskId) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
