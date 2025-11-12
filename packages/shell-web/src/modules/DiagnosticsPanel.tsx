import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { DiagnosticTimelineEntry, DiagnosticTimelineResult } from '@idle-engine/core';
import { summarizeDiagnostics } from '@idle-engine/core';
import { useShellDiagnostics } from './ShellStateProvider.js';

const DEFAULT_THROTTLE_MS = 250;

function useThrottledTimeline(latest: DiagnosticTimelineResult | null, throttleMs = DEFAULT_THROTTLE_MS) {
  const [visible, setVisible] = useState<DiagnosticTimelineResult | null>(null);
  const lastUpdateRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!latest) return;
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;
    if (elapsed >= throttleMs) {
      lastUpdateRef.current = now;
      setVisible(latest);
      return;
    }
    if (timerRef.current !== null) return;
    const remaining = throttleMs - elapsed;
    timerRef.current = window.setTimeout(() => {
      lastUpdateRef.current = Date.now();
      setVisible(latest);
      timerRef.current = null;
    }, Math.max(remaining, 0));
  }, [latest, throttleMs]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return visible;
}

export function DiagnosticsPanel(): JSX.Element | null {
  const diagnostics = useShellDiagnostics();
  const [isOpen, setOpen] = useState(false);
  const [latest, setLatest] = useState<DiagnosticTimelineResult | null>(diagnostics.latest);

  useEffect(() => {
    if (!isOpen) return;
    return diagnostics.subscribe((timeline) => setLatest(timeline));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const visible = useThrottledTimeline(latest);
  const summary = useMemo(() => (visible ? summarizeDiagnostics(visible) : null), [visible]);
  const last = summary?.last;

  const handleToggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <section aria-live="polite" style={{ marginTop: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button type="button" onClick={handleToggle} aria-pressed={isOpen}>
          {isOpen ? 'Hide Diagnostics' : 'Show Diagnostics'}
        </button>
        <span style={{ fontSize: '0.9rem', opacity: 0.8 }}>
          {diagnostics.isEnabled ? 'Diagnostics enabled' : 'Diagnostics idle'}
        </span>
      </div>

      {!isOpen ? null : (
        <div style={{ marginTop: '0.75rem', border: '1px solid var(--border-color,#ddd)', padding: '0.75rem', borderRadius: 6 }}>
          <h3 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Runtime Diagnostics</h3>
          {summary ? (
            <>
              <KV label="Head" value={String(summary.head)} />
              <KV label="Entries" value={String(summary.totalEntries)} />
              <KV label="Dropped" value={String(summary.dropped)} />
              <KV label="Slow Ticks" value={String(summary.slowTickCount)} />

              <Divider />
              <TickBar entry={last} budgetMs={summary.configuration.tickBudgetMs} />
              <Divider />
              <QueueStats entry={last} />
            </>
          ) : (
            <p style={{ margin: 0 }}>Waiting for diagnostics…</p>
          )}
        </div>
      )}
    </section>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
      <div style={{ width: 140, color: 'var(--text-muted,#555)' }}>{label}</div>
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{value}</div>
    </div>
  );
}

function Divider() {
  return <hr style={{ border: 0, borderTop: '1px solid var(--border-color,#eee)', margin: '0.5rem 0' }} />;
}

function TickBar({ entry, budgetMs }: { entry?: DiagnosticTimelineEntry; budgetMs?: number }) {
  if (!entry) return null;
  const duration = entry.durationMs;
  const budget = typeof budgetMs === 'number' && budgetMs > 0 ? budgetMs : Math.max(duration, 1);
  const ratio = Math.min(1, duration / budget);
  const over = duration > budget;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem' }}>
        <strong>Last Tick</strong>
        <span>{duration.toFixed(2)} ms {over ? '(over budget)' : ''}</span>
      </div>
      <div style={{ background: '#eee', height: 8, borderRadius: 4, overflow: 'hidden' }} aria-hidden="true">
        <div style={{ width: `${ratio * 100}%`, height: '100%', background: over ? '#d9534f' : '#5cb85c' }} />
      </div>
    </div>
  );
}

function QueueStats({ entry }: { entry?: DiagnosticTimelineEntry }) {
  if (!entry?.metadata?.queue) return null;
  const q = entry.metadata.queue;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
      <Stat label="Captured" value={q.captured} />
      <Stat label="Executed" value={q.executed} />
      <Stat label="Skipped" value={q.skipped} />
      <Stat label="Size Before" value={q.sizeBefore} />
      <Stat label="Size After" value={q.sizeAfter} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: '0.25rem 0' }}>
      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted,#555)' }}>{label}</div>
      <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{value}</div>
    </div>
  );
}

