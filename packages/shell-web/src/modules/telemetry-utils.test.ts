import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  getTelemetryFacade,
  recordTelemetryEvent,
  recordTelemetryError,
  type ShellTelemetryFacade,
} from './telemetry-utils.js';

describe('telemetry-utils', () => {
  let telemetryEvents: Array<{ event: string; data: Record<string, unknown> }>;
  let telemetryErrors: Array<{ event: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    // Setup telemetry spy
    telemetryEvents = [];
    telemetryErrors = [];

    const facade: ShellTelemetryFacade = {
      recordEvent: (event: string, data: Record<string, unknown>) => {
        telemetryEvents.push({ event, data });
      },
      recordError: (event: string, data: Record<string, unknown>) => {
        telemetryErrors.push({ event, data });
      },
    };

    (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade }).__IDLE_ENGINE_TELEMETRY__ =
      facade;
  });

  afterEach(() => {
    delete (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade })
      .__IDLE_ENGINE_TELEMETRY__;
  });

  describe('getTelemetryFacade', () => {
    it('returns the global telemetry facade when available', () => {
      const facade = getTelemetryFacade();

      expect(facade).toBeDefined();
      expect(facade?.recordEvent).toBeDefined();
      expect(facade?.recordError).toBeDefined();
    });

    it('returns undefined when telemetry facade is not installed', () => {
      delete (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade })
        .__IDLE_ENGINE_TELEMETRY__;

      const facade = getTelemetryFacade();

      expect(facade).toBeUndefined();
    });
  });

  describe('recordTelemetryEvent', () => {
    it('records an event when facade is available', () => {
      recordTelemetryEvent('TestEvent', { foo: 'bar', count: 42 });

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0]).toEqual({
        event: 'TestEvent',
        data: { foo: 'bar', count: 42 },
      });
    });

    it('handles multiple event recordings', () => {
      recordTelemetryEvent('Event1', { value: 1 });
      recordTelemetryEvent('Event2', { value: 2 });
      recordTelemetryEvent('Event3', { value: 3 });

      expect(telemetryEvents).toHaveLength(3);
      expect(telemetryEvents[0]?.event).toBe('Event1');
      expect(telemetryEvents[1]?.event).toBe('Event2');
      expect(telemetryEvents[2]?.event).toBe('Event3');
    });

    it('does not throw when facade is missing', () => {
      delete (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade })
        .__IDLE_ENGINE_TELEMETRY__;

      expect(() => {
        recordTelemetryEvent('TestEvent', { foo: 'bar' });
      }).not.toThrow();
    });

    it('does not throw when recordEvent method is missing', () => {
      (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade }).__IDLE_ENGINE_TELEMETRY__ =
        {
          recordError: (event, data) => {
            telemetryErrors.push({ event, data });
          },
        };

      expect(() => {
        recordTelemetryEvent('TestEvent', { foo: 'bar' });
      }).not.toThrow();

      expect(telemetryEvents).toHaveLength(0);
    });

    it('handles empty data object', () => {
      recordTelemetryEvent('EmptyDataEvent', {});

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0]).toEqual({
        event: 'EmptyDataEvent',
        data: {},
      });
    });

    it('handles complex nested data structures', () => {
      const complexData = {
        user: { id: '123', name: 'Test User' },
        metrics: { count: 42, ratio: 0.75 },
        tags: ['tag1', 'tag2'],
      };

      recordTelemetryEvent('ComplexEvent', complexData);

      expect(telemetryEvents).toHaveLength(1);
      expect(telemetryEvents[0]?.data).toEqual(complexData);
    });
  });

  describe('recordTelemetryError', () => {
    it('records an error when facade is available', () => {
      recordTelemetryError('TestError', {
        errorMessage: 'Something went wrong',
        errorCode: 'ERR_TEST',
      });

      expect(telemetryErrors).toHaveLength(1);
      expect(telemetryErrors[0]).toEqual({
        event: 'TestError',
        data: {
          errorMessage: 'Something went wrong',
          errorCode: 'ERR_TEST',
        },
      });
    });

    it('handles multiple error recordings', () => {
      recordTelemetryError('Error1', { code: 'E1' });
      recordTelemetryError('Error2', { code: 'E2' });

      expect(telemetryErrors).toHaveLength(2);
      expect(telemetryErrors[0]?.event).toBe('Error1');
      expect(telemetryErrors[1]?.event).toBe('Error2');
    });

    it('does not throw when facade is missing', () => {
      delete (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade })
        .__IDLE_ENGINE_TELEMETRY__;

      expect(() => {
        recordTelemetryError('TestError', { errorMessage: 'test' });
      }).not.toThrow();
    });

    it('does not throw when recordError method is missing', () => {
      (globalThis as { __IDLE_ENGINE_TELEMETRY__?: ShellTelemetryFacade }).__IDLE_ENGINE_TELEMETRY__ =
        {
          recordEvent: (event, data) => {
            telemetryEvents.push({ event, data });
          },
        };

      expect(() => {
        recordTelemetryError('TestError', { errorMessage: 'test' });
      }).not.toThrow();

      expect(telemetryErrors).toHaveLength(0);
    });

    it('handles error data with stack traces', () => {
      const error = new Error('Test error');
      recordTelemetryError('ErrorWithStack', {
        errorMessage: error.message,
        errorStack: error.stack,
        errorName: error.name,
      });

      expect(telemetryErrors).toHaveLength(1);
      expect(telemetryErrors[0]?.data.errorMessage).toBe('Test error');
      expect(telemetryErrors[0]?.data.errorStack).toBeDefined();
      expect(telemetryErrors[0]?.data.errorName).toBe('Error');
    });
  });

  describe('integration with both methods', () => {
    it('can record both events and errors independently', () => {
      recordTelemetryEvent('Event1', { value: 1 });
      recordTelemetryError('Error1', { code: 'E1' });
      recordTelemetryEvent('Event2', { value: 2 });
      recordTelemetryError('Error2', { code: 'E2' });

      expect(telemetryEvents).toHaveLength(2);
      expect(telemetryErrors).toHaveLength(2);

      expect(telemetryEvents[0]?.event).toBe('Event1');
      expect(telemetryEvents[1]?.event).toBe('Event2');
      expect(telemetryErrors[0]?.event).toBe('Error1');
      expect(telemetryErrors[1]?.event).toBe('Error2');
    });
  });
});
