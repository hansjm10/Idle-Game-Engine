import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ErrorBoundary } from './ErrorBoundary.js';

/**
 * Component that throws an error when throwError prop is true.
 */
function ThrowError({ throwError, message }: { throwError: boolean; message?: string }): JSX.Element {
  if (throwError) {
    throw new Error(message || 'Test error');
  }
  return <div>Child component</div>;
}

describe('ErrorBoundary', () => {
  let telemetryEvents: Array<{ type: 'error' | 'event'; name: string; data: Record<string, unknown> }>;

  beforeEach(() => {
    // Setup telemetry spy
    telemetryEvents = [];
    (globalThis as any).__IDLE_ENGINE_TELEMETRY__ = {
      recordError: (event: string, data: Record<string, unknown>) => {
        telemetryEvents.push({ type: 'error', name: event, data });
      },
      recordEvent: (event: string, data: Record<string, unknown>) => {
        telemetryEvents.push({ type: 'event', name: event, data });
      },
    };

    // Suppress console.error in tests (ErrorBoundary logs to console)
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as any).__IDLE_ENGINE_TELEMETRY__;
    vi.restoreAllMocks();
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('Test content')).toBeInTheDocument();
  });

  it('catches errors and displays default fallback UI', () => {
    render(
      <ErrorBoundary>
        <ThrowError throwError={true} message="Something broke" />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Something broke')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('records telemetry when error is caught', () => {
    render(
      <ErrorBoundary boundaryName="TestBoundary">
        <ThrowError throwError={true} message="Test error" />
      </ErrorBoundary>,
    );

    expect(telemetryEvents).toHaveLength(1);
    expect(telemetryEvents[0]).toMatchObject({
      type: 'error',
      name: 'ErrorBoundaryCaughtError',
      data: expect.objectContaining({
        boundaryName: 'TestBoundary',
        errorMessage: 'Test error',
        errorName: 'Error',
      }),
    });
  });

  it('uses default boundary name when not provided', () => {
    render(
      <ErrorBoundary>
        <ThrowError throwError={true} />
      </ErrorBoundary>,
    );

    expect(telemetryEvents[0]?.data.boundaryName).toBe('ErrorBoundary');
  });

  it('calls onError callback when error is caught', () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowError throwError={true} message="Callback test" />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Callback test' }),
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it('retries rendering when retry button is clicked', async () => {
    const user = userEvent.setup();
    let shouldThrow = true;

    const { rerender } = render(
      <ErrorBoundary>
        <ThrowError throwError={shouldThrow} />
      </ErrorBoundary>,
    );

    // Error is displayed
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Fix the error condition
    shouldThrow = false;

    // Click retry button
    const retryButton = screen.getByRole('button', { name: /try again/i });
    await user.click(retryButton);

    // Rerender with fixed condition
    rerender(
      <ErrorBoundary>
        <ThrowError throwError={shouldThrow} />
      </ErrorBoundary>,
    );

    // Child should render successfully now
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Child component')).toBeInTheDocument();
  });

  it('records telemetry when retry button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary boundaryName="TestBoundary">
        <ThrowError throwError={true} />
      </ErrorBoundary>,
    );

    const retryButton = screen.getByRole('button', { name: /try again/i });
    await user.click(retryButton);

    const retryEvent = telemetryEvents.find((e) => e.name === 'ErrorBoundaryRetryClicked');
    expect(retryEvent).toBeDefined();
    expect(retryEvent?.data.boundaryName).toBe('TestBoundary');
  });

  it('dismisses error when dismiss button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary>
        <ThrowError throwError={true} />
      </ErrorBoundary>,
    );

    // Error is displayed
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Click dismiss button
    const dismissButton = screen.getByRole('button', { name: /dismiss/i });
    await user.click(dismissButton);

    // Error should be dismissed
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('records telemetry when dismiss button is clicked', async () => {
    const user = userEvent.setup();

    render(
      <ErrorBoundary boundaryName="TestBoundary">
        <ThrowError throwError={true} />
      </ErrorBoundary>,
    );

    const dismissButton = screen.getByRole('button', { name: /dismiss/i });
    await user.click(dismissButton);

    const dismissEvent = telemetryEvents.find((e) => e.name === 'ErrorBoundaryDismissClicked');
    expect(dismissEvent).toBeDefined();
    expect(dismissEvent?.data.boundaryName).toBe('TestBoundary');
  });

  it('renders custom fallback when provided', () => {
    const customFallback = (error: Error, retry: () => void, dismiss: () => void) => (
      <div data-testid="custom-fallback">
        <p>Custom error: {error.message}</p>
        <button onClick={retry}>Custom Retry</button>
        <button onClick={dismiss}>Custom Dismiss</button>
      </div>
    );

    render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowError throwError={true} message="Custom fallback test" />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
    expect(screen.getByText('Custom error: Custom fallback test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /custom retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /custom dismiss/i })).toBeInTheDocument();
  });

  it('custom fallback retry calls the correct handler', async () => {
    const user = userEvent.setup();
    let shouldThrow = true;

    const customFallback = (_error: Error, retry: () => void) => (
      <button onClick={retry}>Custom Retry</button>
    );

    const { rerender } = render(
      <ErrorBoundary fallback={customFallback}>
        <ThrowError throwError={shouldThrow} />
      </ErrorBoundary>,
    );

    // Click custom retry button
    const retryButton = screen.getByRole('button', { name: /custom retry/i });
    await user.click(retryButton);

    // Fix the error condition and rerender
    shouldThrow = false;
    rerender(
      <ErrorBoundary fallback={customFallback}>
        <ThrowError throwError={shouldThrow} />
      </ErrorBoundary>,
    );

    // Should render child successfully
    expect(screen.getByText('Child component')).toBeInTheDocument();
  });

  it('handles errors with no message gracefully', () => {
    render(
      <ErrorBoundary>
        <ThrowError throwError={true} message="" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
  });

  it('includes component stack in telemetry', () => {
    render(
      <ErrorBoundary>
        <ThrowError throwError={true} />
      </ErrorBoundary>,
    );

    expect(telemetryEvents[0]?.data.componentStack).toBeDefined();
    expect(typeof telemetryEvents[0]?.data.componentStack).toBe('string');
  });

  it('logs error to console', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error');

    render(
      <ErrorBoundary boundaryName="TestBoundary">
        <ThrowError throwError={true} message="Console log test" />
      </ErrorBoundary>,
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
    const logCall = consoleErrorSpy.mock.calls.find((call) =>
      call[0]?.toString().includes('TestBoundary'),
    );
    expect(logCall).toBeDefined();
  });
});
