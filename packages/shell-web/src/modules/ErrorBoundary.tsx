import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Telemetry facade interface for recording error boundary events.
 */
type TelemetryFacade = {
  recordError?: (event: string, data?: Record<string, unknown>) => void;
  recordEvent?: (event: string, data?: Record<string, unknown>) => void;
};

function getTelemetryFacade(): TelemetryFacade | undefined {
  return (globalThis as { __IDLE_ENGINE_TELEMETRY__?: TelemetryFacade })
    .__IDLE_ENGINE_TELEMETRY__;
}

function recordTelemetryError(
  event: string,
  data: Record<string, unknown>,
): void {
  getTelemetryFacade()?.recordError?.(event, data);
}

/**
 * Props for ErrorBoundary component.
 */
export interface ErrorBoundaryProps {
  /**
   * Children to render when no error has occurred.
   */
  children: ReactNode;

  /**
   * Optional fallback UI to render when an error is caught.
   * If not provided, a default fallback will be used.
   */
  fallback?: (error: Error, retry: () => void, dismiss: () => void) => ReactNode;

  /**
   * Optional callback invoked when an error is caught.
   */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;

  /**
   * Optional name for this error boundary (used in telemetry).
   */
  boundaryName?: string;
}

/**
 * State for ErrorBoundary component.
 */
interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  resetKey: number;
}

/**
 * ErrorBoundary component that catches React rendering errors and displays a fallback UI.
 *
 * Features:
 * - Catches render-time errors in child components
 * - Provides fallback UI with retry and dismiss actions
 * - Integrates with telemetry to log errors
 * - Supports custom fallback rendering
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary boundaryName="PersistenceUI">
 *   <PersistenceIntegration />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      resetKey: 0,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { boundaryName = 'ErrorBoundary', onError } = this.props;

    // Update state with error info
    this.setState({ errorInfo });

    // Record telemetry
    recordTelemetryError('ErrorBoundaryCaughtError', {
      boundaryName,
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack,
      componentStack: errorInfo.componentStack,
    });

    // Log to console for debugging
    // eslint-disable-next-line no-console
    console.error(`[${boundaryName}] Caught error:`, error, errorInfo);

    // Call optional error handler
    onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    const { boundaryName = 'ErrorBoundary' } = this.props;

    recordTelemetryError('ErrorBoundaryRetryClicked', {
      boundaryName,
    });

    // Reset error state and increment key to force remount
    this.setState((prevState) => ({
      hasError: false,
      error: null,
      errorInfo: null,
      resetKey: prevState.resetKey + 1,
    }));
  };

  handleDismiss = (): void => {
    const { boundaryName = 'ErrorBoundary' } = this.props;

    recordTelemetryError('ErrorBoundaryDismissClicked', {
      boundaryName,
    });

    // Reset error state and increment key to force remount
    this.setState((prevState) => ({
      hasError: false,
      error: null,
      errorInfo: null,
      resetKey: prevState.resetKey + 1,
    }));
  };

  render(): ReactNode {
    const { hasError, error, resetKey } = this.state;
    const { children, fallback } = this.props;

    if (hasError && error) {
      // Use custom fallback if provided
      if (fallback) {
        return fallback(error, this.handleRetry, this.handleDismiss);
      }

      // Default fallback UI
      return (
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
            Something went wrong
          </h3>
          <p style={{ margin: '0 0 1rem 0', fontSize: '0.875rem' }}>
            {error.message || 'An unexpected error occurred'}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={this.handleRetry}
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
              Try Again
            </button>
            <button
              onClick={this.handleDismiss}
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
              Dismiss
            </button>
          </div>
        </div>
      );
    }

    // Use key to force remount after retry/dismiss
    return <div key={resetKey}>{children}</div>;
  }
}
