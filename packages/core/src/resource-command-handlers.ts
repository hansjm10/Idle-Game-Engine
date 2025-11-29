import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type CollectResourcePayload,
  type PrestigeResetPayload,
  type PurchaseGeneratorPayload,
  type PurchaseUpgradePayload,
} from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
import type { PrestigeSystemEvaluator } from './progression.js';
import type { ResourceState, ResourceSpendAttemptContext } from './resource-state.js';
import { telemetry } from './telemetry.js';

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

export interface UpgradePurchaseEvaluator {
  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined;
  applyPurchase(
    upgradeId: string,
    options?: { metadata?: Readonly<Record<string, unknown>> },
  ): void;
}

export interface ResourceCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly resources: ResourceState;
  readonly generatorPurchases: GeneratorPurchaseEvaluator;
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
      return;
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
      return;
    }

    if (!Array.isArray(quote.costs) || quote.costs.length === 0) {
      telemetry.recordError('GeneratorPurchaseInvalidQuote', {
        generatorId: payload.generatorId,
        count: payload.count,
        reason: 'costs-empty',
      });
      return;
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
        return;
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
        return;
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
    if (
      typeof payload.upgradeId !== 'string' ||
      payload.upgradeId.trim().length === 0
    ) {
      telemetry.recordError('UpgradePurchaseInvalidId', {
        upgradeId: payload.upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    const upgradeId = payload.upgradeId.trim();
    const quote = upgradePurchases.getPurchaseQuote(upgradeId);

    if (!quote) {
      telemetry.recordError('UpgradePurchaseUnknown', {
        upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    if (quote.status === 'purchased') {
      telemetry.recordWarning('UpgradePurchaseAlreadyOwned', {
        upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    if (quote.status === 'locked') {
      telemetry.recordWarning('UpgradePurchaseLocked', {
        upgradeId,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    if (!Array.isArray(quote.costs)) {
      telemetry.recordError('UpgradePurchaseInvalidQuote', {
        upgradeId,
        reason: 'costs-missing',
      });
      return;
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
        return;
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
        return;
      }

      successfulSpends.push({
        index: resourceIndex,
        amount: cost.amount,
      });
    }

    try {
      upgradePurchases.applyPurchase(upgradeId, {
        metadata: payload.metadata,
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
    if (
      typeof payload.layerId !== 'string' ||
      payload.layerId.trim().length === 0
    ) {
      telemetry.recordError('PrestigeResetInvalidLayer', {
        layerId: payload.layerId,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    const layerId = payload.layerId.trim();
    const quote = prestigeSystem.getPrestigeQuote(layerId);

    if (!quote) {
      telemetry.recordError('PrestigeResetUnknown', {
        layerId,
        step: context.step,
        priority: context.priority,
      });
      return;
    }

    if (quote.status === 'locked') {
      telemetry.recordWarning('PrestigeResetLocked', {
        layerId,
        step: context.step,
        priority: context.priority,
      });
      return;
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
