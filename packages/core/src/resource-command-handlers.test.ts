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
  type UpgradePurchaseEvaluator,
  type UpgradePurchaseQuote,
} from './resource-command-handlers.js';
import type {
  PrestigeSystemEvaluator,
  PrestigeQuote,
} from './progression.js';
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

class StubUpgradePurchases implements UpgradePurchaseEvaluator {
  public readonly definitions = new Map<
    string,
    { readonly status: 'locked' | 'available' | 'purchased'; readonly costs: readonly { resourceId: string; amount: number }[] }
  >();

  public readonly applied: Array<{
    readonly upgradeId: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }> = [];

  public readonly quotes: Array<{ upgradeId: string }> = [];

  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
    this.quotes.push({ upgradeId });
    const definition = this.definitions.get(upgradeId);
    if (!definition) {
      return undefined;
    }
    return {
      upgradeId,
      status: definition.status,
      costs: definition.costs.map((cost) => ({
        resourceId: cost.resourceId,
        amount: cost.amount,
      })),
    };
  }

  applyPurchase(
    upgradeId: string,
    options?: { metadata?: Readonly<Record<string, unknown>> },
  ): void {
    this.applied.push({
      upgradeId,
      metadata: options?.metadata,
    });
  }
}

class StubPrestigeSystem implements PrestigeSystemEvaluator {
  public readonly definitions = new Map<
    string,
    { readonly status: 'locked' | 'available' | 'completed'; readonly reward: PrestigeQuote['reward'] }
  >();

  public readonly applied: Array<{
    readonly layerId: string;
    readonly confirmationToken?: string;
  }> = [];

  public readonly quotes: Array<{ layerId: string }> = [];

  public applyThrows: Error | null = null;

  getPrestigeQuote(layerId: string): PrestigeQuote | undefined {
    this.quotes.push({ layerId });
    const definition = this.definitions.get(layerId);
    if (!definition) {
      return undefined;
    }
    return {
      layerId,
      status: definition.status,
      reward: definition.reward,
      resetTargets: ['energy', 'crystal'],
      retainedTargets: ['prestige-flux'],
    };
  }

