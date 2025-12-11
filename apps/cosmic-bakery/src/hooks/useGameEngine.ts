import { useState, useEffect, useRef, useCallback } from 'react';
import {
  IdleEngineRuntime,
  buildProgressionSnapshot,
  createProgressionCoordinator,
  registerResourceCommandHandlers,
  createProductionSystem,
  type ProgressionSnapshot,
} from '@idle-engine/core';
import { cosmicBakeryContent } from '@idle-engine/cosmic-bakery-content';

export interface GameState {
  resources: Map<string, { amount: number; capacity: number | null; rate: number }>;
  generators: Map<string, { level: number; unlocked: boolean }>;
  upgrades: Map<string, { purchased: number; unlocked: boolean }>;
  ready: boolean;
}

export function useGameEngine() {
  const runtimeRef = useRef<IdleEngineRuntime | null>(null);
  const coordinatorRef = useRef<ReturnType<typeof createProgressionCoordinator> | null>(null);
  const [state, setState] = useState<GameState>({
    resources: new Map(),
    generators: new Map(),
    upgrades: new Map(),
    ready: false,
  });

  useEffect(() => {
    const stepDurationMs = 100;

    // Create progression coordinator
    const coordinator = createProgressionCoordinator({
      content: cosmicBakeryContent,
      stepDurationMs,
    });
    coordinatorRef.current = coordinator;

    // Create runtime
    const runtime = new IdleEngineRuntime({
      stepSizeMs: stepDurationMs,
    });
    runtimeRef.current = runtime;

    // Register command handlers
    registerResourceCommandHandlers({
      dispatcher: runtime.getCommandDispatcher(),
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      upgradePurchases: coordinator.upgradeEvaluator,
    });

    // Create and add production system
    const productionSystem = createProductionSystem({
      resourceState: coordinator.resourceState,
      generators: () => (coordinator.state.generators ?? []).map(g => ({
        id: g.id,
        owned: g.owned,
        produces: g.produces ?? [],
        consumes: g.consumes ?? [],
      })),
    });
    runtime.addSystem(productionSystem);

    // Initial state sync
    coordinator.updateForStep(0);
    const snapshot = buildProgressionSnapshot(
      0,
      performance.now(),
      coordinator.state,
    );
    syncState(snapshot);
    setState(prev => ({ ...prev, ready: true }));

    // Game loop
    let lastTime = performance.now();
    let animationId: number;

    const tick = (now: number) => {
      const deltaMs = now - lastTime;
      lastTime = now;

      const before = runtime.getCurrentStep();
      runtime.tick(deltaMs);
      const after = runtime.getCurrentStep();

      if (after > before) {
        coordinator.updateForStep(after);
        const snapshot = buildProgressionSnapshot(
          after,
          now,
          coordinator.state,
        );
        syncState(snapshot);
      }

      animationId = requestAnimationFrame(tick);
    };

    animationId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, []);

  const syncState = useCallback((snapshot: ProgressionSnapshot) => {
    const resources = new Map<string, { amount: number; capacity: number | null; rate: number }>();
    for (const r of snapshot.resources) {
      resources.set(r.id, {
        amount: r.amount,
        capacity: r.capacity ?? null,
        rate: r.perTick * 10 // Convert per-tick to per-second (100ms ticks)
      });
    }

    const generators = new Map<string, { level: number; unlocked: boolean }>();
    for (const g of snapshot.generators ?? []) {
      generators.set(g.id, { level: g.owned, unlocked: g.isUnlocked });
    }

    const upgrades = new Map<string, { purchased: number; unlocked: boolean }>();
    for (const u of snapshot.upgrades ?? []) {
      // UpgradeView doesn't have purchased/unlocked, we need to check status
      const purchased = u.status === 'purchased' ? 1 : 0;
      const unlocked = u.isVisible;
      upgrades.set(u.id, { purchased, unlocked });
    }

    setState(prev => ({
      ...prev,
      resources,
      generators,
      upgrades,
    }));
  }, []);

  const buyGenerator = useCallback((id: string) => {
    if (!runtimeRef.current) return;

    runtimeRef.current.getCommandDispatcher().execute({
      type: 'PURCHASE_GENERATOR',
      payload: {
        generatorId: id,
        count: 1,
      },
      step: runtimeRef.current.getCurrentStep(),
      priority: 1, // PLAYER priority
      timestamp: performance.now(),
    });
  }, []);

  const buyUpgrade = useCallback((id: string) => {
    if (!runtimeRef.current) return;

    runtimeRef.current.getCommandDispatcher().execute({
      type: 'PURCHASE_UPGRADE',
      payload: {
        upgradeId: id,
      },
      step: runtimeRef.current.getCurrentStep(),
      priority: 1, // PLAYER priority
      timestamp: performance.now(),
    });
  }, []);

  return { state, buyGenerator, buyUpgrade };
}
