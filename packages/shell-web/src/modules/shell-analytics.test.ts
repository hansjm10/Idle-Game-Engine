import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { TelemetryEventData } from '@idle-engine/core';

import {
  installShellTelemetryFacade,
  resetShellTelemetryFacadeForTesting,
  setShellAnalyticsConfigOverrideForTesting,
  type ShellAnalyticsFacade,
} from './shell-analytics.js';

describe('shell analytics telemetry facade', () => {
  beforeEach(() => {
    resetShellTelemetryFacadeForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    setShellAnalyticsConfigOverrideForTesting(null);
    resetShellTelemetryFacadeForTesting();
    delete (globalThis as { navigator?: unknown }).navigator;
    delete (globalThis as { fetch?: unknown }).fetch;
    vi.restoreAllMocks();
  });

  it('registers a facade when none is present', () => {
    installShellTelemetryFacade();

    const globalFacade = (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: ShellAnalyticsFacade;
    }).__IDLE_ENGINE_TELEMETRY__;

    expect(globalFacade).toBeDefined();
    expect(typeof globalFacade?.recordError).toBe('function');
  });

  it('wraps an existing facade so both are invoked', () => {
    const upstreamSpy = vi.fn<void, [string, TelemetryEventData | undefined]>();
    const originalFacade: ShellAnalyticsFacade = {
      recordError: upstreamSpy,
    };

    (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: ShellAnalyticsFacade;
    }).__IDLE_ENGINE_TELEMETRY__ = originalFacade;

    installShellTelemetryFacade();

    const facade = (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: ShellAnalyticsFacade;
    }).__IDLE_ENGINE_TELEMETRY__;

    expect(facade).toBeDefined();
    expect(facade).not.toBe(originalFacade);

    const payload: TelemetryEventData = { code: 'RESTORE_FAILED' };
    facade?.recordError('WorkerBridgeError', payload);

    expect(upstreamSpy).toHaveBeenCalledWith('WorkerBridgeError', payload);
  });

  it('uses sendBeacon when an endpoint and transport are configured', () => {
    const sendBeacon = vi.fn<true, [string, unknown]>(() => true);
    (globalThis as { navigator?: Navigator }).navigator = {
      sendBeacon,
    } as Navigator;
    setShellAnalyticsConfigOverrideForTesting({
      endpoint: 'https://example.com/telemetry',
    });
    installShellTelemetryFacade();

    const facade = (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: ShellAnalyticsFacade;
    }).__IDLE_ENGINE_TELEMETRY__;
    expect(facade).toBeDefined();

    facade?.recordError('WorkerBridgeError', { code: 'RESTORE_FAILED' });

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = sendBeacon.mock.calls[0]!;
    expect(endpoint).toBe('https://example.com/telemetry');
    expect(typeof payload).toBe('string');
    expect(payload).toContain('"event":"WorkerBridgeError"');
    expect(payload).toContain('"code":"RESTORE_FAILED"');
  });

  it('falls back to fetch when sendBeacon is unavailable', async () => {
    const fetchMock = vi.fn<
      Promise<Response>,
      Parameters<typeof fetch>
    >(() => Promise.resolve(new Response(null, { status: 204 })));
    (globalThis as { fetch?: typeof fetch }).fetch = fetchMock as typeof fetch;
    setShellAnalyticsConfigOverrideForTesting({
      endpoint: 'https://example.com/telemetry',
    });

    installShellTelemetryFacade();

    const facade = (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: ShellAnalyticsFacade;
    }).__IDLE_ENGINE_TELEMETRY__;

    await facade?.recordError('WorkerBridgeError', { code: 'RESTORE_FAILED' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [request, options] = fetchMock.mock.calls[0]!;
    expect(request).toBe('https://example.com/telemetry');
    expect(options?.method).toBe('POST');
    expect(options?.body).toContain('"event":"WorkerBridgeError"');
  });

  it('logs to the console when no endpoint is provided', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    installShellTelemetryFacade();

    const facade = (globalThis as {
      __IDLE_ENGINE_TELEMETRY__?: ShellAnalyticsFacade;
    }).__IDLE_ENGINE_TELEMETRY__;
    expect(facade).toBeDefined();

    facade?.recordError('WorkerBridgeError', { code: 'RESTORE_FAILED' });

    expect(consoleSpy).toHaveBeenCalledWith(
      '[shell-analytics] Worker error telemetry (no endpoint configured)',
      expect.objectContaining({
        event: 'WorkerBridgeError',
      }),
    );
  });
});
