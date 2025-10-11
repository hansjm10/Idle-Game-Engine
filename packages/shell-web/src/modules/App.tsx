import { useEffect, useState } from 'react';

import {
  useWorkerBridge,
  type RuntimeStateSnapshot,
} from './worker-bridge.js';

export function App() {
  const bridge = useWorkerBridge();
  const [currentStep, setCurrentStep] = useState(0);

  useEffect(() => {
    const handleState = (state: RuntimeStateSnapshot) => {
      setCurrentStep(state.currentStep);
    };

    bridge.onStateUpdate(handleState);
    return () => {
      bridge.offStateUpdate(handleState);
    };
  }, [bridge]);

  const handleSendCommand = () => {
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
    </main>
  );
}
