import './modules/process-shim.js';
import './variables.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './modules/App';
import { ErrorBoundary } from './modules/ErrorBoundary';
import styles from './main.module.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary
      boundaryName="ShellRoot"
      fallback={(error, retry) => (
        <div
          role="alert"
          aria-live="assertive"
          className={styles.rootErrorContainer}
        >
          <div className={styles.rootErrorCard}>
            <h1 className={styles.rootErrorHeading}>
              Application Error
            </h1>
            <p className={styles.rootErrorDescription}>
              The Idle Engine shell encountered a critical error and cannot continue.
            </p>
            <p className={styles.rootErrorMessage}>
              <strong>Error:</strong> {error.message}
            </p>
            <button
              onClick={retry}
              className={styles.rootErrorButton}
              type="button"
            >
              Reload Application
            </button>
          </div>
        </div>
      )}
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