  applyPrestige(layerId: string, confirmationToken?: string): void {
    if (this.applyThrows) {
      throw this.applyThrows;
    }
    this.applied.push({ layerId, confirmationToken });
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
  let upgrades: StubUpgradePurchases;

  beforeEach(() => {
    dispatcher = new CommandDispatcher();
    resources = createResourceState([
      { id: 'energy', startAmount: 0 },
      { id: 'crystal', startAmount: 0 },
    ]);
    purchases = new StubGeneratorPurchases();
    upgrades = new StubUpgradePurchases();

    purchases.definitions.set('reactor', {
      costs: [{ resourceId: 'energy', amount: 10 }],
    });

    upgrades.definitions.set('reactor-insulation', {
      status: 'available',
      costs: [{ resourceId: 'energy', amount: 15 }],
    });

    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };

    setTelemetry(telemetryStub);
    registerResourceCommandHandlers({
      dispatcher,
      resources,
      generatorPurchases: purchases,
      automationSystemId: 'auto-buy',
      upgradePurchases: upgrades,
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

      const warningEvents = vi
        .mocked(telemetryStub.recordWarning)
        .mock.calls.map((call: [string, unknown?]) => call[0]);
      expect(warningEvents).toContain('ResourceSpendFailed');
      expect(warningEvents).toContain('InsufficientResources');

      const spendFailed = vi
        .mocked(telemetryStub.recordWarning)
        .mock.calls.find((call: [string, unknown?]) => call[0] === 'ResourceSpendFailed');
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

      const insufficient = vi
        .mocked(telemetryStub.recordWarning)
        .mock.calls.find((call: [string, unknown?]) => call[0] === 'InsufficientResources');
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

  describe('PURCHASE_UPGRADE', () => {
    it('spends resources and applies upgrade purchase with metadata', () => {
      const energyIndex = resources.requireIndex('energy');
      resources.addAmount(energyIndex, 50);

      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          payload: {
            upgradeId: 'reactor-insulation',
            metadata: { source: 'test' },
          },
        }),
      );

      expect(resources.getAmount(energyIndex)).toBe(35);
      expect(upgrades.applied).toEqual([
        {
          upgradeId: 'reactor-insulation',
          metadata: { source: 'test' },
        },
      ]);
      expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
        'UpgradePurchaseConfirmed',
        expect.objectContaining({
          upgradeId: 'reactor-insulation',
        }),
      );
    });

    it('records telemetry and refunds when resources are insufficient', () => {
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          payload: { upgradeId: 'reactor-insulation' },
        }),
      );

      expect(upgrades.applied).toHaveLength(0);
      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'UpgradePurchaseDenied',
        expect.objectContaining({
          upgradeId: 'reactor-insulation',
          reason: 'insufficient-resources',
        }),
      );
    });

    it('rejects locked upgrades without spending resources', () => {
      upgrades.definitions.set('reactor-insulation', {
        status: 'locked',
        costs: [{ resourceId: 'energy', amount: 1 }],
      });
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          payload: { upgradeId: 'reactor-insulation' },
        }),
      );

      expect(upgrades.applied).toHaveLength(0);
      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'UpgradePurchaseLocked',
        expect.objectContaining({
          upgradeId: 'reactor-insulation',
        }),
      );
    });

    it('rejects already purchased upgrades without side effects', () => {
      upgrades.definitions.set('reactor-insulation', {
        status: 'purchased',
        costs: [],
      });
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          payload: { upgradeId: 'reactor-insulation' },
        }),
      );

      expect(upgrades.applied).toHaveLength(0);
      expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
        'UpgradePurchaseAlreadyOwned',
        expect.objectContaining({
          upgradeId: 'reactor-insulation',
        }),
      );
    });

    it('records errors for invalid quotes', () => {
      upgrades.definitions.set('reactor-insulation', {
        status: 'available',
        costs: [{ resourceId: 'energy', amount: Number.NaN }],
      });

      expect(() =>
        execute(
          createCommand({
            type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
            payload: { upgradeId: 'reactor-insulation' },
          }),
        ),
      ).not.toThrow();

      expect(telemetryStub.recordError).toHaveBeenCalledWith(
        'UpgradePurchaseInvalidQuote',
        expect.objectContaining({
          upgradeId: 'reactor-insulation',
          reason: 'cost-invalid',
        }),
      );
    });

    it('records errors when upgrade definitions are missing', () => {
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          payload: { upgradeId: 'missing-upgrade' },
        }),
      );

      expect(telemetryStub.recordError).toHaveBeenCalledWith(
        'UpgradePurchaseUnknown',
        expect.objectContaining({
          upgradeId: 'missing-upgrade',
        }),
      );
    });

    it('records errors for invalid upgrade identifiers', () => {
      execute(
        createCommand({
          type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
          payload: { upgradeId: '  ' },
        }),
      );

      expect(telemetryStub.recordError).toHaveBeenCalledWith(
        'UpgradePurchaseInvalidId',
        expect.objectContaining({
          upgradeId: '  ',
        }),
      );
    });
  });
});

