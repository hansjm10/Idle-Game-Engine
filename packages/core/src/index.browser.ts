/**
 * Browser-safe public entry point for `@idle-engine/core`.
 *
 * This module intentionally exposes a small, stable surface for game developers
 * and engine integrators.
 *
 * - For the full (unstable) surface used by engine contributors, import
 *   `@idle-engine/core/internals`.
 * - For Prometheus telemetry (Node-only), import `@idle-engine/core/prometheus`.
 *
 * @public
 * @stability stable
 */

// ---------------------------------------------------------------------------
// High-level runtime wiring (game developers)
// ---------------------------------------------------------------------------

export {
  IdleEngineRuntime,
  createGameRuntime,
  wireGameRuntime,
} from './internals.browser.js';
export type {
  CreateGameRuntimeOptions,
  GameRuntimeWiring,
  IdleEngineRuntimeOptions,
  System,
  SystemRegistrationContext,
  TickContext,
} from './internals.browser.js';
export { createGame } from './game.js';
export type {
  CreateGameOptions,
  Game,
  GameSnapshot,
  SerializedGameState,
  Unsubscribe,
} from './game.js';

// ---------------------------------------------------------------------------
// Engine configuration
// ---------------------------------------------------------------------------

export { DEFAULT_ENGINE_CONFIG } from './config.js';
export type { EngineConfig, EngineConfigOverrides } from './config.js';

// ---------------------------------------------------------------------------
// Commands (presentation -> runtime intents)
// ---------------------------------------------------------------------------

export { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
export type {
  Command,
  RuntimeCommand,
  RuntimeCommandPayloads,
  RuntimeCommandType,
} from './command.js';

// ---------------------------------------------------------------------------
// Events (runtime -> presentation)
// ---------------------------------------------------------------------------

export { EventBus } from './events/event-bus.js';
export { buildRuntimeEventFrame } from './events/runtime-event-frame.js';
export {
  EventBroadcastBatcher,
  EventBroadcastDeduper,
  applyEventBroadcastFrame,
  applyEventBroadcastBatch,
  createEventBroadcastFrame,
  createEventTypeFilter,
} from './events/event-broadcast.js';
export { GENERATED_RUNTIME_EVENT_DEFINITIONS } from './events/runtime-event-manifest.generated.js';
export type { ContentRuntimeEventType } from './events/runtime-event-manifest.generated.js';

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export { RUNTIME_VERSION } from './version.js';
