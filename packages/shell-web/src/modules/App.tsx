import { useCallback } from 'react';
import { sampleContent } from '@idle-engine/content-sample';

import { EventInspector } from './EventInspector.js';
import { SocialDevPanel } from './SocialDevPanel.js';
import { PersistenceIntegration } from './PersistenceIntegration.js';
import { ErrorBoundary } from './ErrorBoundary.js';
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

      <ErrorBoundary
        boundaryName="PersistenceUI"
        fallback={(error, retry, dismiss) => (
          <div
            role="alert"
            aria-live="assertive"
            style={{
              padding: '1rem',
              margin: '1rem 0',
              border: '2px solid #dc2626',
              borderRadius: '0.5rem',
              backgroundColor: '#fef2f2',
              color: '#991b1b',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.125rem', fontWeight: 600 }}>
              Persistence System Error
            </h3>
            <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem' }}>
              The save/load system encountered an error: {error.message}
            </p>
            <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#7c2d12' }}>
              You can continue playing, but save/load features may be unavailable.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={retry}
                style={{
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: '#fff',
                  backgroundColor: '#dc2626',
                  border: 'none',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                }}
                type="button"
              >
                Retry
              </button>
              <button
                onClick={dismiss}
                style={{
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: '#991b1b',
                  backgroundColor: 'transparent',
                  border: '1px solid #991b1b',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                }}
                type="button"
              >
                Hide
              </button>
            </div>
          </div>
        )}
      >
        <PersistenceIntegration
          bridge={bridge}
          definitions={sampleContent.resources}
        />
      </ErrorBoundary>
    </main>
  );
}
