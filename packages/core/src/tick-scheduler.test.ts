import { describe, expect, it } from 'vitest';

import {
  FixedTimestepScheduler,
  type SchedulerStepExecutionContext,
} from './tick-scheduler.js';

describe('FixedTimestepScheduler', () => {
  it('limits foreground steps and respects background throttling', () => {
    const executions: SchedulerStepExecutionContext[] = [];
    const scheduler = new FixedTimestepScheduler(
      (context) => {
        executions.push({ ...context });
      },
      {
        stepSizeMs: 10,
        maxForegroundStepsPerFrame: 3,
        maxBackgroundStepsPerFrame: 1,
      },
    );

    const foregroundResult = scheduler.advance(50);

    expect(foregroundResult.executedSteps).toBe(3);
    expect(executions).toHaveLength(3);
    expect(executions[0]).toMatchObject({
      isCatchUp: false,
      isFirstInBatch: true,
      backlogMs: 40,
    });
    expect(executions[2]?.backlogMs).toBe(20);

    executions.length = 0;
    scheduler.setThrottled(true);

    const backgroundResult = scheduler.advance(50);

    expect(backgroundResult.executedSteps).toBe(1);
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({
      isCatchUp: false,
      isFirstInBatch: true,
      backlogMs: 60,
    });
    expect(scheduler.getAccumulatorMs()).toBe(60);
  });

  it('caps offline catch-up and reports overflow', () => {
    const executions: SchedulerStepExecutionContext[] = [];
    const scheduler = new FixedTimestepScheduler(
      (context) => {
        executions.push({ ...context });
      },
      {
        stepSizeMs: 100,
        maxForegroundStepsPerFrame: 10,
        maxOfflineCatchUpMs: 300,
        maxOfflineBatchSteps: 2,
      },
    );

    const result = scheduler.catchUp(550);

    expect(result.requestedMs).toBe(550);
    expect(result.simulatedMs).toBe(300);
    expect(result.overflowMs).toBe(250);
    expect(result.executedSteps).toBe(3);
    expect(result.backlogMs).toBe(0);
    expect(executions).toHaveLength(3);
    expect(executions[0]?.isFirstInBatch).toBe(true);
    expect(
      executions.slice(1).every((context) => context.isFirstInBatch === false),
    ).toBe(true);
  });

  it('retains partial backlog after offline catch-up', () => {
    const executions: SchedulerStepExecutionContext[] = [];
    const scheduler = new FixedTimestepScheduler(
      (context) => {
        executions.push({ ...context });
      },
      {
        stepSizeMs: 40,
        maxForegroundStepsPerFrame: 5,
        maxOfflineCatchUpMs: 1000,
      },
    );

    const result = scheduler.catchUp(90);

    expect(result.executedSteps).toBe(2);
    expect(result.simulatedMs).toBe(80);
    expect(result.backlogMs).toBe(10);
    expect(executions[0]?.backlogMs).toBe(50);
    expect(executions[1]?.backlogMs).toBe(10);
    expect(executions[0]?.isFirstInBatch).toBe(true);
    expect(executions[1]?.isFirstInBatch).toBe(false);
  });

  it('treats non-finite offline catch-up requests as a no-op', () => {
    const executions: SchedulerStepExecutionContext[] = [];
    const scheduler = new FixedTimestepScheduler(
      (context) => {
        executions.push({ ...context });
      },
      {
        stepSizeMs: 100,
      },
    );

    // Build a backlog that should remain untouched by the guard.
    scheduler.advance(50);
    const priorBacklog = scheduler.getAccumulatorMs();

    const nanResult = scheduler.catchUp(Number.NaN);
    expect(nanResult.requestedMs).toBe(0);
    expect(nanResult.simulatedMs).toBe(0);
    expect(nanResult.executedSteps).toBe(0);
    expect(nanResult.overflowMs).toBe(0);
    expect(nanResult.backlogMs).toBe(priorBacklog);

    const infiniteResult = scheduler.catchUp(Number.POSITIVE_INFINITY);
    expect(infiniteResult.requestedMs).toBe(0);
    expect(infiniteResult.simulatedMs).toBe(0);
    expect(infiniteResult.executedSteps).toBe(0);
    expect(infiniteResult.overflowMs).toBe(0);
    expect(infiniteResult.backlogMs).toBe(priorBacklog);

    expect(executions).toHaveLength(0);
  });
});
