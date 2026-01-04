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

  it('rejects non-integer entity counts', () => {
    const definition = createEntityDefinition('entity.worker', {
      trackInstances: false,
    });
    const entitySystem = new EntitySystem([definition], { nextInt: () => 1 });
    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const handler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.ADD_ENTITY);
    const result = handler?.(
      { entityId: 'entity.worker', count: 1.5 },
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
        code: 'INVALID_ENTITY_COUNT',
        message: 'Entity count must be a positive integer.',
      },
    });
  });

  it('rejects assign payloads with invalid mission or batch ids', () => {
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

    const invalidMission = handler?.(
      {
        instanceId: instance.instanceId,
        missionId: ' ',
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

    expect(invalidMission).toEqual({
      success: false,
      error: {
        code: 'INVALID_MISSION_ID',
        message: 'Mission id must be a non-empty string.',
      },
    });

    const invalidBatch = handler?.(
      {
        instanceId: instance.instanceId,
        missionId: 'mission.alpha',
        batchId: '',
        returnStep: 4,
      },
      {
        step: 2,
        timestamp: 1,
        priority: CommandPriority.PLAYER,
        events: createEventPublisher(),
      },
    );

    expect(invalidBatch).toEqual({
      success: false,
      error: {
        code: 'INVALID_BATCH_ID',
        message: 'Batch id must be a non-empty string.',
      },
    });
  });

  it('returns failures when entity system operations throw', () => {
    const entitySystem = {
      addEntity: () => {
        throw new Error('boom');
      },
      removeEntity: () => {
        throw new Error('boom');
      },
      createInstance: () => {
        throw new Error('boom');
      },
      destroyInstance: () => {
        throw new Error('boom');
      },
      assignToMission: () => {
        throw new Error('boom');
      },
      returnFromMission: () => {
        throw new Error('boom');
      },
      addExperience: () => {
        throw new Error('boom');
      },
    } as unknown as EntitySystem;

    const dispatcher = new CommandDispatcher();
    registerEntityCommandHandlers({ dispatcher, entitySystem });

    const context = {
      step: 2,
      timestamp: 1,
      priority: CommandPriority.PLAYER,
      events: createEventPublisher(),
    };

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.ADD_ENTITY)?.(
        { entityId: 'entity.worker', count: 1 },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'ADD_ENTITY_FAILED',
        message: 'Unable to add entities.',
      },
    });

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.REMOVE_ENTITY)?.(
        { entityId: 'entity.worker', count: 1 },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'REMOVE_ENTITY_FAILED',
        message: 'Unable to remove entities.',
      },
    });

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.CREATE_ENTITY_INSTANCE)?.(
        { entityId: 'entity.worker' },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'CREATE_ENTITY_INSTANCE_FAILED',
        message: 'Unable to create entity instance.',
      },
    });

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.DESTROY_ENTITY_INSTANCE)?.(
        { instanceId: 'entity.worker_2_000001' },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'DESTROY_ENTITY_INSTANCE_FAILED',
        message: 'Unable to destroy entity instance.',
      },
    });

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.ASSIGN_ENTITY_TO_MISSION)?.(
        {
          instanceId: 'entity.worker_2_000001',
          missionId: 'mission.alpha',
          batchId: 'batch.1',
          returnStep: 3,
        },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'ASSIGN_ENTITY_FAILED',
        message: 'Unable to assign entity instance to mission.',
      },
    });

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.RETURN_ENTITY_FROM_MISSION)?.(
        { instanceId: 'entity.worker_2_000001' },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'RETURN_ENTITY_FAILED',
        message: 'Unable to return entity instance from mission.',
      },
    });

    expect(
      dispatcher.getHandler(RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE)?.(
        { instanceId: 'entity.worker_2_000001', amount: 5 },
        context,
      ),
    ).toEqual({
      success: false,
      error: {
        code: 'ADD_ENTITY_EXPERIENCE_FAILED',
        message: 'Unable to add entity experience.',
      },
    });
  });
});
