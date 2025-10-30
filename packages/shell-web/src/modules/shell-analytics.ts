import type { TelemetryEventData } from '@idle-engine/core';

const TELEMETRY_FACADE_MARKER = Symbol('IdleShellTelemetryFacade');

export interface ShellAnalyticsFacade {
  recordError(event: string, data?: TelemetryEventData): void;
}

export interface ShellAnalyticsConfig {
  readonly endpoint?: string;
}

type IdleEngineTelemetryGlobal = typeof globalThis & {
  __IDLE_ENGINE_TELEMETRY__?: (ShellAnalyticsFacade & {
    [TELEMETRY_FACADE_MARKER]?: true;
  }) | undefined;
};

type NavigatorWithBeacon = Navigator & {
  sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let configOverride: ShellAnalyticsConfig | null = null;

function readEnvironmentValue(key: string): string | undefined {
  if (typeof import.meta !== 'undefined' && import.meta.env?.[key] !== undefined) {
    return import.meta.env[key] as string | undefined;
  }
  if (typeof process !== 'undefined' && process.env?.[key] !== undefined) {
    return process.env[key];
  }
  return undefined;
}

function loadShellAnalyticsConfig(): ShellAnalyticsConfig {
  const rawEndpoint =
    readEnvironmentValue('VITE_SHELL_ANALYTICS_ENDPOINT') ??
    readEnvironmentValue('SHELL_ANALYTICS_ENDPOINT');

  const endpoint = typeof rawEndpoint === 'string' ? rawEndpoint.trim() : undefined;

  return {
    endpoint: endpoint ? endpoint : undefined,
  };
}

function getShellAnalyticsConfig(): ShellAnalyticsConfig {
  if (configOverride) {
    return configOverride;
  }
  return loadShellAnalyticsConfig();
}

function postWithFetch(
  fetchImpl: FetchLike,
  endpoint: string,
  payload: string,
): void {
  fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: payload,
    keepalive: true,
  }).catch((error) => {
    console.warn('[shell-analytics] Failed to POST analytics payload', {
      endpoint,
      error,
    });
  });
}

function emitBrowserTelemetry(event: string, data: TelemetryEventData | undefined): void {
  const payload = {
    type: 'worker-error',
    event,
    data: data ?? {},
    timestamp: new Date().toISOString(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };

  const serialized = JSON.stringify(payload);
  const { endpoint } = getShellAnalyticsConfig();

  const navigatorWithBeacon = (typeof navigator !== 'undefined'
    ? (navigator as NavigatorWithBeacon)
    : undefined);
  const fetchImpl = typeof fetch === 'function' ? (fetch as FetchLike) : undefined;

  if (endpoint) {
    let delivered = false;

    if (navigatorWithBeacon?.sendBeacon) {
      try {
        delivered = navigatorWithBeacon.sendBeacon(endpoint, serialized);
      } catch (error) {
        console.warn('[shell-analytics] sendBeacon failed, falling back to fetch', {
          endpoint,
          error,
        });
      }
    }

    if (!delivered && fetchImpl) {
      postWithFetch(fetchImpl, endpoint, serialized);
      delivered = true;
    }

    if (!delivered) {
      console.warn('[shell-analytics] No transport available for analytics payload', {
        endpoint,
      });
    }
  }

  if (
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function' &&
    typeof CustomEvent === 'function'
  ) {
    try {
      window.dispatchEvent(
        new CustomEvent('idle-engine:telemetry', {
          detail: payload,
        }),
      );
    } catch (error) {
      console.warn('[shell-analytics] Failed to dispatch telemetry event', error);
    }
  }

  if (!endpoint) {
    console.info('[shell-analytics] Worker error telemetry (no endpoint configured)', {
      event,
      data: data ?? {},
    });
  }
}

function createShellAnalyticsFacade(
  previousFacade: ShellAnalyticsFacade | undefined,
): ShellAnalyticsFacade & {
  [TELEMETRY_FACADE_MARKER]: true;
} {
  const facade: ShellAnalyticsFacade & {
    [TELEMETRY_FACADE_MARKER]: true;
  } = {
    [TELEMETRY_FACADE_MARKER]: true,
    recordError(event, data) {
      emitBrowserTelemetry(event, data);
      previousFacade?.recordError(event, data);
    },
  };

  return facade;
}

export function installShellTelemetryFacade(): void {
  const globalTarget = globalThis as IdleEngineTelemetryGlobal;
  const current = globalTarget.__IDLE_ENGINE_TELEMETRY__;

  if (current?.[TELEMETRY_FACADE_MARKER]) {
    return;
  }

  const facade = createShellAnalyticsFacade(current);
  globalTarget.__IDLE_ENGINE_TELEMETRY__ = facade;
}

export function setShellAnalyticsConfigOverrideForTesting(
  config: ShellAnalyticsConfig | null,
): void {
  configOverride = config;
}

export function resetShellTelemetryFacadeForTesting(): void {
  const globalTarget = globalThis as IdleEngineTelemetryGlobal;
  if (globalTarget.__IDLE_ENGINE_TELEMETRY__?.[TELEMETRY_FACADE_MARKER]) {
    globalTarget.__IDLE_ENGINE_TELEMETRY__ = undefined;
  }
  configOverride = null;
}
