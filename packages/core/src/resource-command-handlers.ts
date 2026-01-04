import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type CollectResourcePayload,
  type PrestigeResetPayload,
  type PurchaseGeneratorPayload,
  type PurchaseUpgradePayload,
  type ToggleGeneratorPayload,
} from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
import type { EventPublisher } from './events/event-bus.js';
import type { PrestigeSystemEvaluator } from './progression.js';
import type { ResourceState, ResourceSpendAttemptContext } from './resource-state.js';
import { telemetry } from './telemetry.js';
import {
  validateBoolean,
  validateNonEmptyString,
} from './command-validation.js';

export interface GeneratorResourceCost {
  readonly resourceId: string;
  readonly amount: number;
}

export interface GeneratorPurchaseQuote {
  readonly generatorId: string;
  readonly costs: readonly GeneratorResourceCost[];
}

export interface GeneratorPurchaseEvaluator {
  getPurchaseQuote(
    generatorId: string,
    count: number,
  ): GeneratorPurchaseQuote | undefined;
  applyPurchase(generatorId: string, count: number): void;
}

export interface GeneratorToggleEvaluator {
  setGeneratorEnabled(generatorId: string, enabled: boolean): boolean;
}

export type UpgradeStatus = 'locked' | 'available' | 'purchased';

export interface UpgradeResourceCost {
  readonly resourceId: string;
  readonly amount: number;
}

export interface UpgradePurchaseQuote {
  readonly upgradeId: string;
  readonly status: UpgradeStatus;
  readonly costs: readonly UpgradeResourceCost[];
}

export interface UpgradePurchaseApplicationOptions {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly events?: EventPublisher;
  readonly issuedAt?: number;
}

export interface UpgradePurchaseEvaluator {
  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined;
  applyPurchase(
    upgradeId: string,
    options?: UpgradePurchaseApplicationOptions,
  ): void;
}

export interface ResourceCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly resources: ResourceState;
  readonly generatorPurchases: GeneratorPurchaseEvaluator;
  readonly generatorToggles?: GeneratorToggleEvaluator;
  /**
   * Identifier recorded alongside telemetry when automation attempts to
   * purchase generators. Defaults to "automation" when omitted.
   */
  readonly automationSystemId?: string;
  readonly upgradePurchases?: UpgradePurchaseEvaluator;
  /**
   * Optional prestige system evaluator. When provided, the PRESTIGE_RESET
   * command handler will be registered. The evaluator provides quote
   * calculation and prestige application.
   */
  readonly prestigeSystem?: PrestigeSystemEvaluator;
}

const DEFAULT_AUTOMATION_SYSTEM_ID = 'automation';

export function registerResourceCommandHandlers(
  options: ResourceCommandHandlerOptions,
): void {
  const { dispatcher, resources, generatorPurchases } = options;
  const automationSystemId =
    options.automationSystemId ?? DEFAULT_AUTOMATION_SYSTEM_ID;

  dispatcher.register<CollectResourcePayload>(
    RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
    createCollectResourceHandler(resources),
  );

  dispatcher.register<PurchaseGeneratorPayload>(
    RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
    createPurchaseGeneratorHandler(resources, generatorPurchases, {
      automationSystemId,
    }),
  );

  dispatcher.register<ToggleGeneratorPayload>(
    RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR,
    createToggleGeneratorHandler(options.generatorToggles),
  );

  if (options.upgradePurchases) {
    dispatcher.register<PurchaseUpgradePayload>(
      RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
      createPurchaseUpgradeHandler(resources, options.upgradePurchases, {
        automationSystemId,
      }),
    );
  }

  if (options.prestigeSystem) {
    dispatcher.register<PrestigeResetPayload>(
      RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      createPrestigeResetHandler(options.prestigeSystem),
    );
  }
}

function createCollectResourceHandler(resources: ResourceState): CommandHandler<CollectResourcePayload> {
  return (payload, context) => {
    const index = resources.requireIndex(payload.resourceId);
    const appliedDelta = resources.addAmount(index, payload.amount);

    if (appliedDelta === payload.amount) {
      return;
    }

    telemetry.recordWarning('ResourceCollectClamped', {
      command: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      resourceId: payload.resourceId,
      requested: payload.amount,
      applied: appliedDelta,
      step: context.step,
      priority: context.priority,
    });
  };
}

