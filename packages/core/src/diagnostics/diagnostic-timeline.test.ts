import { describe, expect, it } from 'vitest';

import {
  createDiagnosticTimelineRecorder,
  createNoopDiagnosticTimelineRecorder,
  type HighResolutionClock,
} from './diagnostic-timeline.js';

class StubClock implements HighResolutionClock {
  current = 0;

  now(): number {
    return this.current;
  }

  advance(byMs: number): void {
    this.current += byMs;
  }

  jump(toMs: number): void {
    this.current = toMs;
  }
}

describe('DiagnosticTimelineRecorder', () => {
  it('overwrites oldest entries when the ring buffer rolls over', () => {
    const clock = new StubClock();
    const recorder = createDiagnosticTimelineRecorder({
      capacity: 2,
      clock,
      slowTickBudgetMs: 10,
    });

    const tickOne = recorder.startTick(1);
    clock.advance(5);
    tickOne.end();

    clock.advance(2);
    const tickTwo = recorder.startTick(2);
    clock.advance(3);
    tickTwo.end();

    clock.advance(1);
    const tickThree = recorder.startTick(3);
    clock.advance(4);
    tickThree.end();

    const snapshot = recorder.snapshot();

    expect(snapshot.capacity).toBe(2);
    expect(snapshot.size).toBe(2);
    expect(snapshot.entries.length).toBe(2);
    expect(snapshot.entries[0].tick).toBe(2);
    expect(snapshot.entries[1].tick).toBe(3);
    expect(snapshot.entries[0].durationMs).toBeCloseTo(3);
    expect(snapshot.entries[1].durationMs).toBeCloseTo(4);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(snapshot.entries.every((entry) => Object.isFrozen(entry))).toBe(
      true,
    );
  });

  it('marks ticks exceeding the budget as slow and reports the overage', () => {
    const clock = new StubClock();
    const recorder = createDiagnosticTimelineRecorder({
      capacity: 5,
      clock,
      slowTickBudgetMs: 5,
    });

    const fastTick = recorder.startTick(10);
    clock.advance(4);
    fastTick.end();

    const slowTick = recorder.startTick(11);
    clock.advance(7);
    slowTick.end();

    const snapshot = recorder.snapshot();
    expect(snapshot.entries.length).toBe(2);

    const [fastEntry, slowEntry] = snapshot.entries;

    expect(fastEntry.isSlow).toBe(false);
    expect(fastEntry.overBudgetMs).toBe(0);
    expect(fastEntry.budgetMs).toBe(5);

    expect(slowEntry.isSlow).toBe(true);
    expect(slowEntry.overBudgetMs).toBeCloseTo(2);
    expect(slowEntry.budgetMs).toBe(5);
  });

  it('counts dropped ticks when capacity is zero', () => {
    const clock = new StubClock();
    const recorder = createDiagnosticTimelineRecorder({
      capacity: 0,
      clock,
      slowTickBudgetMs: 5,
    });

    const firstTick = recorder.startTick(1);
    clock.advance(3);
    firstTick.end();

    const secondTick = recorder.startTick(2);
    clock.advance(2);
    secondTick.end();

    const snapshot = recorder.snapshot();

    expect(snapshot.capacity).toBe(0);
    expect(snapshot.size).toBe(0);
    expect(snapshot.entries.length).toBe(0);
    expect(snapshot.droppedEntries).toBe(2);
    expect(snapshot.lastTick).toBe(2);
  });
});

describe('createNoopDiagnosticTimelineRecorder', () => {
  it('provides a stable empty snapshot and ignores all tick events', () => {
    const recorder = createNoopDiagnosticTimelineRecorder();

    const tick = recorder.startTick(100);
    tick.end({ error: new Error('ignored') });
    tick.fail(new Error('double ignore'));

    const snapshot = recorder.snapshot();
    const nextSnapshot = recorder.snapshot();

    expect(snapshot.entries.length).toBe(0);
    expect(snapshot.capacity).toBe(0);
    expect(snapshot).toBe(nextSnapshot);
  });
});
