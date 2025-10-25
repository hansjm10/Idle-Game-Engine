import { describe, expect, it } from 'vitest';

import { createResourceState } from '../resource-state.js';
import { createGeneratorState } from '../generator-state.js';
import {
  additiveModifier,
  createModifierPipeline,
  multiplicativeModifier,
} from '../modifiers/modifier-pipeline.js';
import type {
  EventPublisher,
  PublishResult,
} from '../events/event-bus.js';
import type { RuntimeEventPayload, RuntimeEventType } from '../events/runtime-event.js';
import type { TickContext } from './system-types.js';
import { createProductionSystem } from './production-system.js';
import { GeneratorModifierLedger } from './modifier-ledger.js';

describe('production-system', () => {
  it('applies generator outputs to resource income using ledger modifiers', () => {
    const resources = createResourceState([{ id: 'energy' }]);
    const generators = createGeneratorState([
      { id: 'reactor', startLevel: 2 },
    ]);
    const ledger = new GeneratorModifierLedger();
    ledger.applyAdditive('reactor', 1);
    ledger.applyMultiplicative('reactor', 1.5);

    const system = createProductionSystem({
      resources,
      generators,
      ledger,
      definitions: [
        {
          generatorId: 'reactor',
          produces: [
            {
              resourceId: 'energy',
              ratePerSecond: 1,
            },
          ],
        },
      ],
    });

    system.tick(createContext());

    const snapshot = resources.snapshot({ mode: 'recorder' });
    const energy = resources.requireIndex('energy');
    // Base rate = 2, additive +1 => 3, multiplicative *1.5 => 4.5
    expect(snapshot.incomePerSecond[energy]).toBeCloseTo(4.5, 6);
  });

  it('supports per-output pipelines for additional adjustments', () => {
    const resources = createResourceState([{ id: 'energy' }]);
    const generators = createGeneratorState([
      { id: 'reactor', startLevel: 1 },
    ]);
    const ledger = new GeneratorModifierLedger();

    const system = createProductionSystem({
      resources,
      generators,
      ledger,
      definitions: [
        {
          generatorId: 'reactor',
          produces: [
            {
              resourceId: 'energy',
              ratePerSecond: 2,
              pipeline: createModifierPipeline([
                additiveModifier(() => 1),
                multiplicativeModifier(() => 2),
              ]),
            },
          ],
        },
      ],
    });

    system.tick(createContext());

    const snapshot = resources.snapshot({ mode: 'recorder' });
    const energy = resources.requireIndex('energy');
    // Base 2, pipeline adds 1 => 3, multiplies by 2 => 6
    expect(snapshot.incomePerSecond[energy]).toBeCloseTo(6, 6);
  });

  it('clamps consumption outputs when modifiers reduce the rate below zero', () => {
    const resources = createResourceState([{ id: 'fuel' }]);
    const generators = createGeneratorState([
      { id: 'engine', startLevel: 1 },
    ]);
    const ledger = new GeneratorModifierLedger();

    const system = createProductionSystem({
      resources,
      generators,
      ledger,
      definitions: [
        {
          generatorId: 'engine',
          consumes: [
            {
              resourceId: 'fuel',
              ratePerSecond: 5,
              pipeline: createModifierPipeline([
                additiveModifier(() => -10),
              ]),
            },
          ],
          produces: [],
        },
      ],
    });

    system.tick(createContext());

    const snapshot = resources.snapshot({ mode: 'recorder' });
    const fuel = resources.requireIndex('fuel');
    expect(snapshot.expensePerSecond[fuel]).toBe(0);
  });
});

function createContext(): TickContext {
  return {
    deltaMs: 100,
    step: 0,
    events: createEventPublisherStub(),
  };
}

function createEventPublisherStub(): EventPublisher {
  return {
    publish<TType extends RuntimeEventType>(
      eventType: TType,
      _payload: RuntimeEventPayload<TType>,
    ): PublishResult<TType> {
      return {
        accepted: true,
        state: 'accepted',
        type: eventType,
        channel: 0,
        bufferSize: 0,
        remainingCapacity: 0,
        dispatchOrder: 0,
        softLimitActive: false,
      };
    },
  };
}