function createToggleGeneratorHandler(
  generatorToggles: GeneratorToggleEvaluator | undefined,
): CommandHandler<ToggleGeneratorPayload> {
  return (payload, context) => {
    const invalidGeneratorId = validateNonEmptyString(
      payload.generatorId,
      context,
      'ToggleGeneratorInvalidId',
      { generatorId: payload.generatorId },
      {
        code: 'INVALID_GENERATOR_ID',
        message: 'Generator id must be a non-empty string.',
      },
    );
    if (invalidGeneratorId) {
      return invalidGeneratorId;
    }

    const invalidEnabled = validateBoolean(
      payload.enabled,
      context,
      'ToggleGeneratorInvalidEnabled',
      {
        generatorId: payload.generatorId,
        enabled: payload.enabled,
      },
      {
        code: 'INVALID_TOGGLE_STATE',
        message: 'Generator enabled flag must be a boolean.',
      },
    );
    if (invalidEnabled) {
      return invalidEnabled;
    }

    if (!generatorToggles) {
      telemetry.recordError('ToggleGeneratorMissingEvaluator', {
        generatorId: payload.generatorId,
        enabled: payload.enabled,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'TOGGLE_GENERATOR_UNSUPPORTED',
          message: 'Generator toggling is not supported in this runtime.',
        },
      };
    }

    const updated = generatorToggles.setGeneratorEnabled(
      payload.generatorId,
      payload.enabled,
    );

    if (!updated) {
      telemetry.recordWarning('ToggleGeneratorNotFound', {
        generatorId: payload.generatorId,
        enabled: payload.enabled,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UNKNOWN_GENERATOR',
          message: 'Generator not found.',
          details: {
            generatorId: payload.generatorId,
          },
        },
      };
    }
  };
}

interface PurchaseHandlerOptions {
  readonly automationSystemId: string;
}

function createPurchaseGeneratorHandler(
  resources: ResourceState,
  generatorPurchases: GeneratorPurchaseEvaluator,
  options: PurchaseHandlerOptions,
): CommandHandler<PurchaseGeneratorPayload> {
  const { automationSystemId } = options;

  return (payload, context) => {
    if (!isPositiveInteger(payload.count)) {
      telemetry.recordError('GeneratorPurchaseInvalidCount', {
        generatorId: payload.generatorId,
        count: payload.count,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'INVALID_PURCHASE_COUNT',
          message: 'Purchase count must be a positive integer.',
          details: {
            generatorId: payload.generatorId,
            count: payload.count,
          },
        },
      };
    }

    const quote = generatorPurchases.getPurchaseQuote(
      payload.generatorId,
      payload.count,
    );

    if (!quote) {
      telemetry.recordError('GeneratorPurchaseUnknown', {
        generatorId: payload.generatorId,
        count: payload.count,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UNKNOWN_GENERATOR',
          message: 'Generator not found.',
          details: {
            generatorId: payload.generatorId,
            count: payload.count,
          },
        },
      };
    }

    if (!Array.isArray(quote.costs) || quote.costs.length === 0) {
      telemetry.recordError('GeneratorPurchaseInvalidQuote', {
        generatorId: payload.generatorId,
        count: payload.count,
        reason: 'costs-empty',
      });
      return {
        success: false,
        error: {
          code: 'INVALID_PURCHASE_QUOTE',
          message: 'Generator purchase quote is invalid.',
          details: {
            generatorId: payload.generatorId,
            count: payload.count,
            reason: 'costs-empty',
          },
        },
      };
    }

    const spendContext: ResourceSpendAttemptContext = {
      commandId: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
      systemId:
        context.priority === CommandPriority.AUTOMATION
          ? automationSystemId
          : undefined,
    };

    const successfulSpends: { index: number; amount: number }[] = [];

    for (const cost of quote.costs) {
      if (!isFiniteNonNegative(cost.amount)) {
        telemetry.recordError('GeneratorPurchaseInvalidQuote', {
          generatorId: payload.generatorId,
          count: payload.count,
          reason: 'cost-invalid',
          resourceId: cost.resourceId,
          amount: cost.amount,
        });
        refund(resources, spendContext, successfulSpends);
        return {
          success: false,
          error: {
            code: 'INVALID_PURCHASE_QUOTE',
            message: 'Generator purchase quote is invalid.',
            details: {
              generatorId: payload.generatorId,
              count: payload.count,
              reason: 'cost-invalid',
              resourceId: cost.resourceId,
              amount: cost.amount,
            },
          },
        };
      }

      let resourceIndex: number;
      try {
        resourceIndex = resources.requireIndex(cost.resourceId);
      } catch (error) {
        refund(resources, spendContext, successfulSpends);
        throw error;
      }

      if (cost.amount === 0) {
        continue;
      }

      const spendSucceeded = resources.spendAmount(
        resourceIndex,
        cost.amount,
        spendContext,
      );

      if (!spendSucceeded) {
        telemetry.recordWarning('InsufficientResources', {
          generatorId: payload.generatorId,
          resourceId: cost.resourceId,
          required: cost.amount,
          count: payload.count,
          step: context.step,
          priority: context.priority,
        });
        refund(resources, spendContext, successfulSpends);
        return {
          success: false,
          error: {
            code: 'INSUFFICIENT_RESOURCES',
            message: 'Insufficient resources.',
            details: {
              generatorId: payload.generatorId,
              resourceId: cost.resourceId,
              required: cost.amount,
              count: payload.count,
            },
          },
        };
      }

      successfulSpends.push({
        index: resourceIndex,
        amount: cost.amount,
      });
    }

    try {
      generatorPurchases.applyPurchase(payload.generatorId, payload.count);
    } catch (error) {
      telemetry.recordError('GeneratorPurchaseApplyFailed', {
        generatorId: payload.generatorId,
        count: payload.count,
        message: error instanceof Error ? error.message : String(error),
      });
      refund(resources, spendContext, successfulSpends);
      throw error;
    }
  };
}

