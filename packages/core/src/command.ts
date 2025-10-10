/**
 * Command interface and priority tiers defined in
 * docs/runtime-command-queue-design.md §4.1.
 *
 * Commands are the sole mechanism for mutating runtime state at tick
 * boundaries. Every command carries the simulation step that will execute it
 * along with a priority lane used to resolve ordering conflicts.
 */
export interface Command<TPayload = unknown> {
  readonly type: string;
  readonly priority: CommandPriority;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly step: number;
}

/**
 * Priority tiers are ordered lowest numeric value first to match the design's
 * deterministic execution order:
 * SYSTEM → PLAYER → AUTOMATION (see docs/runtime-command-queue-design.md §4.1).
 */
export enum CommandPriority {
  SYSTEM = 0,
  PLAYER = 1,
  AUTOMATION = 2,
}

/**
 * Local representation of a command snapshot stored in the queue.
 *
 * Sequence numbers provide a deterministic tie breaker when timestamps match.
 */
export interface CommandQueueEntry {
  readonly command: Command;
  readonly sequence: number;
}
