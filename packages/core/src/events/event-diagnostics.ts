import { telemetry } from '../telemetry.js';
import type { RuntimeEventType } from './runtime-event.js';

export type SoftLimitReason = 'soft-limit' | 'rate-per-second';

export interface EventDiagnosticsContext {
  readonly channel: number;
  readonly tick: number;
  readonly eventType: RuntimeEventType;
  readonly timestamp: number;
  readonly reason: SoftLimitReason;
  readonly bufferSize?: number;
  readonly capacity?: number;
  readonly softLimit?: number;
  readonly remainingCapacity?: number;
  readonly eventsPerSecond?: number;
  readonly maxEventsPerSecond?: number;
}

export interface EventDiagnosticsChannelConfig {
  readonly maxEventsPerTick: number;
  readonly maxEventsPerSecond?: number;
  readonly cooldownTicks: number;
  readonly maxCooldownTicks: number;
}

export interface EventDiagnosticsChannelSnapshot {
  readonly channel: number;
  readonly cooldownTicksRemaining: number;
  readonly breaches: number;
  readonly eventsPerSecond: number;
}

interface ChannelState {
  readonly config: EventDiagnosticsChannelConfig;
  readonly timestamps: number[];
  startIndex: number;
  nextLogTick: number;
  currentCooldown: number;
  cooldownTicksRemaining: number;
  breaches: number;
  eventsPerSecond: number;
}

const RATE_WINDOW_MS = 1000;
const COOLDOWN_MULTIPLIER = 2;

export class EventDiagnostics {
  private readonly channels: Array<ChannelState | null>;

  constructor(configs: ReadonlyArray<EventDiagnosticsChannelConfig | null>) {
    this.channels = configs.map((config) => {
      if (!config) {
        return null;
      }

      return {
        config,
        timestamps: [],
        startIndex: 0,
        nextLogTick: 0,
        currentCooldown: config.cooldownTicks,
        cooldownTicksRemaining: 0,
        breaches: 0,
        eventsPerSecond: 0,
      };
    });
  }

  beginTick(tick: number): void {
    for (const channel of this.channels) {
      if (!channel) {
        continue;
      }

      if (tick > channel.nextLogTick) {
        channel.currentCooldown = channel.config.cooldownTicks;
      }

      channel.cooldownTicksRemaining = Math.max(
        0,
        channel.nextLogTick - tick,
      );
    }
  }

  recordPublish(
    channelIndex: number,
    tick: number,
    timestamp: number,
    eventType: RuntimeEventType,
  ): void {
    const channel = this.channels[channelIndex];
    if (!channel) {
      return;
    }

    const { timestamps } = channel;
    timestamps.push(timestamp);

    const cutoff = timestamp - RATE_WINDOW_MS;
    while (
      channel.startIndex < timestamps.length &&
      timestamps[channel.startIndex] <= cutoff
    ) {
      channel.startIndex += 1;
    }

    if (channel.startIndex > 64) {
      timestamps.splice(0, channel.startIndex);
      channel.startIndex = 0;
    }

    const activeCount = timestamps.length - channel.startIndex;
    channel.eventsPerSecond = activeCount;

    const maxPerSecond = channel.config.maxEventsPerSecond;
    if (
      typeof maxPerSecond === 'number' &&
      maxPerSecond > 0 &&
      activeCount >= maxPerSecond
    ) {
      this.logBreach({
        channel: channelIndex,
        tick,
        eventType,
        timestamp,
        reason: 'rate-per-second',
        eventsPerSecond: activeCount,
        maxEventsPerSecond: maxPerSecond,
      });
    }
  }

  handleSoftLimit(context: EventDiagnosticsContext): void {
    const { channel } = context;
    if (!this.channels[channel]) {
      return;
    }

    this.logBreach({
      ...context,
      reason: 'soft-limit',
    });
  }

  getChannelSnapshot(
    channelIndex: number,
    tick: number,
  ): EventDiagnosticsChannelSnapshot | null {
    const channel = this.channels[channelIndex];
    if (!channel) {
      return null;
    }

    const cooldownTicksRemaining = Math.max(
      0,
      channel.nextLogTick - tick,
    );

    return {
      channel: channelIndex,
      cooldownTicksRemaining,
      breaches: channel.breaches,
      eventsPerSecond: channel.eventsPerSecond,
    };
  }

  private logBreach(context: EventDiagnosticsContext): void {
    const channel = this.channels[context.channel];
    if (!channel) {
      return;
    }

    const { tick } = context;
    if (tick < channel.nextLogTick) {
      channel.cooldownTicksRemaining = Math.max(
        0,
        channel.nextLogTick - tick,
      );
      return;
    }

    telemetry.recordWarning('EventSoftLimitBreach', {
      channel: context.channel,
      tick: context.tick,
      reason: context.reason,
      eventType: context.eventType,
      bufferSize: context.bufferSize,
      capacity: context.capacity,
      softLimit: context.softLimit,
      remainingCapacity: context.remainingCapacity,
      eventsPerSecond: context.eventsPerSecond,
      maxEventsPerSecond: context.maxEventsPerSecond,
      cooldownTicks: channel.currentCooldown,
    });

    telemetry.recordCounters('events.soft_limit_breaches', {
      [`channel:${context.channel}`]: 1,
    });

    channel.breaches += 1;
    channel.nextLogTick = tick + channel.currentCooldown;
    channel.cooldownTicksRemaining = channel.currentCooldown;
    channel.currentCooldown = Math.min(
      channel.currentCooldown * COOLDOWN_MULTIPLIER,
      channel.config.maxCooldownTicks,
    );
  }
}
