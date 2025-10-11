import { afterEach, describe, expect, it } from 'vitest';

import {
  telemetry,
  type TelemetryEventData,
  type TelemetryFacade,
  resetTelemetry,
  setTelemetry,
} from './telemetry.js';

class StatefulTelemetry implements TelemetryFacade {
  readonly errors: Array<{ event: string; data: TelemetryEventData | undefined }> =
    [];

  recordError(event: string, data?: TelemetryEventData): void {
    this.errors.push({ event, data });
  }

  recordWarning(): void {
    throw new Error('recordWarning should not be invoked in this test.');
  }

  recordProgress(): void {
    throw new Error('recordProgress should not be invoked in this test.');
  }

  recordTick(): void {
    throw new Error('recordTick should not be invoked in this test.');
  }
}

afterEach(() => {
  resetTelemetry();
});

describe('telemetry', () => {
  it('preserves facade context when invoking recorders', () => {
    const facade = new StatefulTelemetry();
    setTelemetry(facade);

    const data: TelemetryEventData = Object.freeze({ detail: 42 });
    telemetry.recordError('TestEvent', data);

    expect(facade.errors).toEqual([{ event: 'TestEvent', data }]);
  });
});
