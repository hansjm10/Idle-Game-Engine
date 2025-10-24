import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { createResourceState } from './resource-state.js';
import { createGeneratorState } from './generator-state.js';
import { createUpgradeState } from './upgrade-state.js';
import { RuntimeChangeJournal } from './runtime-change-journal.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

describe('RuntimeChangeJournal', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('collects per-tick deltas for touched entities only', () => {
    const resources = createResourceState([
      { id: 'energy', startAmount: 10, capacity: 20 },
      { id: 'crystal', startAmount: 5, capacity: 15 },
    ]);
    const generators = createGeneratorState([
      { id: 'reactor', startLevel: 1, maxLevel: 5 },
      { id: 'solar' },
    ]);
    const upgrades = createUpgradeState([
      { id: 'core-efficiency' },
      { id: 'automation-suite', maxPurchases: 3 },
    ]);

    const energy = resources.requireIndex('energy');
    resources.addAmount(energy, 4);

    const reactor = generators.requireIndex('reactor');
    generators.adjustLevel(reactor, 2);

    const automation = upgrades.requireIndex('automation-suite');
    upgrades.purchase(automation, 2);

    const journal = new RuntimeChangeJournal();
    const delta = journal.capture({
      tick: 42,
      resources,
      generators,
      upgrades,
    });

    expect(delta).toBeDefined();
    expect(delta?.tick).toBe(42);
    expect(delta?.resources?.count).toBe(1);
    expect(Array.from(delta?.resources?.indices ?? [])).toEqual([energy]);
    expect(Array.from(delta?.resources?.amounts ?? [])).toEqual([14]);
    expect(Array.from(delta?.resources?.tickDelta ?? [])).toEqual([4]);

    expect(delta?.generators?.dirtyCount).toBe(1);
    expect(Array.from(delta?.generators?.indices ?? [])).toEqual([reactor]);
    expect(Array.from(delta?.generators?.levels ?? [])).toEqual([3]);

    expect(delta?.upgrades?.dirtyCount).toBe(1);
    expect(Array.from(delta?.upgrades?.indices ?? [])).toEqual([automation]);
    expect(Array.from(delta?.upgrades?.purchaseCount ?? [])).toEqual([2]);

    // Capturing again without changes returns undefined.
    expect(
      journal.capture({
        tick: 43,
        resources,
        generators,
        upgrades,
      }),
    ).toBeUndefined();
  });

  it('enforces monotonic tick progression when enabled', () => {
    const resources = createResourceState([{ id: 'energy' }]);
    const journal = new RuntimeChangeJournal();
    resources.addAmount(resources.requireIndex('energy'), 1);
    journal.capture({ tick: 5, resources });

    expect(() => {
      journal.capture({ tick: 4, resources });
    }).toThrowError(/monotonic/i);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'RuntimeChangeJournalNonMonotonicTick',
      expect.objectContaining({ previous: 5, current: 4 }),
    );
  });
});

