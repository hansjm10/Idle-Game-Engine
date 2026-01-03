import {
  RUNTIME_COMMAND_TYPES,
  type AddEntityPayload,
  type RemoveEntityPayload,
  type CreateEntityInstancePayload,
  type DestroyEntityInstancePayload,
  type AssignEntityToMissionPayload,
  type ReturnEntityFromMissionPayload,
  type AddEntityExperiencePayload,
} from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
import type { EntityAssignment, EntitySystem } from './entity-system.js';
import { telemetry } from './telemetry.js';

export interface EntityCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly entitySystem: EntitySystem;
}

export function registerEntityCommandHandlers(
  options: EntityCommandHandlerOptions,
): void {
  const { dispatcher, entitySystem } = options;

  dispatcher.register<AddEntityPayload>(
    RUNTIME_COMMAND_TYPES.ADD_ENTITY,
    createAddEntityHandler(entitySystem),
  );

  dispatcher.register<RemoveEntityPayload>(
    RUNTIME_COMMAND_TYPES.REMOVE_ENTITY,
    createRemoveEntityHandler(entitySystem),
  );

  dispatcher.register<CreateEntityInstancePayload>(
    RUNTIME_COMMAND_TYPES.CREATE_ENTITY_INSTANCE,
    createCreateEntityInstanceHandler(entitySystem),
  );

  dispatcher.register<DestroyEntityInstancePayload>(
    RUNTIME_COMMAND_TYPES.DESTROY_ENTITY_INSTANCE,
    createDestroyEntityInstanceHandler(entitySystem),
  );

  dispatcher.register<AssignEntityToMissionPayload>(
    RUNTIME_COMMAND_TYPES.ASSIGN_ENTITY_TO_MISSION,
    createAssignEntityToMissionHandler(entitySystem),
  );

  dispatcher.register<ReturnEntityFromMissionPayload>(
    RUNTIME_COMMAND_TYPES.RETURN_ENTITY_FROM_MISSION,
    createReturnEntityFromMissionHandler(entitySystem),
  );

  dispatcher.register<AddEntityExperiencePayload>(
    RUNTIME_COMMAND_TYPES.ADD_ENTITY_EXPERIENCE,
    createAddEntityExperienceHandler(entitySystem),
  );
}

const createAddEntityHandler = (
  entitySystem: EntitySystem,
): CommandHandler<AddEntityPayload> =>
  (payload, context) => {
    if (typeof payload.entityId !== 'string' || payload.entityId.trim().length === 0) {
      telemetry.recordError('AddEntityInvalidId', {
        entityId: payload.entityId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_ENTITY_ID',
          message: 'Entity id must be a non-empty string.',
        },
      };
    }

    if (!Number.isInteger(payload.count) || payload.count <= 0) {
      telemetry.recordError('AddEntityInvalidCount', {
        entityId: payload.entityId,
        count: payload.count,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_ENTITY_COUNT',
          message: 'Entity count must be a positive integer.',
        },
      };
    }

    try {
      entitySystem.addEntity(payload.entityId, payload.count, context.step);
    } catch (error) {
      telemetry.recordWarning('AddEntityFailed', {
        entityId: payload.entityId,
        count: payload.count,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'ADD_ENTITY_FAILED',
          message: 'Unable to add entities.',
        },
      };
    }
  };

const createRemoveEntityHandler = (
  entitySystem: EntitySystem,
): CommandHandler<RemoveEntityPayload> =>
  (payload, context) => {
    if (typeof payload.entityId !== 'string' || payload.entityId.trim().length === 0) {
      telemetry.recordError('RemoveEntityInvalidId', {
        entityId: payload.entityId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_ENTITY_ID',
          message: 'Entity id must be a non-empty string.',
        },
      };
    }

    if (!Number.isInteger(payload.count) || payload.count <= 0) {
      telemetry.recordError('RemoveEntityInvalidCount', {
        entityId: payload.entityId,
        count: payload.count,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_ENTITY_COUNT',
          message: 'Entity count must be a positive integer.',
        },
      };
    }

    try {
      entitySystem.removeEntity(payload.entityId, payload.count);
    } catch (error) {
      telemetry.recordWarning('RemoveEntityFailed', {
        entityId: payload.entityId,
        count: payload.count,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'REMOVE_ENTITY_FAILED',
          message: 'Unable to remove entities.',
        },
      };
    }
  };

const createCreateEntityInstanceHandler = (
  entitySystem: EntitySystem,
): CommandHandler<CreateEntityInstancePayload> =>
  (payload, context) => {
    if (typeof payload.entityId !== 'string' || payload.entityId.trim().length === 0) {
      telemetry.recordError('CreateEntityInstanceInvalidId', {
        entityId: payload.entityId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_ENTITY_ID',
          message: 'Entity id must be a non-empty string.',
        },
      };
    }

    try {
      entitySystem.createInstance(payload.entityId, context.step);
    } catch (error) {
      telemetry.recordWarning('CreateEntityInstanceFailed', {
        entityId: payload.entityId,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'CREATE_ENTITY_INSTANCE_FAILED',
          message: 'Unable to create entity instance.',
        },
      };
    }
  };

