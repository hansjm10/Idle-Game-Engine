import { useId, useMemo, type JSX } from 'react';
import type { ResourceView } from '@idle-engine/core';

import { useShellProgression, useShellState } from './ShellStateProvider.js';
import styles from './ResourceDashboard.module.css';

/**
 * Memoized number formatters for consistent, performant number formatting.
 * Created once at module load time and reused across all component instances.
 * useGrouping: false ensures no thousand separators (e.g., "1234" not "1,234").
 */
const mediumNumberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  useGrouping: false,
});

const smallNumberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
});

/**
 * Threshold for treating per-tick rates as neutral (±0).
 * Values with absolute value less than this are displayed as "±0/tick".
 */
const RATE_NEUTRAL_THRESHOLD = 0.005;

/**
 * View-model utility: format a resource amount for display.
 * Handles large numbers with appropriate precision using Intl.NumberFormat.
 *
 * Precision rules (intentional for readability):
 * - Non-finite (NaN/Infinity): Returns "0"
 * - >= 1,000,000: Exponential notation (e.g., "1.23e+6")
 * - >= 100: No decimal places (e.g., "125" not "125.50")
 * - < 100: Two decimal places (e.g., "42.75")
 *
 * This creates intentional rounding differences (e.g., 99.999 → "100.00" → "100",
 * 125.5 → "126") to balance precision with readability at different scales.
 */
export function formatResourceAmount(amount: number): string {
  // Guard against non-finite values (NaN, Infinity, -Infinity)
  if (!Number.isFinite(amount)) {
    return '0';
  }

  if (amount === 0) {
    return '0';
  }

  // For very large numbers, use exponential notation
  // (Intl.NumberFormat scientific notation produces different format, so keep toExponential)
  if (Math.abs(amount) >= 1e6) {
    return amount.toExponential(2);
  }

  // For medium numbers, use no decimal places
  if (Math.abs(amount) >= 100) {
    return mediumNumberFormatter.format(amount);
  }

  // For small numbers, show two decimal places
  return smallNumberFormatter.format(amount);
}

/**
 * View-model utility: format per-tick rate with sign indicator.
 * Uses ±0 for values very close to zero (|x| < RATE_NEUTRAL_THRESHOLD) to maintain consistency.
 * Uses Intl.NumberFormat for consistent, performant number formatting.
 */
export function formatPerTickRate(perTick: number): string {
  // Guard against non-finite values (NaN, Infinity, -Infinity)
  if (!Number.isFinite(perTick)) {
    return '±0/tick';
  }

  // Treat values very close to zero as neutral
  if (Math.abs(perTick) < RATE_NEUTRAL_THRESHOLD) {
    return '±0/tick';
  }

  const sign = perTick > 0 ? '+' : '-';
  const absValue = Math.abs(perTick);
  const formatted = absValue >= 100
    ? mediumNumberFormatter.format(absValue)
    : smallNumberFormatter.format(absValue);

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
  if (capacity === undefined || capacity <= 0) {
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
    // Align class logic with display threshold to maintain visual consistency
    if (Math.abs(resource.perTick) < RATE_NEUTRAL_THRESHOLD) {
      return styles.rateNeutral;
    }
    if (resource.perTick > 0) {
      return styles.ratePositive;
    }
    return styles.rateNegative;
  }, [resource.perTick]);

  return (
    <div
      className={styles.resourceRow}
      role="row"
    >
      <div className={styles.resourceName} role="rowheader">
        {resource.displayName}
      </div>
      <div className={styles.resourceAmount} role="cell">
        {formatCapacity(resource.amount, resource.capacity)}
      </div>
      {resource.capacity !== undefined && resource.capacity > 0 ? (
        <div role="cell">
          <div
            className={styles.capacityBar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={resource.capacity}
            aria-valuenow={Math.max(0, Math.min(resource.amount, resource.capacity))}
            aria-valuetext={`${Math.round(fillPercentage)}% full`}
            aria-label={`Capacity: ${formatCapacity(resource.amount, resource.capacity)}`}
          >
            <div
              className={styles.capacityBarFill}
              style={{ width: `${fillPercentage}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
      ) : (
        <div role="cell" aria-label="No capacity limit" />
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

function LoadingState(): JSX.Element {
  return (
    <div className={styles.loadingState} role="status">
      <p className={styles.loadingStateText}>
        Loading resource data...
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
 * @see docs/build-resource-generator-upgrade-ui-components-design.md §6.1-§6.3
 */
export function ResourceDashboard(): JSX.Element | null {
  const progression = useShellProgression();
  const { bridge } = useShellState();
  const headingId = useId();

  // Feature flag check
  if (!progression.isEnabled) {
    return null;
  }

  // Get resources from memoized selector (with optimistic updates)
  const resources = progression.selectOptimisticResources();

  // Filter to unlocked and visible resources (runs on every render to keep
  // hook order stable even before progression data is available).
  const visibleResources = useMemo(
    () => (resources ?? []).filter((r) => r.isUnlocked && r.isVisible),
    [resources],
  );

  // Distinguish between loading and truly locked states
  const isLoading = !bridge.isReady || bridge.lastUpdateAt === null;

  // Handle no progression data available
  if (!resources) {
    return (
      <section
        className={styles.dashboard}
        aria-labelledby={headingId}
      >
        <h2 id={headingId} className={styles.heading}>
          Resources
        </h2>
        {isLoading ? <LoadingState /> : <LockedState />}
      </section>
    );
  }

  return (
    <section
      className={styles.dashboard}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className={styles.heading}>
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
            <div className={styles.headerCell} role="columnheader">
              <span className={styles.visuallyHidden}>Capacity bar</span>
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
