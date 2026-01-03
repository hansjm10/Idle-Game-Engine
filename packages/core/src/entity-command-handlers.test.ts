import { describe, expect, it } from 'vitest';

import type { NormalizedEntity } from '@idle-engine/content-schema';
import type {
  EventPublisher,
  PublishMetadata,
  PublishResult,
} from './events/event-bus.js';
import type {
  RuntimeEventPayload,
  RuntimeEventType,
} from './events/runtime-event.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import { createEntityDefinition, literalOne } from './content-test-helpers.js';
import { EntitySystem } from './entity-system.js';
import { registerEntityCommandHandlers } from './entity-command-handlers.js';

const createEventPublisher = (): EventPublisher => ({
  publish<TType extends RuntimeEventType>(
    eventType: TType,
    _payload: RuntimeEventPayload<TType>,
    _metadata?: PublishMetadata,
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
});

describe('entity command handlers', () => {
  it('validates add entity payloads', () => {
    const definition = createEntityDefinition('entity.worker', {
      trackInstances: false,
    });
    const entitySystem = new EntitySystem([definition], { nextInt: () => 1 });
    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.ADD_ENTITY);
    const result = handler?.(
      { entityId: '', count: 1 },
      {
        step: 1,
        timestamp: 1,
        priority: CommandPriority.PLAYER,
        events: createEventPublisher(),
      },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INVALID_ENTITY_ID',
        message: 'Entity id must be a non-empty string.',
      },
    });
  });

  it('creates entity instances via commands', () => {
    const definition = createEntityDefinition('entity.scout', {
      trackInstances: true,
      stats: ([
        {
          id: 'stat.health',
          name: { default: 'Health', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });
    const entitySystem = new EntitySystem([definition], { nextInt: () => 1 });
    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const handler = dispatcher.getHandler(
      RUNTIME_COMMAND_TYPES.CREATE_ENTITY_INSTANCE,
    );
    handler?.(
      { entityId: 'entity.scout' },
      {
        step: 5,
        timestamp: 1,
        priority: CommandPriority.PLAYER,
        events: createEventPublisher(),
      },
    );

    const state = entitySystem.getEntityState('entity.scout');
    expect(state?.count).toBe(1);
  });

  it('assigns entities to missions via commands', () => {
    const definition = createEntityDefinition('entity.runner', {
      trackInstances: true,
      stats: ([
        {
          id: 'stat.speed',
          name: { default: 'Speed', variants: {} },
          baseValue: literalOne,
        },
      ] as unknown as NormalizedEntity['stats']),
    });
    const entitySystem = new EntitySystem([definition], { nextInt: () => 1 });
    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const instance = entitySystem.createInstance('entity.runner', 1);
    const handler = dispatcher.getHandler(
      RUNTIME_COMMAND_TYPES.ASSIGN_ENTITY_TO_MISSION,
    );
    handler?.(
      {
        instanceId: instance.instanceId,
        missionId: 'mission.alpha',
        batchId: 'batch.1',
        returnStep: 4,
      },
      {
        step: 2,
        timestamp: 1,
        priority: CommandPriority.PLAYER,
        events: createEventPublisher(),
      },
    );

    expect(entitySystem.getEntityState('entity.runner')?.availableCount).toBe(0);
  });

  it('rejects assign entity payloads with invalid return step', () => {
    const definition = createEntityDefinition('entity.runner', {
      trackInstances: true,
    });
    const entitySystem = new EntitySystem([definition], { nextInt: () => 1 });
    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const instance = entitySystem.createInstance('entity.runner', 1);
    const handler = dispatcher.getHandler(
      RUNTIME_COMMAND_TYPES.ASSIGN_ENTITY_TO_MISSION,
    );
    const result = handler?.(
      {
        instanceId: instance.instanceId,
        missionId: 'mission.alpha',
        batchId: 'batch.1',
        returnStep: 1,
      },
      {
        step: 2,
        timestamp: 1,
        priority: CommandPriority.PLAYER,
        events: createEventPublisher(),
      },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INVALID_RETURN_STEP',
        message: 'Return step must be >= current step.',
      },
    });
  });

  it('rejects invalid entity experience payloads', () => {
    const definition = createEntityDefinition('entity.scout', {
      trackInstances: true,
    });
    const entitySystem = new EntitySystem([definition], { nextInt: () => 1 });
    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const instance = entitySystem.createInstance('entity.scout', 1);
    const handler = dispatcher.getHandler(
      RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE,
    );
    const result = handler?.(
      {
        instanceId: instance.instanceId,
        amount: 0,
      },
      {
        step: 2,
        timestamp: 1,
        priority: CommandPriority.PLAYER,
        events: createEventPublisher(),
      },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INVALID_EXPERIENCE_AMOUNT',
        message: 'Experience amount must be a positive number.',
      },
    });
  });
});
