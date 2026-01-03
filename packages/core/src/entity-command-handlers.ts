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
import type {
  CommandDispatcher,
  CommandHandler,
  CommandHandlerResult,
  ExecutionContext,
} from './command-dispatcher.js';
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
    const invalidId = validateNonEmptyString(
      payload.entityId,
      context,
      'AddEntityInvalidId',
      { entityId: payload.entityId },
      {
        code: 'INVALID_ENTITY_ID',
        message: 'Entity id must be a non-empty string.',
      },
    );
    if (invalidId) {
      return invalidId;
    }

    const invalidCount = validatePositiveInteger(
      payload.count,
      context,
      'AddEntityInvalidCount',
      {
        entityId: payload.entityId,
        count: payload.count,
      },
      {
        code: 'INVALID_ENTITY_COUNT',
        message: 'Entity count must be a positive integer.',
      },
    );
    if (invalidCount) {
      return invalidCount;
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
    const invalidId = validateNonEmptyString(
      payload.entityId,
      context,
      'RemoveEntityInvalidId',
      { entityId: payload.entityId },
      {
        code: 'INVALID_ENTITY_ID',
        message: 'Entity id must be a non-empty string.',
      },
    );
    if (invalidId) {
      return invalidId;
    }

    const invalidCount = validatePositiveInteger(
      payload.count,
      context,
      'RemoveEntityInvalidCount',
      {
        entityId: payload.entityId,
        count: payload.count,
      },
      {
        code: 'INVALID_ENTITY_COUNT',
        message: 'Entity count must be a positive integer.',
      },
    );
    if (invalidCount) {
      return invalidCount;
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
    const invalidId = validateNonEmptyString(
      payload.entityId,
      context,
      'CreateEntityInstanceInvalidId',
      { entityId: payload.entityId },
      {
        code: 'INVALID_ENTITY_ID',
        message: 'Entity id must be a non-empty string.',
      },
    );
    if (invalidId) {
      return invalidId;
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
    const invalidId = validateNonEmptyString(
      payload.instanceId,
      context,
      'DestroyEntityInstanceInvalidId',
      { instanceId: payload.instanceId },
      {
        code: 'INVALID_INSTANCE_ID',
        message: 'Entity instance id must be a non-empty string.',
      },
    );
    if (invalidId) {
      return invalidId;
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
    const invalidInstanceId = validateNonEmptyString(
      payload.instanceId,
      context,
      'AssignEntityInvalidInstanceId',
      { instanceId: payload.instanceId },
      {
        code: 'INVALID_INSTANCE_ID',
        message: 'Entity instance id must be a non-empty string.',
      },
    );
    if (invalidInstanceId) {
      return invalidInstanceId;
    }

    const invalidMissionId = validateNonEmptyString(
      payload.missionId,
      context,
      'AssignEntityInvalidMissionId',
      { missionId: payload.missionId },
      {
        code: 'INVALID_MISSION_ID',
        message: 'Mission id must be a non-empty string.',
      },
    );
    if (invalidMissionId) {
      return invalidMissionId;
    }

    const invalidBatchId = validateNonEmptyString(
      payload.batchId,
      context,
      'AssignEntityInvalidBatchId',
      { batchId: payload.batchId },
      {
        code: 'INVALID_BATCH_ID',
        message: 'Batch id must be a non-empty string.',
      },
    );
    if (invalidBatchId) {
      return invalidBatchId;
    }

    const invalidReturnStep = validateReturnStep(
      payload.returnStep,
      context,
      {
        code: 'INVALID_RETURN_STEP',
        message: 'Return step must be >= current step.',
      },
    );
    if (invalidReturnStep) {
      return invalidReturnStep;
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
    const invalidId = validateNonEmptyString(
      payload.instanceId,
      context,
      'ReturnEntityInvalidInstanceId',
      { instanceId: payload.instanceId },
      {
        code: 'INVALID_INSTANCE_ID',
        message: 'Entity instance id must be a non-empty string.',
      },
    );
    if (invalidId) {
      return invalidId;
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
    const invalidId = validateNonEmptyString(
      payload.instanceId,
      context,
      'AddEntityExperienceInvalidInstanceId',
      { instanceId: payload.instanceId },
      {
        code: 'INVALID_INSTANCE_ID',
        message: 'Entity instance id must be a non-empty string.',
      },
    );
    if (invalidId) {
      return invalidId;
    }

    const invalidAmount = validatePositiveNumber(
      payload.amount,
      context,
      'AddEntityExperienceInvalidAmount',
      {
        instanceId: payload.instanceId,
        amount: payload.amount,
      },
      {
        code: 'INVALID_EXPERIENCE_AMOUNT',
        message: 'Experience amount must be a positive number.',
      },
    );
    if (invalidAmount) {
      return invalidAmount;
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

type ValidationError = Readonly<{
  code: string;
  message: string;
}>;

const recordValidationError = (
  eventName: string,
  context: ExecutionContext,
  details: Record<string, unknown>,
): void => {
  telemetry.recordError(eventName, {
    ...details,
    step: context.step,
    priority: context.priority,
  });
};

const createValidationFailure = (
  error: ValidationError,
): CommandHandlerResult => ({
  success: false,
  error,
});

const validateField = (
  isValid: boolean,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined => {
  if (isValid) {
    return undefined;
  }

  recordValidationError(eventName, context, details);
  return createValidationFailure(error);
};

const validateNonEmptyString = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    typeof value === 'string' && value.trim().length > 0,
    context,
    eventName,
    details,
    error,
  );

const validatePositiveInteger = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    Number.isInteger(value) && (value as number) > 0,
    context,
    eventName,
    details,
    error,
  );

const validatePositiveNumber = (
  value: unknown,
  context: ExecutionContext,
  eventName: string,
  details: Record<string, unknown>,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    typeof value === 'number' && Number.isFinite(value) && value > 0,
    context,
    eventName,
    details,
    error,
  );

const validateReturnStep = (
  value: number,
  context: ExecutionContext,
  error: ValidationError,
): CommandHandlerResult | undefined =>
  validateField(
    Number.isFinite(value) && value >= context.step,
    context,
    'AssignEntityInvalidReturnStep',
    { returnStep: value },
    error,
  );
