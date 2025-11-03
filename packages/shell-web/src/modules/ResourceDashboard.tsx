import { useMemo } from 'react';
import type { ResourceView } from '@idle-engine/core';

import { useShellProgression } from './ShellStateProvider.js';
import styles from './ResourceDashboard.module.css';

/**
 * View-model utility: format a resource amount for display.
 * Handles large numbers with appropriate precision.
 */
export function formatResourceAmount(amount: number): string {
  if (amount === 0) {
    return '0';
  }

  // For very large numbers, use exponential notation
  if (Math.abs(amount) >= 1e6) {
    return amount.toExponential(2);
  }

  // For medium numbers, use fixed precision
  if (Math.abs(amount) >= 100) {
    return amount.toFixed(0);
  }

  // For small numbers, show more precision
  return amount.toFixed(2);
}

/**
 * View-model utility: format per-tick rate with sign indicator.
 */
export function formatPerTickRate(perTick: number): string {
  if (perTick === 0) {
    return '±0/tick';
  }

  const sign = perTick > 0 ? '+' : '';
  const formatted = Math.abs(perTick) >= 100
    ? perTick.toFixed(0)
    : perTick.toFixed(2);

  return `${sign}${formatted}/tick`;
}

/**
 * View-model utility: format capacity display.
 */
export function formatCapacity(amount: number, capacity?: number): string {
  if (capacity === undefined) {
    return formatResourceAmount(amount);
  }

  return `${formatResourceAmount(amount)} / ${formatResourceAmount(capacity)}`;
}

/**
 * View-model utility: compute capacity fill percentage for visual indicators.
 */
export function computeCapacityFillPercentage(
  amount: number,
  capacity?: number,
): number {
  if (capacity === undefined || capacity === 0) {
    return 0;
  }

  return Math.min(100, Math.max(0, (amount / capacity) * 100));
}

interface ResourceRowProps {
  readonly resource: ResourceView;
}

function ResourceRow({ resource }: ResourceRowProps): JSX.Element {
  const fillPercentage = useMemo(
    () => computeCapacityFillPercentage(resource.amount, resource.capacity),
    [resource.amount, resource.capacity],
  );

  const rateClassName = useMemo(() => {
    if (resource.perTick > 0) {
      return styles.ratePositive;
    }
    if (resource.perTick < 0) {
      return styles.rateNegative;
    }
    return styles.rateNeutral;
  }, [resource.perTick]);

  return (
    <div
      className={styles.resourceRow}
      role="row"
      aria-label={`${resource.displayName}: ${formatCapacity(resource.amount, resource.capacity)}`}
    >
      <div className={styles.resourceName} role="rowheader">
        {resource.displayName}
      </div>
      <div className={styles.resourceAmount} role="cell">
        {formatCapacity(resource.amount, resource.capacity)}
      </div>
      {resource.capacity !== undefined && (
        <div className={styles.capacityBar} role="cell" aria-label="Capacity indicator">
          <div
            className={styles.capacityBarFill}
            style={{ width: `${fillPercentage}%` }}
            aria-hidden="true"
          />
        </div>
      )}
      <div className={`${styles.resourceRate} ${rateClassName}`} role="cell">
        {formatPerTickRate(resource.perTick)}
      </div>
    </div>
  );
}

function EmptyState(): JSX.Element {
  return (
    <div className={styles.emptyState} role="status">
      <p className={styles.emptyStateText}>
        No resources available yet. Resources will appear here as you unlock them.
      </p>
    </div>
  );
}

function LockedState(): JSX.Element {
  return (
    <div className={styles.lockedState} role="status">
      <p className={styles.lockedStateText}>
        Resource progression is locked. Continue playing to unlock resource tracking.
      </p>
    </div>
  );
}

/**
 * ResourceDashboard component displays resource amounts, capacities, and per-tick rates.
 *
 * Features:
 * - Displays unlocked and visible resources from progression snapshot
 * - Shows capacity bars for resources with limits
 * - Color-codes per-tick rates (positive/negative/neutral)
 * - Handles locked, empty, and populated states
 * - Fully accessible with ARIA attributes and keyboard navigation
 * - Uses memoized selectors for deterministic rendering
 *
 * Gated by VITE_ENABLE_PROGRESSION_UI feature flag.
 *
 * @see docs/build-resource-generator-upgrade-ui-components-design.md §6.1-§6.3
 */
export function ResourceDashboard(): JSX.Element | null {
  const progression = useShellProgression();

  // Feature flag check
  if (!progression.isEnabled) {
    return null;
  }

  // Get resources from memoized selector
  const resources = progression.selectResources();

  // Handle no progression data available
  if (!resources) {
    return (
      <section
        className={styles.dashboard}
        aria-labelledby="resource-dashboard-heading"
      >
        <h2 id="resource-dashboard-heading" className={styles.heading}>
          Resources
        </h2>
        <LockedState />
      </section>
    );
  }

  // Filter to unlocked and visible resources
  const visibleResources = useMemo(
    () => resources.filter((r) => r.isUnlocked && r.isVisible),
    [resources],
  );

  return (
    <section
      className={styles.dashboard}
      aria-labelledby="resource-dashboard-heading"
    >
      <h2 id="resource-dashboard-heading" className={styles.heading}>
        Resources
      </h2>

      {visibleResources.length === 0 ? (
        <EmptyState />
      ) : (
        <div className={styles.resourceGrid} role="table" aria-label="Resource inventory">
          <div className={styles.resourceHeader} role="row">
            <div className={styles.headerCell} role="columnheader">
              Name
            </div>
            <div className={styles.headerCell} role="columnheader">
              Amount
            </div>
            <div className={styles.headerCell} role="columnheader" aria-label="Capacity bar">
              {/* Spacer for capacity bar column */}
            </div>
            <div className={styles.headerCell} role="columnheader">
              Rate
            </div>
          </div>

          {visibleResources.map((resource) => (
            <ResourceRow key={resource.id} resource={resource} />
          ))}
        </div>
      )}
    </section>
  );
}
