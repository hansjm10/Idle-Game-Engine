import './modules/process-shim.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './modules/App';
import { ErrorBoundary } from './modules/ErrorBoundary';

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
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '2rem',
            fontFamily: 'system-ui',
            backgroundColor: '#fef2f2',
          }}
        >
          <div
            style={{
              maxWidth: '32rem',
              padding: '2rem',
              border: '2px solid #dc2626',
              borderRadius: '0.5rem',
              backgroundColor: '#fff',
            }}
          >
            <h1 style={{ margin: '0 0 1rem 0', fontSize: '1.5rem', fontWeight: 700, color: '#991b1b' }}>
              Application Error
            </h1>
            <p style={{ margin: '0 0 1rem 0', fontSize: '1rem', color: '#7c2d12' }}>
              The Idle Engine shell encountered a critical error and cannot continue.
            </p>
            <p style={{ margin: '0 0 1.5rem 0', fontSize: '0.875rem', color: '#991b1b' }}>
              <strong>Error:</strong> {error.message}
            </p>
            <button
              onClick={retry}
              style={{
                width: '100%',
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                fontWeight: 600,
                color: '#fff',
                backgroundColor: '#dc2626',
                border: 'none',
                borderRadius: '0.375rem',
                cursor: 'pointer',
              }}
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
