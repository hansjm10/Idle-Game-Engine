export interface SocialConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
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

let overrideConfig: SocialConfig | null = null;

function readEnvironmentValue(key: string): string | undefined {
  if (typeof import.meta !== 'undefined' && import.meta.env?.[key] !== undefined) {
    return import.meta.env[key] as string | undefined;
  }
  if (typeof process !== 'undefined' && process.env?.[key] !== undefined) {
    return process.env[key];
  }
  return undefined;
}

function loadSocialConfigFromEnv(): SocialConfig {
  const rawEnabled =
    readEnvironmentValue('VITE_ENABLE_SOCIAL_COMMANDS') ??
    readEnvironmentValue('ENABLE_SOCIAL_COMMANDS');

  const rawBaseUrl =
    readEnvironmentValue('VITE_SOCIAL_SERVICE_BASE_URL') ??
    readEnvironmentValue('SOCIAL_SERVICE_BASE_URL') ??
    'http://localhost:4000';

  return {
    enabled: coerceBoolean(rawEnabled, false),
    baseUrl: rawBaseUrl,
  };
}

export function getSocialConfig(): SocialConfig {
  if (overrideConfig) {
    return overrideConfig;
  }
  return loadSocialConfigFromEnv();
}

export function isSocialCommandsEnabled(): boolean {
  return getSocialConfig().enabled;
}

export function getSocialServiceBaseUrl(): string {
  return getSocialConfig().baseUrl;
}

export function setSocialConfigOverrideForTesting(
  config: SocialConfig | null,
): void {
  overrideConfig = config;
}