const createDestroyEntityInstanceHandler = (
  entitySystem: EntitySystem,
): CommandHandler<DestroyEntityInstancePayload> =>
  (payload, context) => {
    if (typeof payload.instanceId !== 'string' || payload.instanceId.trim().length === 0) {
      telemetry.recordError('DestroyEntityInstanceInvalidId', {
        instanceId: payload.instanceId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_INSTANCE_ID',
          message: 'Entity instance id must be a non-empty string.',
        },
      };
    }

    try {
      entitySystem.destroyInstance(payload.instanceId);
    } catch (error) {
      telemetry.recordWarning('DestroyEntityInstanceFailed', {
        instanceId: payload.instanceId,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'DESTROY_ENTITY_INSTANCE_FAILED',
          message: 'Unable to destroy entity instance.',
        },
      };
    }
  };

const createAssignEntityToMissionHandler = (
  entitySystem: EntitySystem,
): CommandHandler<AssignEntityToMissionPayload> =>
  (payload, context) => {
    if (typeof payload.instanceId !== 'string' || payload.instanceId.trim().length === 0) {
      telemetry.recordError('AssignEntityInvalidInstanceId', {
        instanceId: payload.instanceId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_INSTANCE_ID',
          message: 'Entity instance id must be a non-empty string.',
        },
      };
    }

    if (typeof payload.missionId !== 'string' || payload.missionId.trim().length === 0) {
      telemetry.recordError('AssignEntityInvalidMissionId', {
        missionId: payload.missionId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_MISSION_ID',
          message: 'Mission id must be a non-empty string.',
        },
      };
    }

    if (typeof payload.batchId !== 'string' || payload.batchId.trim().length === 0) {
      telemetry.recordError('AssignEntityInvalidBatchId', {
        batchId: payload.batchId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_BATCH_ID',
          message: 'Batch id must be a non-empty string.',
        },
      };
    }

    if (!Number.isFinite(payload.returnStep) || payload.returnStep < context.step) {
      telemetry.recordError('AssignEntityInvalidReturnStep', {
        returnStep: payload.returnStep,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_RETURN_STEP',
          message: 'Return step must be >= current step.',
        },
      };
    }

    const assignment: EntityAssignment = {
      missionId: payload.missionId,
      batchId: payload.batchId,
      deployedAtStep: context.step,
      returnStep: Math.floor(payload.returnStep),
    };

    try {
      entitySystem.assignToMission(payload.instanceId, assignment);
    } catch (error) {
      telemetry.recordWarning('AssignEntityFailed', {
        instanceId: payload.instanceId,
        missionId: payload.missionId,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'ASSIGN_ENTITY_FAILED',
          message: 'Unable to assign entity instance to mission.',
        },
      };
    }
  };

const createReturnEntityFromMissionHandler = (
  entitySystem: EntitySystem,
): CommandHandler<ReturnEntityFromMissionPayload> =>
  (payload, context) => {
    if (typeof payload.instanceId !== 'string' || payload.instanceId.trim().length === 0) {
      telemetry.recordError('ReturnEntityInvalidInstanceId', {
        instanceId: payload.instanceId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_INSTANCE_ID',
          message: 'Entity instance id must be a non-empty string.',
        },
      };
    }

    try {
      entitySystem.returnFromMission(payload.instanceId);
    } catch (error) {
      telemetry.recordWarning('ReturnEntityFailed', {
        instanceId: payload.instanceId,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'RETURN_ENTITY_FAILED',
          message: 'Unable to return entity instance from mission.',
        },
      };
    }
  };

const createAddEntityExperienceHandler = (
  entitySystem: EntitySystem,
): CommandHandler<AddEntityExperiencePayload> =>
  (payload, context) => {
    if (typeof payload.instanceId !== 'string' || payload.instanceId.trim().length === 0) {
      telemetry.recordError('AddEntityExperienceInvalidInstanceId', {
        instanceId: payload.instanceId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_INSTANCE_ID',
          message: 'Entity instance id must be a non-empty string.',
        },
      };
    }

    if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      telemetry.recordError('AddEntityExperienceInvalidAmount', {
        instanceId: payload.instanceId,
        amount: payload.amount,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_EXPERIENCE_AMOUNT',
          message: 'Experience amount must be a positive number.',
        },
      };
    }

    try {
      entitySystem.addExperience(payload.instanceId, payload.amount, context.step);
    } catch (error) {
      telemetry.recordWarning('AddEntityExperienceFailed', {
        instanceId: payload.instanceId,
        amount: payload.amount,
        step: context.step,
        priority: context.priority,
        error: String(error),
      });
      return {
        success: false,
        error: {
          code: 'ADD_ENTITY_EXPERIENCE_FAILED',
          message: 'Unable to add entity experience.',
        },
      };
    }
  };