describe('PRESTIGE_RESET handler', () => {
  let dispatcher: CommandDispatcher;
  let resources: ResourceState;
  let telemetryStub: TelemetryFacade;
  let purchases: StubGeneratorPurchases;
  let prestigeSystem: StubPrestigeSystem;

  beforeEach(() => {
    dispatcher = new CommandDispatcher();
    resources = createResourceState([
      { id: 'energy', startAmount: 100 },
      { id: 'crystal', startAmount: 50 },
      { id: 'prestige-flux', startAmount: 0 },
    ]);
    purchases = new StubGeneratorPurchases();
    prestigeSystem = new StubPrestigeSystem();

    prestigeSystem.definitions.set('ascension-alpha', {
      status: 'available',
      reward: { resourceId: 'prestige-flux', amount: 10 },
    });

    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };

    setTelemetry(telemetryStub);
    registerResourceCommandHandlers({
      dispatcher,
      resources,
      generatorPurchases: purchases,
      prestigeSystem,
    });
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  const execute = <TPayload>(command: Command<TPayload>): void => {
    dispatcher.execute(command as Command);
  };

  it('rejects invalid layer with PrestigeResetInvalidLayer telemetry', () => {
    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: '' },
      }),
    );

    expect(prestigeSystem.applied).toHaveLength(0);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'PrestigeResetInvalidLayer',
      expect.objectContaining({
        layerId: '',
      }),
    );
  });

  it('rejects whitespace-only layer with PrestigeResetInvalidLayer telemetry', () => {
    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: '   ' },
      }),
    );

    expect(prestigeSystem.applied).toHaveLength(0);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'PrestigeResetInvalidLayer',
      expect.objectContaining({
        layerId: '   ',
      }),
    );
  });

  it('rejects unknown layer with PrestigeResetUnknown telemetry', () => {
    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: 'nonexistent-layer' },
      }),
    );

    expect(prestigeSystem.applied).toHaveLength(0);
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'PrestigeResetUnknown',
      expect.objectContaining({
        layerId: 'nonexistent-layer',
      }),
    );
  });

  it('rejects locked layer with PrestigeResetLocked warning', () => {
    prestigeSystem.definitions.set('ascension-alpha', {
      status: 'locked',
      reward: { resourceId: 'prestige-flux', amount: 10 },
    });

    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: 'ascension-alpha' },
      }),
    );

    expect(prestigeSystem.applied).toHaveLength(0);
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetLocked',
      expect.objectContaining({
        layerId: 'ascension-alpha',
      }),
    );
  });

  it('executes prestige and emits PrestigeResetConfirmed on success', () => {
    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: 'ascension-alpha' },
      }),
    );

    expect(prestigeSystem.applied).toEqual([
      { layerId: 'ascension-alpha', confirmationToken: undefined },
    ]);
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetConfirmed',
      expect.objectContaining({
        layerId: 'ascension-alpha',
      }),
    );
  });

  it('executes prestige for completed layers (repeatable prestige)', () => {
    prestigeSystem.definitions.set('ascension-alpha', {
      status: 'completed',
      reward: { resourceId: 'prestige-flux', amount: 15 },
    });

    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: 'ascension-alpha' },
      }),
    );

    expect(prestigeSystem.applied).toEqual([
      { layerId: 'ascension-alpha', confirmationToken: undefined },
    ]);
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetConfirmed',
      expect.objectContaining({
        layerId: 'ascension-alpha',
      }),
    );
  });

  it('emits PrestigeResetApplyFailed on evaluator error', () => {
    const applyError = new Error('Evaluator failure');
    prestigeSystem.applyThrows = applyError;

    // The handler throws but the dispatcher catches it, so no error propagates
    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: 'ascension-alpha' },
      }),
    );

    // Handler records specific error before rethrowing
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'PrestigeResetApplyFailed',
      expect.objectContaining({
        layerId: 'ascension-alpha',
        message: 'Evaluator failure',
      }),
    );

    // Dispatcher also catches and records the error
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'CommandExecutionFailed',
      expect.objectContaining({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        error: 'Evaluator failure',
      }),
    );
  });

  it('passes confirmationToken through to applyPrestige', () => {
    execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: {
          layerId: 'ascension-alpha',
          confirmationToken: 'test-token-12345',
        },
      }),
    );

    expect(prestigeSystem.applied).toEqual([
      { layerId: 'ascension-alpha', confirmationToken: 'test-token-12345' },
    ]);
  });

  it('does not register handler when prestigeSystem is not provided', () => {
    const dispatcherWithoutPrestige = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher: dispatcherWithoutPrestige,
      resources,
      generatorPurchases: purchases,
      // No prestigeSystem
    });

    dispatcherWithoutPrestige.execute(
      createCommand({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
        payload: { layerId: 'ascension-alpha' },
      }),
    );

    // CommandDispatcher records error for unknown command types
    expect(telemetryStub.recordError).toHaveBeenCalledWith(
      'UnknownCommandType',
      expect.objectContaining({
        type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      }),
    );
  });
});
