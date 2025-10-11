export interface TickContext {
  readonly deltaMs: number;
  readonly step: number;
}

export type System = {
  readonly id: string;
  readonly tick: (context: TickContext) => void;
};

export interface EngineOptions {
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
}

const DEFAULT_STEP_MS = 100;
const DEFAULT_MAX_STEPS = 50;

/**
 * Minimal runtime skeleton implementing the deterministic tick accumulator
 * described in the design document. Actual systems register through
 * `addSystem` and execute in insertion order.
 */
export class IdleEngineRuntime {
  private readonly systems: System[] = [];
  private accumulator = 0;
  private readonly stepSizeMs: number;
  private readonly maxStepsPerFrame: number;
  private stepCounter = 0;

  constructor(options: EngineOptions = {}) {
    this.stepSizeMs = options.stepSizeMs ?? DEFAULT_STEP_MS;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? DEFAULT_MAX_STEPS;
  }

  addSystem(system: System): void {
    this.systems.push(system);
  }

  /**
   * Advance the simulation by `deltaMs`, clamping the number of processed
   * steps to avoid spiral of death scenarios.
   */
  tick(deltaMs: number): void {
    if (deltaMs <= 0) return;
    this.accumulator += deltaMs;
    const availableSteps = Math.floor(this.accumulator / this.stepSizeMs);
    const steps = Math.min(availableSteps, this.maxStepsPerFrame);
    this.accumulator -= steps * this.stepSizeMs;

    for (let i = 0; i < steps; i += 1) {
      const ctx: TickContext = {
        deltaMs: this.stepSizeMs,
        step: this.stepCounter,
      };
      this.stepCounter += 1;
      for (const system of this.systems) {
        system.tick(ctx);
      }
    }
  }
}

export {
  Command,
  CommandPriority,
  CommandQueueEntry,
  CommandSnapshot,
  CommandSnapshotPayload,
  ImmutablePayload,
} from './command.js';
export { CommandQueue, deepFreezeInPlace } from './command-queue.js';
export type {
  ImmutableArrayBufferSnapshot,
  ImmutableSharedArrayBufferSnapshot,
} from './immutable-snapshots.js';
