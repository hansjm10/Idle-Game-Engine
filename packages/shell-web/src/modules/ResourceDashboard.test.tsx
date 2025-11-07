import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResourceView } from '@idle-engine/core';

import {
  ResourceDashboard,
  formatResourceAmount,
  formatPerTickRate,
  formatCapacity,
  computeCapacityFillPercentage,
} from './ResourceDashboard.js';
import type {
  ShellProgressionApi,
  ShellState,
} from './shell-state.types.js';
import styles from './ResourceDashboard.module.css';

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

// Mock the ShellStateProvider hooks
const mockProgressionApi: Mutable<ShellProgressionApi> = {
  isEnabled: true,
  schemaVersion: 1,
  selectResources: vi.fn(() => null),
  selectGenerators: vi.fn(() => null),
  selectUpgrades: vi.fn(() => null),
  selectOptimisticResources: vi.fn(() => null),
};

const mockShellState: { bridge: Mutable<ShellState['bridge']> } = {
  bridge: {
    isReady: true,
    isRestoring: false,
    lastUpdateAt: Date.now(),
    errors: [],
  },
};

vi.mock('./ShellStateProvider.js', () => ({
  useShellProgression: vi.fn(() => mockProgressionApi),
  useShellState: vi.fn(() => mockShellState),
}));

