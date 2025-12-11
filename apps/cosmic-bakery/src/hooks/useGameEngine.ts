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
  achievements: Map<string, { earned: boolean }>;
  ready: boolean;
}

// TODO: Enable when persistence API is available
// const SAVE_KEY = 'cosmic-bakery-save';
// const SAVE_INTERVAL = 30000; // 30 seconds

export function useGameEngine() {
  const runtimeRef = useRef<IdleEngineRuntime | null>(null);
  const coordinatorRef = useRef<ReturnType<typeof createProgressionCoordinator> | null>(null);
  const [state, setState] = useState<GameState>({
    resources: new Map(),
    generators: new Map(),
    upgrades: new Map(),
    achievements: new Map(),
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

    // TODO: Load saved state - requires persistence API
    // const savedState = localStorage.getItem(SAVE_KEY);
    // if (savedState) {
    //   try {
    //     // Load state when persistence API is available
    //   } catch (e) {
    //     console.warn('Failed to load save:', e);
    //   }
    // }

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

    // TODO: Auto-save interval - requires persistence API
    // const saveInterval = setInterval(() => {
    //   const state = runtimeRef.current?.getSerializableState();
    //   if (state) {
    //     localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    //   }
    // }, SAVE_INTERVAL);

    return () => {
      cancelAnimationFrame(animationId);
      // TODO: clearInterval(saveInterval);
      // TODO: Save on cleanup - requires persistence API
      // const state = runtimeRef.current?.getSerializableState();
      // if (state) {
      //   localStorage.setItem(SAVE_KEY, JSON.stringify(state));
      // }
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

    // TODO: Achievements not yet available in ProgressionSnapshot
    const achievements = new Map<string, { earned: boolean }>();
    // for (const a of snapshot.achievements ?? []) {
    //   achievements.set(a.id, { earned: a.isEarned });
    // }

    setState(prev => ({
      ...prev,
      resources,
      generators,
      upgrades,
      achievements,
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

  const saveGame = useCallback(() => {
    // TODO: Implement save functionality when persistence API is available
    console.log('Save functionality not yet implemented - requires persistence API');
  }, []);

  const resetGame = useCallback(() => {
    // TODO: Implement reset when persistence is available
    // localStorage.removeItem(SAVE_KEY);
    window.location.reload();
  }, []);

  const triggerPrestige = useCallback(() => {
    if (!runtimeRef.current) return;

    runtimeRef.current.getCommandDispatcher().execute({
      type: 'TRIGGER_PRESTIGE',
      payload: {
        prestigeLayerId: 'cosmic-bakery.celestial-ascension',
      },
      step: runtimeRef.current.getCurrentStep(),
      priority: 1, // PLAYER priority
      timestamp: performance.now(),
    });
  }, []);

  return { state, buyGenerator, buyUpgrade, saveGame, resetGame, triggerPrestige };
}
