export { buildProgressionSnapshot, loadGameStateSaveFormat } from '@idle-engine/core/harness';
export type {
  GameStateSaveFormat,
  ProgressionAuthoritativeState,
  ProgressionSnapshot,
  ProgressionSnapshotOptions,
  SchemaMigration,
} from '@idle-engine/core/harness';

// eslint-disable-next-line no-restricted-imports -- runtime-harness bridges core internals for shell-desktop save codec
export { encodeGameStateSave, decodeGameStateSave } from '@idle-engine/core/internals';
// eslint-disable-next-line no-restricted-imports -- runtime-harness bridges core internals for shell-desktop save codec
export type { GameStateSaveCompression } from '@idle-engine/core/internals';