describe('ResourceDashboard view-model utilities', () => {
  describe('formatResourceAmount', () => {
    it('formats zero', () => {
      expect(formatResourceAmount(0)).toBe('0');
    });

    it('formats small numbers with precision', () => {
      expect(formatResourceAmount(1.234)).toBe('1.23');
      expect(formatResourceAmount(12.567)).toBe('12.57');
      expect(formatResourceAmount(99.999)).toBe('100.00');
    });

    it('formats medium numbers without decimals', () => {
      expect(formatResourceAmount(100)).toBe('100');
      expect(formatResourceAmount(1234)).toBe('1234');
      expect(formatResourceAmount(999999)).toBe('999999');
    });

    it('formats large numbers in exponential notation', () => {
      expect(formatResourceAmount(1000000)).toBe('1.00e+6');
      expect(formatResourceAmount(1234567890)).toBe('1.23e+9');
    });

    it('formats boundary value at exponential threshold', () => {
      // Test the boundary at 1e6 threshold
      // Values below 1e6 use integer formatting (even if they round to 1e6)
      expect(formatResourceAmount(999999)).toBe('999999');
      expect(formatResourceAmount(999999.9)).toBe('1000000'); // Rounded by mediumNumberFormatter
      // Values at or above 1e6 use exponential notation
      expect(formatResourceAmount(1000000)).toBe('1.00e+6');
      expect(formatResourceAmount(1000001)).toBe('1.00e+6');
    });

    it('handles negative numbers', () => {
      expect(formatResourceAmount(-5.67)).toBe('-5.67');
      expect(formatResourceAmount(-1000000)).toBe('-1.00e+6');
    });

    it('handles non-finite values', () => {
      // NaN, Infinity, and -Infinity should be formatted as "0" for safety
      expect(formatResourceAmount(NaN)).toBe('0');
      expect(formatResourceAmount(Infinity)).toBe('0');
      expect(formatResourceAmount(-Infinity)).toBe('0');
    });
  });

  describe('formatPerTickRate', () => {
    it('formats zero rate', () => {
      expect(formatPerTickRate(0)).toBe('±0/tick');
    });

    it('formats positive rates with + sign', () => {
      expect(formatPerTickRate(1.23)).toBe('+1.23/tick');
      expect(formatPerTickRate(150)).toBe('+150/tick');
    });

    it('formats negative rates with - sign', () => {
      expect(formatPerTickRate(-2.45)).toBe('-2.45/tick');
      expect(formatPerTickRate(-200)).toBe('-200/tick');
    });

    it('applies precision based on magnitude', () => {
      expect(formatPerTickRate(0.01)).toBe('+0.01/tick');
      expect(formatPerTickRate(99.99)).toBe('+99.99/tick');
      expect(formatPerTickRate(100.01)).toBe('+100/tick');
    });

    it('formats very large per-tick rates without decimals', () => {
      expect(formatPerTickRate(150)).toBe('+150/tick');
      expect(formatPerTickRate(1000)).toBe('+1000/tick');
      expect(formatPerTickRate(5000.75)).toBe('+5001/tick');
      expect(formatPerTickRate(-2500.25)).toBe('-2500/tick');
    });

    it('handles negative zero and very small values that round to zero', () => {
      expect(formatPerTickRate(-0)).toBe('±0/tick');
      expect(formatPerTickRate(-0.001)).toBe('±0/tick');
      expect(formatPerTickRate(0.001)).toBe('±0/tick');
      expect(formatPerTickRate(-0.004)).toBe('±0/tick');
      expect(formatPerTickRate(0.004)).toBe('±0/tick');
    });

    it('handles boundary at RATE_NEUTRAL_THRESHOLD (0.005)', () => {
      // Values with abs < 0.005 are neutral
      expect(formatPerTickRate(0.004)).toBe('±0/tick');
      expect(formatPerTickRate(-0.004)).toBe('±0/tick');

      // Values with abs >= 0.005 are signed (0.005 rounds to ±0.01)
      expect(formatPerTickRate(0.005)).toBe('+0.01/tick');
      expect(formatPerTickRate(-0.005)).toBe('-0.01/tick');

      // Just above threshold
      expect(formatPerTickRate(0.006)).toBe('+0.01/tick');
      expect(formatPerTickRate(-0.006)).toBe('-0.01/tick');
    });

    it('handles non-finite values', () => {
      // NaN, Infinity, and -Infinity should all be formatted as "±0/tick" for safety
      expect(formatPerTickRate(NaN)).toBe('±0/tick');
      expect(formatPerTickRate(Infinity)).toBe('±0/tick');
      expect(formatPerTickRate(-Infinity)).toBe('±0/tick');
    });
  });

  describe('formatCapacity', () => {
    it('formats without capacity', () => {
      expect(formatCapacity(123.45)).toBe('123');
      expect(formatCapacity(5.67)).toBe('5.67');
    });

    it('formats with capacity', () => {
      expect(formatCapacity(100, 250)).toBe('100 / 250');
      expect(formatCapacity(5.5, 10)).toBe('5.50 / 10.00');
    });

    it('handles large capacity values', () => {
      expect(formatCapacity(500000, 1000000)).toBe('500000 / 1.00e+6');
      expect(formatCapacity(5e6, 1e7)).toBe('5.00e+6 / 1.00e+7');
    });
  });

  describe('computeCapacityFillPercentage', () => {
    it('returns 0 when no capacity', () => {
      expect(computeCapacityFillPercentage(100)).toBe(0);
      expect(computeCapacityFillPercentage(100, undefined)).toBe(0);
    });

    it('returns 0 when capacity is zero', () => {
      expect(computeCapacityFillPercentage(100, 0)).toBe(0);
    });

    it('computes correct percentage', () => {
      expect(computeCapacityFillPercentage(50, 100)).toBe(50);
      expect(computeCapacityFillPercentage(75, 150)).toBe(50);
      expect(computeCapacityFillPercentage(25, 100)).toBe(25);
    });

    it('clamps to 100% maximum', () => {
      expect(computeCapacityFillPercentage(150, 100)).toBe(100);
      expect(computeCapacityFillPercentage(1000, 100)).toBe(100);
    });

    it('clamps to 0% minimum', () => {
      expect(computeCapacityFillPercentage(-10, 100)).toBe(0);
    });

    it('returns 0 for negative capacity', () => {
      expect(computeCapacityFillPercentage(50, -100)).toBe(0);
      expect(computeCapacityFillPercentage(100, -50)).toBe(0);
      expect(computeCapacityFillPercentage(-10, -100)).toBe(0);
    });
  });
});

