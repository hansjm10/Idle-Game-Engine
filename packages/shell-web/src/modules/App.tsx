import { useEffect, useState } from 'react';

import type { BackPressureSnapshot } from '@idle-engine/core';

import {
  type RuntimeEventSnapshot,
  useWorkerBridge,
  type RuntimeStateSnapshot,
} from './worker-bridge.js';
import { EventInspector } from './EventInspector.js';
import { SocialDevPanel } from './SocialDevPanel.js';

const MAX_EVENT_HISTORY = 50;

export function App() {
  const bridge = useWorkerBridge();
  const socialEnabled = bridge.isSocialFeatureEnabled();
  const [currentStep, setCurrentStep] = useState(0);
  const [events, setEvents] = useState<RuntimeEventSnapshot[]>([]);
  const [backPressure, setBackPressure] = useState<BackPressureSnapshot | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    bridge
      .restoreSession()
      .catch((error) => {
        if (!cancelled) {
          console.error('[App] Failed to restore worker session', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

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

  const handleSendCommand = async () => {
    await bridge.awaitReady();
    bridge.sendCommand('PING', { issuedAt: performance.now() });
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

      <EventInspector events={events} backPressure={backPressure} />

      {socialEnabled ? <SocialDevPanel bridge={bridge} /> : null}
    </main>
  );
}
