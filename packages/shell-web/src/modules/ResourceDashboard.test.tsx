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
} from './shell-state.types.js';

// Mock the ShellStateProvider hooks
const mockProgressionApi: ShellProgressionApi = {
  isEnabled: true,
  schemaVersion: 1,
  selectResources: vi.fn(() => null),
  selectGenerators: vi.fn(() => null),
  selectUpgrades: vi.fn(() => null),
  selectOptimisticResources: vi.fn(() => null),
};

vi.mock('./ShellStateProvider.js', () => ({
  useShellProgression: vi.fn(() => mockProgressionApi),
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

    it('handles negative numbers', () => {
      expect(formatResourceAmount(-5.67)).toBe('-5.67');
      expect(formatResourceAmount(-1000000)).toBe('-1.00e+6');
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
  });
});

describe('ResourceDashboard component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProgressionApi.isEnabled = true;
    mockProgressionApi.selectResources = vi.fn(() => null);
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

  describe('locked state', () => {
    it('renders locked state when no resources available', () => {
      mockProgressionApi.selectResources = vi.fn(() => null);
      render(<ResourceDashboard />);

      expect(screen.getByText('Resources')).toBeInTheDocument();
      expect(screen.getByText(/Resource progression is locked/i)).toBeInTheDocument();
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty state when resources array is empty', () => {
      mockProgressionApi.selectResources = vi.fn(() => []);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // Capacity bar should be present with fill
      const capacityBars = screen.getAllByLabelText('Capacity indicator');
      expect(capacityBars).toHaveLength(1);
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      // No capacity bar should be rendered
      expect(screen.queryByLabelText('Capacity indicator')).not.toBeInTheDocument();
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const rateElement = screen.getByText('+5.50/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.className).toContain('ratePositive');
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const rateElement = screen.getByText('-2.50/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.className).toContain('rateNegative');
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const rateElement = screen.getByText('±0/tick');
      expect(rateElement).toBeInTheDocument();
      expect(rateElement.className).toContain('rateNeutral');
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByRole('region')).toBeInTheDocument();
      expect(screen.getByLabelText('Resources')).toBeInTheDocument();
      expect(screen.getByRole('table')).toBeInTheDocument();
      expect(screen.getAllByRole('row')).toHaveLength(2); // header + 1 resource
      expect(screen.getAllByRole('columnheader')).toHaveLength(4);
    });

    it('includes row labels for screen readers', () => {
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      expect(screen.getByLabelText(/Energy: 126 \/ 250/)).toBeInTheDocument();
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
      mockProgressionApi.selectResources = vi.fn(() => resources);
      render(<ResourceDashboard />);

      const heading = screen.getByRole('heading', { level: 2 });
      expect(heading).toHaveTextContent('Resources');
      expect(heading).toHaveAttribute('id', 'resource-dashboard-heading');
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

      const selectResourcesMock = vi.fn(() => resources);
      mockProgressionApi.selectResources = selectResourcesMock;

      const { rerender } = render(<ResourceDashboard />);

      // Initial render should call selector once
      expect(selectResourcesMock).toHaveBeenCalledTimes(1);

      // Re-render should call selector again (each render)
      rerender(<ResourceDashboard />);
      expect(selectResourcesMock).toHaveBeenCalledTimes(2);

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
      mockProgressionApi.selectResources = vi.fn(() => resources);

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
