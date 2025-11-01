/**
 * Runtime version constants
 *
 * These constants are used for serialization boundaries, persistence schemas,
 * and compatibility checks across the Idle Engine runtime.
 */

/**
 * Runtime semantic version.
 *
 * Corresponds to the @idle-engine/core package version. Used for:
 * - Session snapshot compatibility validation
 * - Runtime migration detection
 * - Telemetry and diagnostics correlation
 *
 * IMPORTANT: This must stay in sync with packages/core/package.json version.
 */
export const RUNTIME_VERSION = '0.1.0';

/**
 * Persistence schema version for session snapshots.
 *
 * Increment when the structure of session snapshot payloads changes in a
 * backwards-incompatible way. Used for:
 * - Triggering migration logic when restoring old saves
 * - Validating snapshot payload structure
 * - Coordinating with SessionPersistenceAdapter implementations
 *
 * Current schema (v1):
 * - persistenceSchemaVersion: 1
 * - slotId: string
 * - capturedAt: ISO timestamp
 * - workerStep: number
 * - monotonicMs: number
 * - state: SerializedResourceState
 * - runtimeVersion: string
 * - contentDigest: ResourceDefinitionDigest
 * - flags?: { pendingMigration?, abortedRestore? }
 */
export const PERSISTENCE_SCHEMA_VERSION = 1;
