import type { ReactNode } from 'react';

import type { BackPressureSnapshot } from '@idle-engine/core';

import type { RuntimeEventSnapshot } from './worker-bridge.js';

interface EventInspectorProps {
  readonly events: readonly RuntimeEventSnapshot[];
  readonly backPressure: BackPressureSnapshot | null;
}

export function EventInspector({
  events,
  backPressure,
}: EventInspectorProps): JSX.Element {
  const counters = backPressure?.counters;
  const channels = backPressure?.channels ?? [];

  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Event Inspector</h2>

      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          fontSize: 14,
          marginBottom: 16,
        }}
      >
        <Metric label="Published" value={counters?.published ?? 0} />
        <Metric label="Soft Limited" value={counters?.softLimited ?? 0} />
        <Metric label="Overflowed" value={counters?.overflowed ?? 0} />
        <Metric label="Subscribers" value={counters?.subscribers ?? 0} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>Channel Status</h3>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {channels.map((channel) => {
            const isOverflow = channel.remainingCapacity === 0;
            const isSoftLimited = channel.softLimitActive && !isOverflow;
            const tone = isOverflow
              ? '#b00020'
              : isSoftLimited
                ? '#b36a00'
                : '#3a3a3a';
            const cooldownText =
              channel.cooldownTicksRemaining > 0
                ? `cooldown ${channel.cooldownTicksRemaining} ticks`
                : 'cooldown idle';
            const breachText = `${channel.softLimitBreaches} warnings`;
            const rateText = `${Math.round(channel.eventsPerSecond)} events/s`;

            return (
              <li
                key={channel.channel}
                style={{
                  marginBottom: 4,
                  fontFamily: 'monospace',
                  color: tone,
                }}
              >
                <strong>{channel.type}</strong> — capacity {channel.capacity},{' '}
                {channel.inUse} in buffer, {channel.remainingCapacity} remaining{' '}
                {isOverflow
                  ? '(overflow)'
                  : isSoftLimited
                    ? '(soft limit active)'
                    : ''}
                {`. ${cooldownText}, ${breachText}, ${rateText}`}
              </li>
            );
          })}
          {channels.length === 0 ? (
            <li style={{ color: '#555' }}>No event channels registered.</li>
          ) : null}
        </ul>
      </div>

      <div>
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>Recent Events</h3>
        {events.length === 0 ? (
          <p style={{ color: '#555', fontSize: 14 }}>No events recorded yet.</p>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
            }}
          >
            <thead>
              <tr>
                <Th>Tick</Th>
                <Th>Channel</Th>
                <Th>Type</Th>
                <Th>Order</Th>
                <Th>Issued At</Th>
                <Th>Payload</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={`${event.tick}:${event.dispatchOrder}:${event.type}`}>
                  <Td>{event.tick}</Td>
                  <Td>{event.channel}</Td>
                  <Td>{event.type}</Td>
                  <Td>{event.dispatchOrder}</Td>
                  <Td>{event.issuedAt.toFixed(2)}</Td>
                  <Td>{formatPayload(event.payload)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function formatPayload(payload: unknown): string {
  try {
    if (
      payload === null ||
      typeof payload === 'string' ||
      typeof payload === 'number' ||
      typeof payload === 'boolean'
    ) {
      return String(payload);
    }
    return JSON.stringify(payload);
  } catch (error) {
    return `[unserializable: ${(error as Error).message}]`;
  }
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div>
      <div style={{ fontSize: 12, color: '#555', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Th({ children }: { children: ReactNode }): JSX.Element {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '6px 8px',
        borderBottom: '1px solid #ddd',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: ReactNode }): JSX.Element {
  return (
    <td
      style={{
        padding: '6px 8px',
        borderBottom: '1px solid #f0f0f0',
        verticalAlign: 'top',
        fontFamily: 'monospace',
      }}
    >
      {children}
    </td>
  );
}
