import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TelemetryEventData, TelemetryFacade } from './telemetry.js';
import { resetTelemetry, setTelemetry, telemetry } from './telemetry.js';

describe('telemetry facade', () => {
  afterEach(() => {
    resetTelemetry();
  });

  it('preserves facade context when invoking delegated methods', () => {
    class StatefulTelemetryFacade implements TelemetryFacade {
      history: string[] = [];
      lastProgressData?: TelemetryEventData;

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
    telemetry.recordTick();

    expect(facade.history).toEqual([
      'custom:error:failure',
      'custom:warning:unstable',
      'custom:progress:milestone',
      'custom:tick',
    ]);
    expect(facade.lastProgressData).toBe(progressData);
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
});
