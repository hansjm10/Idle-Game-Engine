import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DiagnosticTimelineResult } from '@idle-engine/core';

import { DiagnosticsPanel } from './DiagnosticsPanel.js';

type Subscriber = (timeline: DiagnosticTimelineResult) => void;

const mockDiagnostics = {
  latest: null as DiagnosticTimelineResult | null,
  isEnabled: false,
  subscribe: vi.fn<(cb: Subscriber) => () => void>(),
};

vi.mock('./ShellStateProvider.js', () => ({
  useShellDiagnostics: vi.fn(() => mockDiagnostics),
}));

function sampleTimeline(head = 1): DiagnosticTimelineResult {
  const now = performance.now();
  return {
    entries: [
      {
        tick: 0,
        startedAt: now - 100,
        endedAt: now - 0,
        durationMs: 10,
        budgetMs: 10,
        isSlow: false,
        overBudgetMs: 0,
        metadata: { queue: { sizeBefore: 0, sizeAfter: 0, captured: 0, executed: 0, skipped: 0 } },
      },
    ],
    head,
    dropped: 0,
    configuration: { capacity: 128, enabled: true, tickBudgetMs: 10 },
  } as unknown as DiagnosticTimelineResult;
}

describe('DiagnosticsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDiagnostics.latest = null;
    mockDiagnostics.isEnabled = false;
    mockDiagnostics.subscribe = vi.fn(() => vi.fn());
  });

  it('toggles visibility and subscribes when opened', async () => {
    render(<DiagnosticsPanel />);
    const toggle = screen.getByRole('button', { name: /Show Diagnostics/i });
    expect(toggle).toBeInTheDocument();

    // Open panel
    fireEvent.click(toggle);
    expect(mockDiagnostics.subscribe).toHaveBeenCalledTimes(1);

    const subscriber = mockDiagnostics.subscribe.mock.calls[0]![0] as Subscriber;
    subscriber(sampleTimeline(2));

    // Some of the summary fields should be visible
    expect(await screen.findByText('Head')).toBeInTheDocument();
    expect(await screen.findByText('Entries')).toBeInTheDocument();
  });
});

