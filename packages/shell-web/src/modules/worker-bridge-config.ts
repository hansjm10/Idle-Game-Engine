export interface WorkerBridgeConfig {
  readonly enabled: boolean;
}

function coerceBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === '') {
      return false;
    }
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  return fallback;
}

let overrideConfig: WorkerBridgeConfig | null = null;

function readEnvironmentValue(key: string): string | undefined {
  if (typeof import.meta !== 'undefined' && import.meta.env?.[key] !== undefined) {
    return import.meta.env[key] as string | undefined;
  }
  if (typeof process !== 'undefined' && process.env?.[key] !== undefined) {
    return process.env[key];
  }
  return undefined;
}

function loadWorkerBridgeConfigFromEnv(): WorkerBridgeConfig {
  // Default to legacy bridge until rollout phases in docs/runtime-react-worker-bridge-design.md §12 complete.
  const rawEnabled =
    readEnvironmentValue('VITE_ENABLE_WORKER_BRIDGE') ??
    readEnvironmentValue('ENABLE_WORKER_BRIDGE');

  return {
    enabled: coerceBoolean(rawEnabled, false),
  };
}

export function getWorkerBridgeConfig(): WorkerBridgeConfig {
  if (overrideConfig) {
    return overrideConfig;
  }
  return loadWorkerBridgeConfigFromEnv();
}

export function isWorkerBridgeEnabled(): boolean {
  return getWorkerBridgeConfig().enabled;
}

// TODO(issue-262): Remove override plumbing once the worker bridge flag is retired post-rollout.
export function setWorkerBridgeConfigOverrideForTesting(
  config: WorkerBridgeConfig | null,
): void {
  overrideConfig = config;
}
