export {
  ShellStateProvider,
  useShellBridge,
  useShellDiagnostics,
  useShellState,
} from './ShellStateProvider.js';

export type {
  DiagnosticsSubscriber,
  ShellBridgeApi,
  ShellDiagnosticsApi,
  ShellRuntimeState,
  ShellBridgeState,
  ShellSocialState,
  ShellDiagnosticsState,
  ShellState,
  ShellStateProviderConfig,
} from './shell-state.types.js';

export {
  DEFAULT_MAX_EVENT_HISTORY,
  DEFAULT_MAX_ERROR_HISTORY,
} from './shell-state-store.js';
