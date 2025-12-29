import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryEventData, TelemetryFacade } from './telemetry.js';
import {
  createConsoleTelemetry,
  createContextualTelemetry,
  resetTelemetry,
  setTelemetry,
  silentTelemetry,
  telemetry,
} from './telemetry.js';

describe('telemetry facade', () => {
  afterEach(() => {
    resetTelemetry();
  });

  it('preserves facade context when invoking delegated methods', () => {
    class StatefulTelemetryFacade implements TelemetryFacade {
      history: string[] = [];
      lastProgressData?: TelemetryEventData;
      lastCounters?: Readonly<Record<string, number>>;

      constructor(private readonly label: string) {}

      private note(kind: string, event?: string) {
        this.history.push(
          event ? `${this.label}:${kind}:${event}` : `${this.label}:${kind}`,
        );
      }

      recordError(event: string): void {
        this.note('error', event);
      }

      recordWarning(event: string, _data?: TelemetryEventData): void {
        this.note('warning', event);
      }

      recordProgress(event: string, data?: TelemetryEventData): void {
        this.note('progress', event);
        this.lastProgressData = data;
      }

      recordCounters(group: string, counters: Readonly<Record<string, number>>): void {
        this.note('counters', group);
        this.lastCounters = counters;
      }

      recordTick(): void {
        this.note('tick');
      }
    }

    const facade = new StatefulTelemetryFacade('custom');
    setTelemetry(facade);

    const progressData = { milestone: 'alpha' };

    telemetry.recordError('failure');
    telemetry.recordWarning('unstable');
    telemetry.recordProgress('milestone', progressData);
    telemetry.recordCounters('events', { published: 3 });
    telemetry.recordTick();

    expect(facade.history).toEqual([
      'custom:error:failure',
      'custom:warning:unstable',
      'custom:progress:milestone',
      'custom:counters:events',
      'custom:tick',
    ]);
    expect(facade.lastProgressData).toBe(progressData);
    expect(facade.lastCounters).toEqual({ published: 3 });
  });

  it('merges shared context into event payloads', () => {
    const recordError = vi.fn();
    const recordWarning = vi.fn();
    const recordProgress = vi.fn();
    const recordCounters = vi.fn();
    const recordTick = vi.fn();

    const baseFacade: TelemetryFacade = {
      recordError,
      recordWarning,
      recordProgress,
      recordCounters,
      recordTick,
    };

    const contextual = createContextualTelemetry(baseFacade, {
      runtimeVersion: '1.2.3',
      clientId: 'client-1',
    });

    contextual.recordWarning('unstable');
    contextual.recordProgress('prediction', {
      runtimeVersion: 'override',
      localStep: 3,
    });

    expect(recordWarning).toHaveBeenCalledWith('unstable', {
      runtimeVersion: '1.2.3',
      clientId: 'client-1',
    });
    expect(recordProgress).toHaveBeenCalledWith('prediction', {
      runtimeVersion: 'override',
      clientId: 'client-1',
      localStep: 3,
    });
  });

  it('logs a console error when delegated invocation fails', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = new Error('telemetry facade failed');

    const faultyFacade: TelemetryFacade = {
      recordError: vi.fn(() => {
        throw thrown;
      }),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };

    setTelemetry(faultyFacade);

    try {
      telemetry.recordError('failure');
      expect(errorSpy).toHaveBeenCalledWith('[telemetry] invocation failed', thrown);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('is silent by default', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    try {
      // After resetTelemetry(), telemetry should be silent
      resetTelemetry();

      telemetry.recordError('error');
      telemetry.recordWarning('warning');
      telemetry.recordProgress('progress');
      telemetry.recordCounters('counters', { count: 1 });
      telemetry.recordTick();

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('createConsoleTelemetry returns a facade that logs to console', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    try {
      const consoleFacade = createConsoleTelemetry();
      setTelemetry(consoleFacade);

      telemetry.recordError('error');
      telemetry.recordWarning('warning');
      telemetry.recordProgress('progress');
      telemetry.recordCounters('counters', { count: 1 });
      telemetry.recordTick();

      expect(errorSpy).toHaveBeenCalledWith('[telemetry:error] error', undefined);
      expect(warnSpy).toHaveBeenCalledWith('[telemetry:warning] warning', undefined);
      expect(infoSpy).toHaveBeenCalledWith('[telemetry:progress] progress', undefined);
      expect(infoSpy).toHaveBeenCalledWith('[telemetry:counters] counters', { count: 1 });
      expect(debugSpy).toHaveBeenCalledWith('[telemetry:tick]');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });

  it('silentTelemetry is a no-op facade', () => {
    expect(silentTelemetry.recordError).toBeDefined();
    expect(silentTelemetry.recordWarning).toBeDefined();
    expect(silentTelemetry.recordProgress).toBeDefined();
    expect(silentTelemetry.recordCounters).toBeDefined();
    expect(silentTelemetry.recordTick).toBeDefined();

    // Should not throw when called
    expect(() => {
      silentTelemetry.recordError('error');
      silentTelemetry.recordWarning('warning');
      silentTelemetry.recordProgress('progress');
      silentTelemetry.recordCounters('counters', { count: 1 });
      silentTelemetry.recordTick();
    }).not.toThrow();
  });
});
