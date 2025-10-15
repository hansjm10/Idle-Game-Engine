import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  CommandPriority,
  type Command,
  RUNTIME_COMMAND_TYPES,
} from './command.js';
import { CommandDispatcher } from './command-dispatcher.js';
import {
  registerResourceCommandHandlers,
  type GeneratorResourceCost,
  type GeneratorPurchaseQuote,
  type GeneratorPurchaseEvaluator,
} from './resource-command-handlers.js';
import {
  createResourceState,
  type ResourceState,
} from './resource-state.js';
import {
  resetTelemetry,
  setTelemetry,
  type TelemetryFacade,
} from './telemetry.js';

class StubGeneratorPurchases implements GeneratorPurchaseEvaluator {
  public readonly definitions = new Map<
    string,
    { readonly costs: readonly GeneratorResourceCost[] }
  >();
  public readonly applied: Array<{ generatorId: string; count: number }> = [];
  public readonly quotes: Array<{ generatorId: string; count: number }> = [];

  getPurchaseQuote(
    generatorId: string,
    count: number,
  ): GeneratorPurchaseQuote | undefined {
    this.quotes.push({ generatorId, count });
    const definition = this.definitions.get(generatorId);
    if (!definition) {
      return undefined;
    }

    return {
      generatorId,
      costs: definition.costs.map((cost) => ({
        resourceId: cost.resourceId,
        amount: cost.amount * count,
      })),
    };
  }

  applyPurchase(generatorId: string, count: number): void {
    this.applied.push({ generatorId, count });
  }
}

function createCommand<TPayload>(
  overrides: Partial<Command<TPayload>> & { payload: TPayload },
): Command<TPayload> {
  return {
    type: overrides.type ?? 'UNSPECIFIED',
    priority: overrides.priority ?? CommandPriority.PLAYER,
    payload: overrides.payload,
    timestamp: overrides.timestamp ?? 0,
    step: overrides.step ?? 0,
  };
}

describe('resource command handlers', () => {
  let dispatcher: CommandDispatcher;
  let resources: ResourceState;
  let telemetryStub: TelemetryFacade;
  let purchases: StubGeneratorPurchases;

  beforeEach(() => {
    dispatcher = new CommandDispatcher();
    resources = createResourceState([
      { id: 'energy', startAmount: 0 },
      { id: 'crystal', startAmount: 0 },
    ]);
    purchases = new StubGeneratorPurchases();

    purchases.definitions.set('reactor', {
      costs: [{ resourceId: 'energy', amount: 10 }],
    });

    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordTick: vi.fn(),
    };

    setTelemetry(telemetryStub);
    registerResourceCommandHandlers({
      dispatcher,
      resources,
      generatorPurchases: purchases,
      automationSystemId: 'auto-buy',
    });
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  const execute = <TPayload>(
    command: Command<TPayload>,
  ): void => {
    dispatcher.execute(command as Command);
  };

  describe('COLLECT_RESOURCE', () => {
    it('adds resources through ResourceState and records clamp telemetry when capped', () => {
      const energyIndex = resources.requireIndex('energy');
      resources.setCapacity(energyIndex, 10);

      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          payload: { resourceId: 'energy', amount: 3 },
        }),
      );
      expect(resources.getAmount(energyIndex)).toBe(3);
      expect(telemetryStub.recordWarning).not.toHaveBeenCalled();

      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
          payload: { resourceId: 'energy', amount: 10 },
        }),
      );

      expect(resources.getAmount(energyIndex)).toBe(10);

      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'ResourceCollectClamped',
        expect.objectContaining({
          resourceId: 'energy',
          requested: 10,
          applied: 7, // Only 7 additional units fit (3 + 7 = 10 capacity)
        }),
      );
    });
  });

  describe('PURCHASE_GENERATOR', () => {
    it('spends resources using ResourceState and applies generator purchases', () => {
      const energyIndex = resources.requireIndex('energy');
      resources.addAmount(energyIndex, 50);

      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          payload: { generatorId: 'reactor', count: 2 },
        }),
      );

      expect(resources.getAmount(energyIndex)).toBe(30);
      expect(purchases.applied).toEqual([{ generatorId: 'reactor', count: 2 }]);
      expect(telemetryStub.recordWarning).not.toHaveBeenCalled();
    });

    it('records telemetry and avoids state changes when resources are insufficient', () => {
      const energyIndex = resources.requireIndex('energy');
      resources.addAmount(energyIndex, 5);

      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          priority: CommandPriority.AUTOMATION,
          payload: { generatorId: 'reactor', count: 1 },
        }),
      );

      expect(resources.getAmount(energyIndex)).toBe(5);
      expect(purchases.applied).toHaveLength(0);

      const warningEvents = telemetryStub.recordWarning.mock.calls.map(
        (call) => call[0],
      );
      expect(warningEvents).toContain('ResourceSpendFailed');
      expect(warningEvents).toContain('InsufficientResources');

      const spendFailed = telemetryStub.recordWarning.mock.calls.find(
        (call) => call[0] === 'ResourceSpendFailed',
      );
      expect(spendFailed?.[1]).toMatchObject({
        commandId: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
        systemId: 'auto-buy',
      });
    });

    it('refunds previously spent resources when later costs fail', () => {
      purchases.definitions.set('hybrid', {
        costs: [
          { resourceId: 'energy', amount: 4 },
          { resourceId: 'crystal', amount: 6 },
        ],
      });

      const energyIndex = resources.requireIndex('energy');
      const crystalIndex = resources.requireIndex('crystal');

      resources.addAmount(energyIndex, 10);
      resources.addAmount(crystalIndex, 4);

      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          payload: { generatorId: 'hybrid', count: 1 },
        }),
      );

      expect(resources.getAmount(energyIndex)).toBe(10);
      expect(resources.getAmount(crystalIndex)).toBe(4);
      expect(purchases.applied).toHaveLength(0);

      const insufficient = telemetryStub.recordWarning.mock.calls.find(
        (call) => call[0] === 'InsufficientResources',
      );
      expect(insufficient?.[1]).toMatchObject({
        generatorId: 'hybrid',
        resourceId: 'crystal',
      });
    });

    it('records an error when the generator definition is unknown', () => {
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          payload: { generatorId: 'unknown', count: 1 },
        }),
      );

      expect(telemetryStub.recordError).toHaveBeenCalledWith(
        'GeneratorPurchaseUnknown',
        expect.objectContaining({ generatorId: 'unknown' }),
      );
    });

    it('records an error for invalid purchase counts', () => {
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
          payload: { generatorId: 'reactor', count: 0 },
        }),
      );

      expect(telemetryStub.recordError).toHaveBeenCalledWith(
        'GeneratorPurchaseInvalidCount',
        expect.objectContaining({ count: 0 }),
      );
      expect(purchases.applied).toHaveLength(0);
    });
  });
});
