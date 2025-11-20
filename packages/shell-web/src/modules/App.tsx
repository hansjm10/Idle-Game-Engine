import { useCallback, useState, type JSX } from 'react';
import { sampleContent } from '@idle-engine/content-sample';

import { EventInspector } from './EventInspector.js';
import { SocialDevPanel } from './SocialDevPanel.js';
import { PersistenceIntegration } from './PersistenceIntegration.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { ResourceDashboard } from './ResourceDashboard.js';
import { GeneratorPanel } from './GeneratorPanel.js';
import { UpgradeModal } from './UpgradeModal.js';
import { DiagnosticsPanel } from './DiagnosticsPanel.js';
import { EconomyPreviewPanel } from './EconomyPreviewPanel.js';
import {
  ShellStateProvider,
  useShellBridge,
  useShellState,
  useShellProgression,
} from './ShellStateProvider.js';
import errorStyles from './ErrorBoundary.module.css';
import appStyles from './App.module.css';
import { isEconomyPreviewEnabled } from './economy-preview-config.js';

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
  const progression = useShellProgression();
  const economyPreviewEnabled = isEconomyPreviewEnabled();
  const [isUpgradeOpen, setUpgradeOpen] = useState(false);

  const handleSendCommand = useCallback(async () => {
    await bridge.awaitReady();
    bridge.sendCommand('PING', { issuedAt: performance.now() });
  }, [bridge]);

  return (
    <main className={appStyles.main}>
      <h1>Idle Engine Shell</h1>
      <p>
        Placeholder web shell wired to the Worker runtime tick loop. Runtime step:{' '}
        <strong>{runtime.currentStep}</strong>.
      </p>
      <button onClick={handleSendCommand} type="button">
        Send Test Command
      </button>

      <ResourceDashboard />
      {economyPreviewEnabled ? <EconomyPreviewPanel /> : null}
      {progression.isEnabled ? (
        <>
          <GeneratorPanel />
          <div style={{ marginTop: '0.5rem' }}>
            <button type="button" onClick={() => setUpgradeOpen(true)}>
              Open Upgrades
            </button>
          </div>
          <UpgradeModal open={isUpgradeOpen} onClose={() => setUpgradeOpen(false)} />
        </>
      ) : null}

      <EventInspector />

      <DiagnosticsPanel />

      {socialEnabled ? <SocialDevPanel /> : null}

      <ErrorBoundary
        boundaryName="PersistenceUI"
        fallback={(error, retry, dismiss) => (
          <div
            role="alert"
            aria-live="assertive"
            className={errorStyles.errorAlert}
          >
            <h3 className={errorStyles.errorHeading}>
              Persistence System Error
            </h3>
            <p className={errorStyles.errorMessage}>
              The save/load system encountered an error: {error.message}
            </p>
            <p className={appStyles.persistenceWarning}>
              You can continue playing, but save/load features may be unavailable.
            </p>
            <div className={errorStyles.errorActions}>
              <button
                onClick={retry}
                className={errorStyles.retryButton}
                type="button"
              >
                Retry
              </button>
              <button
                onClick={dismiss}
                className={errorStyles.dismissButton}
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
