/**
 * Maps content pack system automation target IDs to runtime command types.
 *
 * Content packs reference system targets using kebab-case identifiers
 * (e.g., 'offline-catchup') defined in @idle-engine/content-schema.
 * The runtime dispatcher recognizes SCREAMING_SNAKE_CASE command types
 * (e.g., 'OFFLINE_CATCHUP') from RUNTIME_COMMAND_TYPES.
 *
 * This mapping bridges the two naming conventions.
 *
 * ## Usage
 *
 * ```typescript
 * import { mapSystemTargetToCommandType } from '@idle-engine/core';
 *
 * const commandType = mapSystemTargetToCommandType('offline-catchup');
 * // Returns: 'OFFLINE_CATCHUP'
 * ```
 *
 * ## Synchronization
 *
 * When adding a new system target:
 * 1. Add to SYSTEM_AUTOMATION_TARGET_IDS in content-schema/src/base/ids.ts
 * 2. Add to RUNTIME_COMMAND_TYPES in core/src/command.ts (if needed)
 * 3. Add mapping entry to SYSTEM_AUTOMATION_TARGET_MAPPING
 * 4. Run tests to verify synchronization
 *
 * @packageDocumentation
 */

import type { RuntimeCommandType } from './command.js';
import { RUNTIME_COMMAND_TYPES } from './command.js';

/**
 * Bidirectional mapping from content schema system target IDs to runtime
 * command types.
 *
 * IMPORTANT: Keep this in sync with:
 * - packages/content-schema/src/base/ids.ts:SYSTEM_AUTOMATION_TARGET_IDS
 * - packages/core/src/command.ts:RUNTIME_COMMAND_TYPES
 */
export const SYSTEM_AUTOMATION_TARGET_MAPPING: Readonly<
  Record<string, RuntimeCommandType>
> = Object.freeze({
  'offline-catchup': RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
  // TODO: Add RESEARCH_DAEMON to RUNTIME_COMMAND_TYPES when research system is implemented
  'research-daemon': 'RESEARCH_DAEMON' as RuntimeCommandType,
});

/**
 * Maps a system automation target ID to its corresponding runtime command type.
 *
 * @param systemTargetId - The kebab-case system target ID from content pack
 * @returns The SCREAMING_SNAKE_CASE runtime command type
 * @throws Error if systemTargetId is not in the mapping
 */
export function mapSystemTargetToCommandType(
  systemTargetId: string,
): RuntimeCommandType {
  const commandType = SYSTEM_AUTOMATION_TARGET_MAPPING[systemTargetId];
  if (!commandType) {
    throw new Error(
      `Unknown system automation target: "${systemTargetId}". ` +
        `Expected one of: ${Object.keys(SYSTEM_AUTOMATION_TARGET_MAPPING).join(', ')}`,
    );
  }
  return commandType;
}