function createPurchaseUpgradeHandler(
  resources: ResourceState,
  upgradePurchases: UpgradePurchaseEvaluator,
  options: PurchaseHandlerOptions,
): CommandHandler<PurchaseUpgradePayload> {
  const { automationSystemId } = options;

  return (payload, context) => {
    const invalidUpgradeId = validateNonEmptyString(
      payload.upgradeId,
      context,
      'UpgradePurchaseInvalidId',
      { upgradeId: payload.upgradeId },
      {
        code: 'INVALID_UPGRADE_ID',
        message: 'Upgrade id must be a non-empty string.',
      },
    );
    if (invalidUpgradeId) {
      return invalidUpgradeId;
    }

    const upgradeId = payload.upgradeId.trim();
    const quote = upgradePurchases.getPurchaseQuote(upgradeId);

    if (!quote) {
      telemetry.recordError('UpgradePurchaseUnknown', {
        upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UNKNOWN_UPGRADE',
          message: 'Upgrade not found.',
          details: {
            upgradeId,
          },
        },
      };
    }

    if (quote.status === 'purchased') {
      telemetry.recordWarning('UpgradePurchaseAlreadyOwned', {
        upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UPGRADE_ALREADY_OWNED',
          message: 'Upgrade already owned.',
          details: {
            upgradeId,
          },
        },
      };
    }

    if (quote.status === 'locked') {
      telemetry.recordWarning('UpgradePurchaseLocked', {
        upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UPGRADE_LOCKED',
          message: 'Upgrade is locked.',
          details: {
            upgradeId,
          },
        },
      };
    }

    if (!Array.isArray(quote.costs)) {
      telemetry.recordError('UpgradePurchaseInvalidQuote', {
        upgradeId,
        reason: 'costs-missing',
      });
      return {
        success: false,
        error: {
          code: 'INVALID_PURCHASE_QUOTE',
          message: 'Upgrade purchase quote is invalid.',
          details: {
            upgradeId,
            reason: 'costs-missing',
          },
        },
      };
    }

    const spendContext: ResourceSpendAttemptContext = {
      commandId: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
      systemId:
        context.priority === CommandPriority.AUTOMATION
          ? automationSystemId
          : undefined,
    };

    const successfulSpends: { index: number; amount: number }[] = [];

    for (const cost of quote.costs) {
      if (!isFiniteNonNegative(cost.amount)) {
        telemetry.recordError('UpgradePurchaseInvalidQuote', {
          upgradeId,
          reason: 'cost-invalid',
          resourceId: cost.resourceId,
          amount: cost.amount,
        });
        refund(resources, spendContext, successfulSpends);
        return {
          success: false,
          error: {
            code: 'INVALID_PURCHASE_QUOTE',
            message: 'Upgrade purchase quote is invalid.',
            details: {
              upgradeId,
              reason: 'cost-invalid',
              resourceId: cost.resourceId,
              amount: cost.amount,
            },
          },
        };
      }

      if (cost.amount === 0) {
        continue;
      }

      let resourceIndex: number;
      try {
        resourceIndex = resources.requireIndex(cost.resourceId);
      } catch (error) {
        refund(resources, spendContext, successfulSpends);
        throw error;
      }

      const spendSucceeded = resources.spendAmount(
        resourceIndex,
        cost.amount,
        spendContext,
      );

      if (!spendSucceeded) {
        telemetry.recordWarning('UpgradePurchaseDenied', {
          upgradeId,
          resourceId: cost.resourceId,
          required: cost.amount,
          step: context.step,
          priority: context.priority,
          reason: 'insufficient-resources',
        });
        refund(resources, spendContext, successfulSpends);
        return {
          success: false,
          error: {
            code: 'INSUFFICIENT_RESOURCES',
            message: 'Insufficient resources.',
            details: {
              upgradeId,
              resourceId: cost.resourceId,
              required: cost.amount,
            },
          },
        };
      }

      successfulSpends.push({
        index: resourceIndex,
        amount: cost.amount,
      });
    }

    try {
      upgradePurchases.applyPurchase(upgradeId, {
        metadata: payload.metadata,
        events: context.events,
        issuedAt: context.timestamp,
      });
    } catch (error) {
      telemetry.recordError('UpgradePurchaseApplyFailed', {
        upgradeId,
        message: error instanceof Error ? error.message : String(error),
      });
      refund(resources, spendContext, successfulSpends);
      throw error;
    }

    telemetry.recordProgress('UpgradePurchaseConfirmed', {
      upgradeId,
      step: context.step,
      priority: context.priority,
    });
  };
}

