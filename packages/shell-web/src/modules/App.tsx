import { useCallback } from 'react';

import { EventInspector } from './EventInspector.js';
import { SocialDevPanel } from './SocialDevPanel.js';
import {
  ShellStateProvider,
  useShellBridge,
  useShellState,
} from './ShellStateProvider.js';

const EVENT_HISTORY_LIMIT = 50;

export function App() {
  return (
    <ShellStateProvider maxEventHistory={EVENT_HISTORY_LIMIT}>
      <ShellAppSurface />
    </ShellStateProvider>
  );
}

function ShellAppSurface(): JSX.Element {
  const { runtime } = useShellState();
  const bridge = useShellBridge();
  const socialEnabled = bridge.isSocialFeatureEnabled();

  const handleSendCommand = useCallback(async () => {
    await bridge.awaitReady();
    bridge.sendCommand('PING', { issuedAt: performance.now() });
  }, [bridge]);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Idle Engine Shell</h1>
      <p>
        Placeholder web shell wired to the Worker runtime tick loop. Runtime step:{' '}
        <strong>{runtime.currentStep}</strong>.
      </p>
      <button onClick={handleSendCommand} type="button">
        Send Test Command
      </button>

      <EventInspector />

      {socialEnabled ? <SocialDevPanel /> : null}
    </main>
  );
}
