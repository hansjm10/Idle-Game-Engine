/**
 * Command interface and priority tiers defined in
 * docs/runtime-command-queue-design.md §4.1.
 *
 * Commands are the sole mechanism for mutating runtime state at tick
 * boundaries. Every command carries the simulation step that will execute it
 * along with a priority lane used to resolve ordering conflicts.
 */
import type {
  ImmutableArrayBufferSnapshot,
  ImmutableMapSnapshot,
  ImmutableSetSnapshot,
  ImmutableSharedArrayBufferSnapshot,
  ImmutableTypedArraySnapshot,
  TypedArray,
} from './immutable-snapshots.js';

export interface Command<TPayload = unknown> {
  readonly type: string;
  readonly priority: CommandPriority;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly step: number;
  readonly requestId?: string;
}

type ImmutablePrimitive =
  | string
  | number
  | bigint
  | boolean
  | symbol
  | null
  | undefined;

type ImmutableFunction = (...args: unknown[]) => unknown;

type ImmutableArrayLike<T> = readonly ImmutablePayload<T>[];

export type ImmutablePayload<T> = T extends ImmutablePrimitive
  ? T
  : T extends ImmutableFunction
    ? T
    : T extends ArrayBuffer
      ? ImmutableArrayBufferSnapshot
      : T extends SharedArrayBuffer
        ? ImmutableSharedArrayBufferSnapshot
        : T extends Map<infer K, infer V>
          ? ImmutableMapSnapshot<ImmutablePayload<K>, ImmutablePayload<V>>
          : T extends Set<infer V>
            ? ImmutableSetSnapshot<ImmutablePayload<V>>
            : T extends (infer U)[]
              ? ImmutableArrayLike<U>
              : T extends readonly (infer U)[]
                ? ImmutableArrayLike<U>
                : T extends TypedArray
                  ? ImmutableTypedArraySnapshot<T>
                  : T extends DataView
                    ? DataView
                    : T extends ArrayBufferView
                      ? T
                      : T extends object
                        ? { readonly [K in keyof T]: ImmutablePayload<T[K]> }
                        : T;

export type CommandSnapshot<TPayload = unknown> = ImmutablePayload<
  Command<TPayload>
>;

export type CommandSnapshotPayload<TPayload> = ImmutablePayload<TPayload>;

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
 * Shared execution order across queue and dispatcher. Lower enum values run
 * first per docs/runtime-command-queue-design.md §6.
 */
export const COMMAND_PRIORITY_ORDER: readonly CommandPriority[] = Object.freeze([
  CommandPriority.SYSTEM,
  CommandPriority.PLAYER,
  CommandPriority.AUTOMATION,
]);

/**
 * Local representation of a command snapshot stored in the queue.
 *
 * Sequence numbers provide a deterministic tie breaker when timestamps match.
 */
export interface CommandQueueEntry<TCommand = Command> {
  readonly command: TCommand;
  readonly sequence: number;
}

/**
 * Identifier strings for the initial runtime command set documented in
 * docs/runtime-command-queue-design.md §5.
 */
export const RUNTIME_COMMAND_TYPES = Object.freeze({
  PURCHASE_GENERATOR: 'PURCHASE_GENERATOR',
  PURCHASE_UPGRADE: 'PURCHASE_UPGRADE',
  TOGGLE_GENERATOR: 'TOGGLE_GENERATOR',
  TOGGLE_AUTOMATION: 'TOGGLE_AUTOMATION',
  COLLECT_RESOURCE: 'COLLECT_RESOURCE',
  PRESTIGE_RESET: 'PRESTIGE_RESET',
  OFFLINE_CATCHUP: 'OFFLINE_CATCHUP',
  APPLY_MIGRATION: 'APPLY_MIGRATION',
  RUN_TRANSFORM: 'RUN_TRANSFORM',
  MAKE_MISSION_DECISION: 'MAKE_MISSION_DECISION',
  ADD_ENTITY: 'ADD_ENTITY',
  REMOVE_ENTITY: 'REMOVE_ENTITY',
  CREATE_ENTITY_INSTANCE: 'CREATE_ENTITY_INSTANCE',
  DESTROY_ENTITY_INSTANCE: 'DESTROY_ENTITY_INSTANCE',
  ASSIGN_ENTITY_TO_MISSION: 'ASSIGN_ENTITY_TO_MISSION',
  RETURN_ENTITY_FROM_MISSION: 'RETURN_ENTITY_FROM_MISSION',
  ADD_ENTITY_EXPERIENCE: 'ADD_ENTITY_EXPERIENCE',
} as const);

export type RuntimeCommandType =
  (typeof RUNTIME_COMMAND_TYPES)[keyof typeof RUNTIME_COMMAND_TYPES];

/**
 * Player purchases a generator (docs/runtime-command-queue-design.md §5.1).
 */
export interface PurchaseGeneratorPayload {
  readonly generatorId: string;
  readonly count: number;
}

/**
 * Player purchases an upgrade (docs/runtime-command-queue-design.md §5.1).
 */
