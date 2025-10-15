import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type CollectResourcePayload,
  type PurchaseGeneratorPayload,
} from './command.js';
import type { CommandDispatcher, CommandHandler } from './command-dispatcher.js';
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

export interface ResourceCommandHandlerOptions {
  readonly dispatcher: CommandDispatcher;
  readonly resources: ResourceState;
  readonly generatorPurchases: GeneratorPurchaseEvaluator;
  /**
   * Identifier recorded alongside telemetry when automation attempts to
   * purchase generators. Defaults to "automation" when omitted.
   */
  readonly automationSystemId?: string;
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

    const successfulSpends: Array<{ index: number; amount: number }> = [];

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

function refund(
  resources: ResourceState,
  context: ResourceSpendAttemptContext,
  spends: Array<{ index: number; amount: number }>,
): void {
  if (spends.length === 0) {
    return;
  }

  for (let i = spends.length - 1; i >= 0; i -= 1) {
    const { index, amount } = spends[i]!;
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
