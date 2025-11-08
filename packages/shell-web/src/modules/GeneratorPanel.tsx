import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type { GeneratorView, ResourceView } from '@idle-engine/core';

import { useShellBridge, useShellProgression, useShellState } from './ShellStateProvider.js';
import { formatResourceAmount } from './ResourceDashboard.js';
import styles from './GeneratorPanel.module.css';

function LoadingState(): JSX.Element {
  return (
    <div className={styles.loadingState} role="status">
      Loading generator data...
    </div>
  );
}

function LockedState(): JSX.Element {
  return (
    <div className={styles.lockedState} role="status">
      Generator progression is locked. Continue playing to unlock generators.
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className={styles.emptyState} role="status">
      No generators available yet.
    </div>
  );
}

function hasSufficientFunds(costs: readonly { resourceId: string; amount: number }[], resources: readonly ResourceView[]): boolean {
  for (const cost of costs) {
    const r = resources.find((res) => res.id === cost.resourceId);
    if (!r || r.amount < cost.amount) {
      return false;
    }
  }
  return true;
}

interface ErrorToastProps {
  readonly message: string;
}

function ErrorToast({ message }: ErrorToastProps): JSX.Element {
  return (
    <div className={styles.errorToastContainer}>
      <div role="alert" aria-live="assertive" className={styles.errorToast}>
        {message}
      </div>
    </div>
  );
}

interface GeneratorCardProps {
  readonly generator: GeneratorView;
  readonly resources: readonly ResourceView[];
  readonly currentStep: number;
  onPurchase(id: string, costs: GeneratorView['costs']): void;
}

function GeneratorCard({ generator, resources, currentStep, onPurchase }: GeneratorCardProps): JSX.Element {
  const canAfford = hasSufficientFunds(generator.costs, resources);
  const isLocked = !generator.isUnlocked || !generator.isVisible;
  const isCoolingDown = generator.nextPurchaseReadyAtStep > currentStep;
  const disabled = isLocked || !canAfford || isCoolingDown;

  return (
    <div className={styles.card} role="group" aria-label={`${generator.displayName} generator`}>
      <div className={styles.nameRow}>
        <div className={styles.name}>{generator.displayName}</div>
        <div className={styles.owned} aria-label="Owned count">Owned: {generator.owned}</div>
      </div>
      <div className={styles.costsRow} aria-label="Costs">
        Costs:{' '}
        {generator.costs.map((c, idx) => (
          <span key={`${c.resourceId}-${idx}`} className={styles.costItem}>
            {formatResourceAmount(c.amount)} {c.resourceId.split('.').pop()}
          </span>
        ))}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.buyButton}
          disabled={disabled}
          aria-disabled={disabled}
          aria-label={`Buy 1 ${generator.displayName}`}
          onClick={() => onPurchase(generator.id, generator.costs)}
        >
          Buy 1
        </button>
        {isCoolingDown ? (
          <div className={styles.cooldown}>
            Ready next step ({generator.nextPurchaseReadyAtStep})
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GeneratorPanel(): JSX.Element | null {
  const progression = useShellProgression();
  const { bridge, runtime } = useShellState();
  const shellBridge = useShellBridge();
  const headingId = useId();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);

  // Read data from progression (may be null on initial load)
  const generators = progression.selectGenerators();
  const resourcesOptimistic = progression.selectOptimisticResources();

  // Derive view data unconditionally to preserve hook order
  const visibleGenerators = useMemo(
    () => (generators ?? []).filter((g) => g.isVisible),
    [generators],
  );
  const resources = useMemo(() => resourcesOptimistic ?? [], [resourcesOptimistic]);

  const isLoading = !bridge.isReady || bridge.lastUpdateAt === null;

  const handlePurchase = (generatorId: string, costs: GeneratorView['costs']) => {
    if (!resourcesOptimistic) {
      return;
    }
    // Stage negative cost deltas optimistically
    for (const cost of costs) {
      if (cost.amount > 0) {
        progression.stageResourceDelta(cost.resourceId, -cost.amount);
      }
    }
    try {
      shellBridge.sendCommand('PURCHASE_GENERATOR', {
        generatorId,
        count: 1,
      });
    } catch {
      // Local catch is rare; onError handler below also clears deltas
      progression.clearPendingDeltas();
      setErrorMessage('Generator purchase failed. Please try again.');
    }
  };

  // Subscribe to bridge errors to surface command errors as toasts
  useEffect(() => {
    // If the feature is disabled, don't subscribe
    if (!progression.isEnabled) {
      return;
    }
    const onError = (error: unknown) => {
      // Clear any optimistic pending deltas when a command fails
      progression.clearPendingDeltas();
      // Show a brief, accessible toast for any command error
      setErrorMessage(
        error instanceof Error ? error.message : 'An error occurred while processing your request.',
      );
      // Auto-clear after 4 seconds (error toasts remain long enough to be noticed)
      if (errorTimeoutRef.current) {
        window.clearTimeout(errorTimeoutRef.current);
      }
      errorTimeoutRef.current = window.setTimeout(() => setErrorMessage(null), 4000);
    };
    shellBridge.onError(onError);
    return () => {
      shellBridge.offError(onError);
      if (errorTimeoutRef.current) {
        window.clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = null;
      }
    };
  }, [shellBridge, progression.isEnabled]);

  // After hooks are declared, respect feature flag gating
  if (!progression.isEnabled) {
    return null;
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>Generators</h2>
      {!generators ? (
        isLoading ? <LoadingState /> : <LockedState />
      ) : visibleGenerators.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={styles.list}>
          {visibleGenerators.map((g) => (
            <GeneratorCard
              key={g.id}
              generator={g}
              resources={resources}
              currentStep={runtime.currentStep}
              onPurchase={handlePurchase}
            />)
          )}
        </div>
      )}
      {errorMessage ? <ErrorToast message={errorMessage} /> : null}
    </section>
  );
}