export interface PurchaseUpgradePayload {
  readonly upgradeId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Automation toggles a generator (docs/runtime-command-queue-design.md §5.1).
 */
export interface ToggleGeneratorPayload {
  readonly generatorId: string;
  readonly enabled: boolean;
}

/**
 * Toggle automation enabled/disabled state (docs/automation-execution-system-design.md §6.2.7).
 */
export interface ToggleAutomationPayload {
  readonly automationId: string;
  readonly enabled: boolean;
}

/**
 * Manual resource collection (docs/runtime-command-queue-design.md §5.1).
 */
export interface CollectResourcePayload {
  readonly resourceId: string;
  readonly amount: number;
}

/**
 * Player prestige reset request (docs/runtime-command-queue-design.md §5.2).
 */
export interface PrestigeResetPayload {
  readonly layerId: string;
  readonly confirmationToken?: string;
}

/**
 * Offline catch-up adjustment payload (docs/runtime-command-queue-design.md §5.3).
 */
export interface OfflineCatchupPayload {
  readonly elapsedMs: number;
  readonly resourceDeltas: Record<string, number>;
  readonly maxElapsedMs?: number;
  readonly maxSteps?: number;
}

/**
 * Future migration step metadata shape lives with the save migration pipeline.
 * We model it as an opaque record for now per docs/runtime-command-queue-design.md §5.3.
 */
export type MigrationStep = Readonly<Record<string, unknown>>;

/**
 * Save migration payload (docs/runtime-command-queue-design.md §5.3).
 */
export interface ApplyMigrationPayload {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly transformations: readonly MigrationStep[];
}

/**
 * Manual transform execution payload (docs/runtime-transform-system-design-issue-523.md §6.2).
 */
export interface RunTransformPayload {
  readonly transformId: string;
  readonly runs?: number;
}

/**
 * Select a decision option for a pending mission stage decision.
 */
export interface MakeMissionDecisionPayload {
  readonly transformId: string;
  readonly batchId: string;
  readonly stageId: string;
  readonly optionId: string;
}

/**
 * Add entities by count (for non-instance tracked entities).
 */
export interface AddEntityPayload {
  readonly entityId: string;
  readonly count: number;
}

/**
 * Remove entities by count (for non-instance tracked entities).
 */
export interface RemoveEntityPayload {
  readonly entityId: string;
  readonly count: number;
}

/**
 * Create a tracked entity instance.
 */
export interface CreateEntityInstancePayload {
  readonly entityId: string;
}

/**
 * Destroy a tracked entity instance.
 */
export interface DestroyEntityInstancePayload {
  readonly instanceId: string;
}

/**
 * Assign a tracked entity instance to a mission.
 */
export interface AssignEntityToMissionPayload {
  readonly instanceId: string;
  readonly missionId: string;
  readonly batchId: string;
  readonly returnStep: number;
}

/**
 * Return a tracked entity instance from its mission.
 */
export interface ReturnEntityFromMissionPayload {
  readonly instanceId: string;
}

/**
 * Add experience to a tracked entity instance.
 */
export interface AddEntityExperiencePayload {
  readonly instanceId: string;
  readonly amount: number;
}

/**
 * Mapping between runtime command identifiers and their strongly typed payloads.
 */
export interface RuntimeCommandPayloads {
  readonly PURCHASE_GENERATOR: PurchaseGeneratorPayload;
  readonly PURCHASE_UPGRADE: PurchaseUpgradePayload;
  readonly TOGGLE_GENERATOR: ToggleGeneratorPayload;
  readonly TOGGLE_AUTOMATION: ToggleAutomationPayload;
  readonly COLLECT_RESOURCE: CollectResourcePayload;
  readonly PRESTIGE_RESET: PrestigeResetPayload;
  readonly OFFLINE_CATCHUP: OfflineCatchupPayload;
  readonly APPLY_MIGRATION: ApplyMigrationPayload;
  readonly RUN_TRANSFORM: RunTransformPayload;
  readonly MAKE_MISSION_DECISION: MakeMissionDecisionPayload;
  readonly ADD_ENTITY: AddEntityPayload;
  readonly REMOVE_ENTITY: RemoveEntityPayload;
  readonly CREATE_ENTITY_INSTANCE: CreateEntityInstancePayload;
  readonly DESTROY_ENTITY_INSTANCE: DestroyEntityInstancePayload;
  readonly ASSIGN_ENTITY_TO_MISSION: AssignEntityToMissionPayload;
  readonly RETURN_ENTITY_FROM_MISSION: ReturnEntityFromMissionPayload;
  readonly ADD_ENTITY_EXPERIENCE: AddEntityExperiencePayload;
}

/**
 * Runtime command shape tied to a specific payload contract.
 */
export type RuntimeCommand<TType extends RuntimeCommandType = RuntimeCommandType> =
  Command<RuntimeCommandPayloads[TType]> & {
    readonly type: TType;
  };

/**
 * Authorization policy for each command type, derived from
 * docs/runtime-command-queue-design.md §§4.5 & 6.
 */
export interface CommandAuthorizationPolicy {
  readonly type: RuntimeCommandType;
  readonly allowedPriorities: readonly CommandPriority[];
  /**
   * Narrative used by handler docs/tests to explain why the restriction exists.
   */
  readonly rationale: string;
  /**
   * Telemetry event fired when a command is rejected for violating this policy.
   */
  readonly unauthorizedEvent?: string;
}

export const COMMAND_AUTHORIZATIONS: Readonly<
  Record<RuntimeCommandType, CommandAuthorizationPolicy>
> = Object.freeze({
  PURCHASE_GENERATOR: {
    type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Purchases are gated by resource costs; any priority may attempt them.',
  },
  PURCHASE_UPGRADE: {
    type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Upgrades share the purchase gating model and may originate from any priority.',
  },
  TOGGLE_GENERATOR: {
    type: RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Generator toggles can originate from automation, player, or system flows.',
  },
  TOGGLE_AUTOMATION: {
    type: RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Automation toggles can originate from any priority tier for manual or programmatic control.',
  },
  COLLECT_RESOURCE: {
    type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Manual and automation-driven collection share the same execution path.',
  },
  PRESTIGE_RESET: {
    type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
    allowedPriorities: Object.freeze([
      CommandPriority.SYSTEM,
      CommandPriority.PLAYER,
    ]),
    rationale:
      'Automation may not trigger prestige; only player/system contexts are permitted.',
    unauthorizedEvent: 'AutomationPrestigeBlocked',
  },
  OFFLINE_CATCHUP: {
    type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
    allowedPriorities: Object.freeze([
      CommandPriority.SYSTEM,
      CommandPriority.AUTOMATION,
    ]),
    rationale:
      'Offline reconciliation is engine-driven; automations may also trigger catchup logic.',
    unauthorizedEvent: 'UnauthorizedSystemCommand',
  },
  APPLY_MIGRATION: {
    type: RUNTIME_COMMAND_TYPES.APPLY_MIGRATION,
    allowedPriorities: Object.freeze([CommandPriority.SYSTEM]),
    rationale:
      'Schema migrations run exclusively under system authority for integrity.',
    unauthorizedEvent: 'UnauthorizedSystemCommand',
  },
  RUN_TRANSFORM: {
    type: RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
    allowedPriorities: Object.freeze([
      CommandPriority.SYSTEM,
      CommandPriority.PLAYER,
    ]),
    rationale:
      'Manual transforms are player-initiated or system-driven; automation trigger path is implemented separately.',
    unauthorizedEvent: 'UnauthorizedTransformCommand',
  },
  MAKE_MISSION_DECISION: {
    type: RUNTIME_COMMAND_TYPES.MAKE_MISSION_DECISION,
    allowedPriorities: Object.freeze([
      CommandPriority.SYSTEM,
      CommandPriority.PLAYER,
    ]),
    rationale:
      'Mission decisions are player-initiated or system-driven via timeout defaults; automation may not submit them.',
    unauthorizedEvent: 'UnauthorizedTransformCommand',
  },
  ADD_ENTITY: {
    type: RUNTIME_COMMAND_TYPES.ADD_ENTITY,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Entity additions may originate from any priority tier for manual, system, or automation-driven acquisition.',
  },
  REMOVE_ENTITY: {
    type: RUNTIME_COMMAND_TYPES.REMOVE_ENTITY,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Entity removal may originate from any priority tier for sacrifices, retirements, or system-driven deductions.',
  },
  CREATE_ENTITY_INSTANCE: {
    type: RUNTIME_COMMAND_TYPES.CREATE_ENTITY_INSTANCE,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Entity instance creation may originate from any priority tier for deterministic tracking.',
  },
  DESTROY_ENTITY_INSTANCE: {
    type: RUNTIME_COMMAND_TYPES.DESTROY_ENTITY_INSTANCE,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Entity instance destruction may originate from any priority tier for manual or system cleanup.',
  },
  ASSIGN_ENTITY_TO_MISSION: {
    type: RUNTIME_COMMAND_TYPES.ASSIGN_ENTITY_TO_MISSION,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Mission assignments may originate from player actions, automation strategies, or system-driven story events.',
  },
  RETURN_ENTITY_FROM_MISSION: {
    type: RUNTIME_COMMAND_TYPES.RETURN_ENTITY_FROM_MISSION,
    allowedPriorities: COMMAND_PRIORITY_ORDER,
    rationale:
      'Mission recalls may originate from player actions, automation strategies, or system-driven completions.',
  },
  ADD_ENTITY_EXPERIENCE: {
    type: RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE,
    allowedPriorities: Object.freeze([
      CommandPriority.SYSTEM,
      CommandPriority.AUTOMATION,
    ]),
    rationale:
      'Experience grants are system-driven or automation-driven; manual grants are not permitted.',
    unauthorizedEvent: 'UnauthorizedEntityExperienceGrant',
  },
});
