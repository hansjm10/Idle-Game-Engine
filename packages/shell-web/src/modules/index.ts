export {
  ShellStateProvider,
  useShellBridge,
  useShellDiagnostics,
  useShellState,
  useShellProgression,
} from './ShellStateProvider.js';
export { ResourceDashboard } from './ResourceDashboard.js';
export { GeneratorPanel } from './GeneratorPanel.js';
export { UpgradeModal } from './UpgradeModal.js';

export type {
  DiagnosticsSubscriber,
  ShellBridgeApi,
  ShellDiagnosticsApi,
  ShellProgressionApi,
  ShellRuntimeState,
  ShellBridgeState,
  ShellSocialState,
  ShellDiagnosticsState,
  ShellState,
  ShellStateProviderConfig,
  ProgressionResourcesSelector,
  ProgressionGeneratorsSelector,
  ProgressionUpgradesSelector,
  ProgressionOptimisticResourcesSelector,
} from './shell-state.types.js';

export {
  DEFAULT_MAX_EVENT_HISTORY,
  DEFAULT_MAX_ERROR_HISTORY,
} from './shell-state-store.js';

// Session persistence and migration
export type {
  StoredSessionSnapshot,
  ContentPackManifest,
} from './session-persistence-adapter.js';
export {
  SessionPersistenceAdapter,
  SessionPersistenceError,
  PERSISTENCE_SCHEMA_VERSION,
} from './session-persistence-adapter.js';

export type { SessionRestoreResult, SessionRestoreOptions } from './session-restore.js';
export { restoreSession, validateSnapshot, validateSaveCompatibility } from './session-restore.js';

// Migration system
export type {
  MigrationTransform,
  MigrationDescriptor,
  MigrationPath,
} from './migration-registry.js';
export {
  registerMigration,
  findMigrationPath,
  applyMigrations,
  migrationRegistry,
} from './migration-registry.js';

// Automation state migration
export { migrateAutomationState } from '../migrations/automation-state-migration.js';
