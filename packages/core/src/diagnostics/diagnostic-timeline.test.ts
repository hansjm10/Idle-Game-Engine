import { describe, expect, it } from 'vitest';

import {
  createDiagnosticTimelineRecorder,
  createNoopDiagnosticTimelineRecorder,
  toErrorLike,
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

    const delta = recorder.readDelta();

    expect(delta.head).toBe(3);
    expect(delta.dropped).toBe(1);
    expect(delta.configuration.capacity).toBe(2);
    expect(delta.entries.length).toBe(2);
    expect(delta.entries[0].tick).toBe(2);
    expect(delta.entries[1].tick).toBe(3);
    expect(delta.entries[0].durationMs).toBeCloseTo(3);
    expect(delta.entries[1].durationMs).toBeCloseTo(4);
    expect(Object.isFrozen(delta.entries)).toBe(true);
    expect(delta.entries.every((entry) => Object.isFrozen(entry))).toBe(
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

    const delta = recorder.readDelta();
    expect(delta.entries.length).toBe(2);

    const [fastEntry, slowEntry] = delta.entries;

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

    const delta = recorder.readDelta();

    expect(delta.configuration.capacity).toBe(0);
    expect(delta.entries.length).toBe(0);
    expect(delta.dropped).toBe(2);
    expect(delta.head).toBe(2);
    expect(Object.isFrozen(delta.entries)).toBe(true);
  });

  it('returns only new entries when requesting a delta and reports dropped count', () => {
    const clock = new StubClock();
    const recorder = createDiagnosticTimelineRecorder({
      capacity: 2,
      clock,
      slowTickBudgetMs: 10,
    });

    const first = recorder.startTick(1);
    clock.advance(3);
    first.end();

    const fullSnapshot = recorder.readDelta();
    expect(fullSnapshot.entries.length).toBe(1);
    expect(fullSnapshot.head).toBe(1);
    expect(fullSnapshot.dropped).toBe(0);

    const second = recorder.startTick(2);
    clock.advance(2);
    second.end();

    const delta = recorder.readDelta(fullSnapshot.head);
    expect(delta.entries.length).toBe(1);
    expect(delta.entries[0]?.tick).toBe(2);
    expect(delta.dropped).toBe(0);

    const third = recorder.startTick(3);
    clock.advance(4);
    third.end();

    const rolledOver = recorder.readDelta(fullSnapshot.head);
    expect(rolledOver.entries.length).toBe(2);
    expect(rolledOver.entries.map((entry) => entry.tick)).toEqual([2, 3]);
    expect(rolledOver.dropped).toBe(0);

    const fourth = recorder.startTick(4);
    clock.advance(5);
    fourth.end();

    const overwritten = recorder.readDelta(fullSnapshot.head);
    expect(overwritten.entries.length).toBe(2);
    expect(overwritten.entries.map((entry) => entry.tick)).toEqual([3, 4]);
    expect(overwritten.dropped).toBe(1);
  });
});

describe('createNoopDiagnosticTimelineRecorder', () => {
  it('provides a stable empty snapshot and ignores all tick events', () => {
    const recorder = createNoopDiagnosticTimelineRecorder();

    const tick = recorder.startTick(100);
    tick.end({ error: new Error('ignored') });
    tick.fail(new Error('double ignore'));

    const delta = recorder.readDelta();
    const nextDelta = recorder.readDelta();

    expect(delta.entries.length).toBe(0);
    expect(delta.head).toBe(0);
    expect(delta.dropped).toBe(0);
    expect(delta).toBe(nextDelta);
  });
});

describe('toErrorLike', () => {
  it('preserves empty strings on serialized errors', () => {
    const error = new Error('');
    error.stack = '';

    const result = toErrorLike(error);

    expect(result).toEqual({
      name: 'Error',
      message: '',
      stack: '',
    });
  });
});