describe('ResourceDashboard component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProgressionApi.isEnabled = true;
    mockProgressionApi.selectOptimisticResources = vi.fn(() => null);
    mockShellState.bridge.isReady = true;
    mockShellState.bridge.lastUpdateAt = Date.now();
  });

  describe('feature flag', () => {
    it('renders nothing when feature flag is disabled', () => {
      mockProgressionApi.isEnabled = false;
      const { container } = render(<ResourceDashboard />);
      expect(container.firstChild).toBeNull();
    });

    it('renders when feature flag is enabled', () => {
      mockProgressionApi.isEnabled = true;
      render(<ResourceDashboard />);
      expect(screen.getByRole('region')).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('renders loading state when bridge is not ready', () => {
      mockProgressionApi.selectOptimisticResources = vi.fn(() => null);
      mockShellState.bridge.isReady = false;
      render(<ResourceDashboard />);

      expect(screen.getByText('Resources')).toBeInTheDocument();
      expect(screen.getByText(/Loading resource data/i)).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('renders loading state when no lastUpdateAt', () => {
      mockProgressionApi.selectOptimisticResources = vi.fn(() => null);
      mockShellState.bridge.isReady = true;
      mockShellState.bridge.lastUpdateAt = null;
      render(<ResourceDashboard />);

      expect(screen.getByText('Resources')).toBeInTheDocument();
      expect(screen.getByText(/Loading resource data/i)).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  describe('locked state', () => {
    it('renders locked state when bridge is ready but no resources available', () => {
      mockProgressionApi.selectOptimisticResources = vi.fn(() => null);
      mockShellState.bridge.isReady = true;
      mockShellState.bridge.lastUpdateAt = Date.now();
      render(<ResourceDashboard />);

      expect(screen.getByText('Resources')).toBeInTheDocument();
      expect(screen.getByText(/Resource progression is locked/i)).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty state when resources array is empty', () => {
      mockProgressionApi.selectOptimisticResources = vi.fn(() => []);
      render(<ResourceDashboard />);

      expect(screen.getByText('Resources')).toBeInTheDocument();
      expect(screen.getByText(/No resources available yet/i)).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    it('renders empty state when all resources are locked', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 0,
          isUnlocked: false,
          isVisible: false,
          perTick: 0,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByText(/No resources available yet/i)).toBeInTheDocument();
    });

    it('renders empty state when all resources are invisible', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: false,
          perTick: 1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByText(/No resources available yet/i)).toBeInTheDocument();
    });
  });

  describe('resource rendering', () => {
    it('renders unlocked and visible resources', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 125.5,
          isUnlocked: true,
          isVisible: true,
          capacity: 250,
          perTick: 0.55,
        },
        {
          id: 'res-2',
          displayName: 'Crystal',
          amount: 4,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.025,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByText('Energy')).toBeInTheDocument();
      expect(screen.getByText('Crystal')).toBeInTheDocument();
      expect(screen.getByText('126 / 250')).toBeInTheDocument();
      expect(screen.getByText('4.00')).toBeInTheDocument();
      expect(screen.getByText('+0.55/tick')).toBeInTheDocument();
      expect(screen.getByText('+0.03/tick')).toBeInTheDocument();
    });

    it('filters out locked resources', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 1,
        },
        {
          id: 'res-2',
          displayName: 'Locked Resource',
          amount: 0,
          isUnlocked: false,
          isVisible: true,
          perTick: 0,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByText('Energy')).toBeInTheDocument();
      expect(screen.queryByText('Locked Resource')).not.toBeInTheDocument();
    });

    it('filters out invisible resources', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 1,
        },
        {
          id: 'res-2',
          displayName: 'Hidden Resource',
          amount: 50,
          isUnlocked: true,
          isVisible: false,
          perTick: 0.5,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByText('Energy')).toBeInTheDocument();
      expect(screen.queryByText('Hidden Resource')).not.toBeInTheDocument();
    });
  });

  describe('capacity rendering', () => {
    it('renders capacity bar for resources with capacity', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 50,
          isUnlocked: true,
          isVisible: true,
          capacity: 100,
          perTick: 0,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Capacity bar should be present with fill
      const capacityBars = screen.getAllByRole('progressbar');
      expect(capacityBars).toHaveLength(1);
    });

    it('renders capacity bar with correct fill width', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 50,
          isUnlocked: true,
          isVisible: true,
          capacity: 100,
          perTick: 0,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Get the capacity bar container
      const capacityBar = screen.getByRole('progressbar');

      // Get the fill element (first child with aria-hidden)
      const fillElement = capacityBar.querySelector('[aria-hidden="true"]') as HTMLElement;
      expect(fillElement).toBeTruthy();

      // Assert the fill width is 50% (amount=50, capacity=100)
      expect(fillElement.style.width).toBe('50%');
    });

    it('renders placeholder when capacity is exactly zero', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 0,
          isUnlocked: true,
          isVisible: true,
          capacity: 0,
          perTick: 0,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Should render "No capacity limit" placeholder (not progressbar)
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByLabelText('No capacity limit')).toBeInTheDocument();
    });

    it('renders placeholder for resources with negative capacity', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 50,
          isUnlocked: true,
          isVisible: true,
          capacity: -100,
          perTick: 1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Should render "No capacity limit" placeholder (not progressbar)
      // Negative capacity is treated as invalid/no capacity
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByLabelText('No capacity limit')).toBeInTheDocument();
    });

    it('does not render capacity bar for resources without capacity', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Crystal',
          amount: 10,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // No capacity bar should be rendered
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('renders accessible placeholder cell for resources without capacity', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Crystal',
          amount: 10,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Placeholder cell should have accessible label
      expect(screen.getByLabelText('No capacity limit')).toBeInTheDocument();
    });

    it('maintains 4-column structure for resources without capacity', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Crystal',
          amount: 10,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      const { container } = render(<ResourceDashboard />);

      // Find the resource row
      const rows = container.querySelectorAll('[role="row"]');
      // Should have header row + 1 resource row
      expect(rows).toHaveLength(2);

      // Check data row (not header)
      const dataRow = rows[1];
      const cells = dataRow.querySelectorAll('[role="cell"], [role="rowheader"]');

      // Should have 4 cells: rowheader (name) + 3 cells (amount, capacity placeholder, rate)
      expect(cells).toHaveLength(4);
    });

    it('maintains consistent structure for mixed capacity scenarios', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 50,
          capacity: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 1,
        },
        {
          id: 'res-2',
          displayName: 'Crystal',
          amount: 10,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      const { container } = render(<ResourceDashboard />);

      const rows = container.querySelectorAll('[role="row"]');
      // Header + 2 resource rows
      expect(rows).toHaveLength(3);

      // Check both data rows have same structure
      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll('[role="cell"], [role="rowheader"]');
        expect(cells).toHaveLength(4);
      }
    });
  });

  describe('rate styling', () => {
    it('applies correct styling for positive rates', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 5.5,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const rateElement = screen.getByText('+5.50/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.classList.contains(styles.ratePositive)).toBe(true);
    });

    it('applies correct styling for negative rates', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: -2.5,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const rateElement = screen.getByText('-2.50/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.classList.contains(styles.rateNegative)).toBe(true);
    });

    it('applies correct styling for zero rates', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 0,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const rateElement = screen.getByText('±0/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.classList.contains(styles.rateNeutral)).toBe(true);
    });

    it('applies neutral styling for near-zero positive rates', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.004, // Below RATE_NEUTRAL_THRESHOLD (0.005)
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Should display as neutral and have neutral styling
      const rateElement = screen.getByText('±0/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.classList.contains(styles.rateNeutral)).toBe(true);
      expect(rateElement.classList.contains(styles.ratePositive)).toBe(false);
    });

    it('applies neutral styling for near-zero negative rates', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: -0.004, // Below RATE_NEUTRAL_THRESHOLD (0.005)
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Should display as neutral and have neutral styling
      const rateElement = screen.getByText('±0/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.classList.contains(styles.rateNeutral)).toBe(true);
      expect(rateElement.classList.contains(styles.rateNegative)).toBe(false);
    });
  });

  describe('accessibility', () => {
    it('has proper ARIA structure', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByRole('region', { name: /Resources/ })).toBeInTheDocument();
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getAllByRole('row')).toHaveLength(2); // header + 1 resource
      expect(screen.getAllByRole('columnheader')).toHaveLength(4);
    });

    it('uses proper table semantics without aria-label on rows', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 125.5,
          isUnlocked: true,
          isVisible: true,
          capacity: 250,
          perTick: 0.55,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Check that row structure uses proper table semantics
      // Screen readers derive names from rowheader + cells naturally
      const row = screen.getAllByRole('row')[1]; // First data row (skip header)
      expect(row.querySelector('[role="rowheader"]')).toHaveTextContent('Energy');
      expect(row.querySelector('[role="rowheader"]')).toBeInTheDocument();

      // Verify row does not have aria-label (lets screen readers compute from cells)
      expect(row).not.toHaveAttribute('aria-label');
    });

    it('has proper heading structure', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent('Resources');

      // Verify heading has an ID (generated by useId)
      const headingId = heading.getAttribute('id');
      expect(headingId).toBeTruthy();

      // Verify section references the heading via aria-labelledby
      const section = screen.getByRole('region');
      expect(section).toHaveAttribute('aria-labelledby', headingId);
    });

    it('has proper progressbar ARIA attributes for capacity indicators', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 75,
          isUnlocked: true,
          isVisible: true,
          capacity: 150,
          perTick: 1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const progressbar = screen.getByRole('progressbar');

      // Verify progressbar ARIA attributes
      expect(progressbar).toHaveAttribute('aria-valuemin', '0');
      expect(progressbar).toHaveAttribute('aria-valuemax', '150');
      expect(progressbar).toHaveAttribute('aria-valuenow', '75');
      expect(progressbar).toHaveAttribute('aria-label', 'Capacity: 75.00 / 150');
    });

    it('clamps aria-valuenow when amount exceeds capacity', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 150,
          isUnlocked: true,
          isVisible: true,
          capacity: 100,
          perTick: 1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const progressbar = screen.getByRole('progressbar');

      // aria-valuenow should be clamped to capacity (max value)
      expect(progressbar).toHaveAttribute('aria-valuemin', '0');
      expect(progressbar).toHaveAttribute('aria-valuemax', '100');
      expect(progressbar).toHaveAttribute('aria-valuenow', '100');
      expect(progressbar).toHaveAttribute('aria-valuetext', '100% full');
    });

    it('clamps aria-valuenow when amount is negative', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: -10,
          isUnlocked: true,
          isVisible: true,
          capacity: 100,
          perTick: -1,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const progressbar = screen.getByRole('progressbar');

      // aria-valuenow should be clamped to 0 (min value)
      expect(progressbar).toHaveAttribute('aria-valuemin', '0');
      expect(progressbar).toHaveAttribute('aria-valuemax', '100');
      expect(progressbar).toHaveAttribute('aria-valuenow', '0');
      expect(progressbar).toHaveAttribute('aria-valuetext', '0% full');
    });
  });

  describe('memoization', () => {
    it('filters resources using memoized selector', () => {
      const resources: ResourceView[] = [
        {
          id: 'res-1',
          displayName: 'Energy',
          amount: 100,
          isUnlocked: true,
          isVisible: true,
          perTick: 1,
        },
        {
          id: 'res-2',
          displayName: 'Locked',
          amount: 0,
          isUnlocked: false,
          isVisible: false,
          perTick: 0,
        },
      ];

      const selectOptimisticResourcesMock = vi.fn(() => resources);
      mockProgressionApi.selectOptimisticResources = selectOptimisticResourcesMock;

      const { rerender } = render(<ResourceDashboard />);

      // Initial render should call selector once
      expect(selectOptimisticResourcesMock).toHaveBeenCalledTimes(1);

      // Re-render should call selector again (each render)
      rerender(<ResourceDashboard />);
      expect(selectOptimisticResourcesMock).toHaveBeenCalledTimes(2);

      // Verify only unlocked resources are shown
      expect(screen.getByText('Energy')).toBeInTheDocument();
      expect(screen.queryByText('Locked')).not.toBeInTheDocument();
    });
  });

  describe('snapshot rendering', () => {
    it('renders deterministic output for analytics', () => {
      const resources: ResourceView[] = [
        {
          id: 'sample-pack.energy',
          displayName: 'Energy',
          amount: 125.5,
          isUnlocked: true,
          isVisible: true,
          capacity: 250,
          perTick: 0.55,
        },
        {
          id: 'sample-pack.crystal',
          displayName: 'Crystal',
          amount: 4,
          isUnlocked: true,
          isVisible: true,
          perTick: 0.025,
        },
      ];
      mockProgressionApi.selectOptimisticResources = vi.fn(() => resources);

      render(<ResourceDashboard />);

      // Verify consistent structure for deterministic rendering
      const rows = screen.getAllByRole('row');
      expect(rows).toHaveLength(3); // header + 2 resources

      // Verify consistent ordering matches snapshot order
      const resourceRows = rows.slice(1);
      expect(resourceRows[0]).toHaveTextContent('Energy');
      expect(resourceRows[1]).toHaveTextContent('Crystal');
    });
  });
});
