/**
 * Maps content pack system automation target IDs to runtime command types.
 *
 * Content packs reference system targets using kebab-case identifiers
 * (e.g., 'offline-catchup') defined in @idle-engine/content-schema.
 * The runtime dispatcher recognizes SCREAMING_SNAKE_CASE command types
 * (e.g., 'OFFLINE_CATCHUP') from RUNTIME_COMMAND_TYPES.
 *
 * This mapping bridges the two naming conventions.
 */

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
  Record<string, string>
> = Object.freeze({
  'offline-catchup': RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
  'research-daemon': 'RESEARCH_DAEMON', // Placeholder: update when command exists
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
): string {
  const commandType = SYSTEM_AUTOMATION_TARGET_MAPPING[systemTargetId];
  if (!commandType) {
    throw new Error(
      `Unknown system automation target: "${systemTargetId}". ` +
        `Expected one of: ${Object.keys(SYSTEM_AUTOMATION_TARGET_MAPPING).join(', ')}`,
    );
  }
  return commandType;
}