function createPrestigeResetHandler(
  prestigeSystem: PrestigeSystemEvaluator,
): CommandHandler<PrestigeResetPayload> {
  return (payload, context) => {
    const invalidLayerId = validateNonEmptyString(
      payload.layerId,
      context,
      'PrestigeResetInvalidLayer',
      { layerId: payload.layerId },
      {
        code: 'INVALID_PRESTIGE_LAYER',
        message: 'Prestige layer id must be a non-empty string.',
      },
    );
    if (invalidLayerId) {
      return invalidLayerId;
    }

    const layerId = payload.layerId.trim();
    const quote = prestigeSystem.getPrestigeQuote(layerId);

    if (!quote) {
      telemetry.recordError('PrestigeResetUnknown', {
        layerId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'UNKNOWN_PRESTIGE_LAYER',
          message: 'Prestige layer not found.',
          details: {
            layerId,
          },
        },
      };
    }

    if (quote.status === 'locked') {
      telemetry.recordWarning('PrestigeResetLocked', {
        layerId,
        step: context.step,
        priority: context.priority,
      });
      return {
        success: false,
        error: {
          code: 'PRESTIGE_LOCKED',
          message: 'Prestige layer is locked.',
          details: {
            layerId,
          },
        },
      };
    }

    try {
      prestigeSystem.applyPrestige(layerId, payload.confirmationToken);
    } catch (error) {
      telemetry.recordError('PrestigeResetApplyFailed', {
        layerId,
        message: error instanceof Error ? error.message : String(error),
        step: context.step,
        priority: context.priority,
      });
      throw error;
    }

    telemetry.recordProgress('PrestigeResetConfirmed', {
      layerId,
      step: context.step,
      priority: context.priority,
    });
  };
}

function refund(
  resources: ResourceState,
  context: ResourceSpendAttemptContext,
  spends: { index: number; amount: number }[],
): void {
  if (spends.length === 0) {
    return;
  }

  for (let i = spends.length - 1; i >= 0; i -= 1) {
    const { index, amount } = spends[i];
    const applied = resources.addAmount(index, amount);
    if (applied !== amount) {
      telemetry.recordError('GeneratorPurchaseRefundMismatch', {
        index,
        attempted: amount,
        applied,
        commandId: context.commandId,
      });
    }
  }
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
