import { useEffect, useState } from 'react';

import type { BackPressureSnapshot } from '@idle-engine/core';

import {
  type RuntimeEventSnapshot,
  useWorkerBridge,
  type RuntimeStateSnapshot,
  type OfflineCatchUpSummary,
} from './worker-bridge.js';
import { EventInspector } from './EventInspector.js';

const MAX_EVENT_HISTORY = 50;

export function App() {
  const bridge = useWorkerBridge();
  const [currentStep, setCurrentStep] = useState(0);
  const [events, setEvents] = useState<RuntimeEventSnapshot[]>([]);
  const [backPressure, setBackPressure] = useState<BackPressureSnapshot | null>(
    null,
  );
  const [offlineSummary, setOfflineSummary] = useState<OfflineCatchUpSummary | null>(
    null,
  );

  useEffect(() => {
    const handleState = (state: RuntimeStateSnapshot) => {
      setCurrentStep(state.currentStep);
      setBackPressure(state.backPressure);
      setEvents((previous) => {
        if (!state.events.length) {
          return previous;
        }

        const merged = [...state.events, ...previous];

        merged.sort((left, right) => {
          if (left.tick !== right.tick) {
            return right.tick - left.tick;
          }
          return right.dispatchOrder - left.dispatchOrder;
        });

        if (merged.length <= MAX_EVENT_HISTORY) {
          return merged;
        }

        return merged.slice(0, MAX_EVENT_HISTORY);
      });
    };

    bridge.onStateUpdate(handleState);
    return () => {
      bridge.offStateUpdate(handleState);
    };
  }, [bridge]);

  useEffect(() => {
    const handleVisibility = () => {
      bridge.setVisibilityState(document.visibilityState === 'visible');
    };

    handleVisibility();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [bridge]);

  useEffect(() => {
    const handleOffline = (summary: OfflineCatchUpSummary) => {
      setOfflineSummary(summary);
    };
    bridge.onOfflineCatchUpResult(handleOffline);
    return () => {
      bridge.offOfflineCatchUpResult(handleOffline);
    };
  }, [bridge]);

  const handleSendCommand = () => {
    bridge.sendCommand('PING', { issuedAt: performance.now() });
  };

  const handleOfflineCatchUp = () => {
    const elapsedMs = 60 * 60 * 1000;
    bridge.requestOfflineCatchUp(elapsedMs);
  };

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Idle Engine Shell</h1>
      <p>
        Placeholder web shell wired to the Worker runtime tick loop. Runtime step:{' '}
        <strong>{currentStep}</strong>.
      </p>
      <button onClick={handleSendCommand} type="button">
        Send Test Command
      </button>
      <button
        onClick={handleOfflineCatchUp}
        type="button"
        style={{ marginLeft: 12 }}
      >
        Simulate 1h Offline Catch-up
      </button>

      {offlineSummary ? (
        <section style={{ marginTop: 16 }}>
          <h2>Offline Catch-up</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8 }}>
            <dt>Requested</dt>
            <dd>{Math.round(offlineSummary.requestedMs / 1000)}s</dd>
            <dt>Simulated</dt>
            <dd>{Math.round(offlineSummary.simulatedMs / 1000)}s</dd>
            <dt>Remaining</dt>
            <dd>{Math.round(offlineSummary.remainingMs / 1000)}s</dd>
            <dt>Overflow</dt>
            <dd>{Math.round(offlineSummary.overflowMs / 1000)}s</dd>
          </dl>
        </section>
      ) : null}

      <EventInspector events={events} backPressure={backPressure} />
    </main>
  );
}
