export interface EconomyPreviewConfig {
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

let overrideConfig: EconomyPreviewConfig | null = null;

function readEnvironmentValue(key: string): string | undefined {
  if (typeof import.meta !== 'undefined' && import.meta.env?.[key] !== undefined) {
    return import.meta.env[key] as string | undefined;
  }
  if (typeof process !== 'undefined' && process.env?.[key] !== undefined) {
    return process.env[key];
  }
  return undefined;
}

function loadEconomyPreviewConfigFromEnv(): EconomyPreviewConfig {
  const rawEnabled =
    readEnvironmentValue('VITE_ENABLE_ECONOMY_PREVIEW') ??
    readEnvironmentValue('ENABLE_ECONOMY_PREVIEW');

  return {
    enabled: coerceBoolean(rawEnabled, false),
  };
}

export function getEconomyPreviewConfig(): EconomyPreviewConfig {
  if (overrideConfig) {
    return overrideConfig;
  }
  return loadEconomyPreviewConfigFromEnv();
}

export function isEconomyPreviewEnabled(): boolean {
  return getEconomyPreviewConfig().enabled;
}

export function setEconomyPreviewConfigOverrideForTesting(
  config: EconomyPreviewConfig | null,
): void {
  overrideConfig = config;
}
