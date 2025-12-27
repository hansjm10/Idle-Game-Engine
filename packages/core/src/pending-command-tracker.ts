import {
  DEFAULT_PENDING_COMMAND_TIMEOUT_MS,
  type CommandEnvelope,
  type CommandResponse,
} from './command-transport.js';

export interface PendingCommandTracker {
  track(envelope: CommandEnvelope): void;
  resolve(response: CommandResponse): void;
  expire(now: number): CommandEnvelope[];
  getPending(): readonly CommandEnvelope[];
}

export interface PendingCommandTrackerOptions {
  readonly timeoutMs?: number;
}

interface PendingEntry {
  readonly envelope: CommandEnvelope;
  readonly expiresAt: number;
}

export class InMemoryPendingCommandTracker implements PendingCommandTracker {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly timeoutMs: number;

  constructor(options: PendingCommandTrackerOptions = {}) {
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_PENDING_COMMAND_TIMEOUT_MS;
  }

  track(envelope: CommandEnvelope): void {
    const expiresAt = envelope.sentAt + this.timeoutMs;
    this.entries.set(envelope.requestId, {
      envelope,
      expiresAt,
    });
  }

  resolve(response: CommandResponse): void {
    this.entries.delete(response.requestId);
  }

  expire(now: number): CommandEnvelope[] {
    const expired: CommandEnvelope[] = [];

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        expired.push(entry.envelope);
        this.entries.delete(key);
      }
    }

    return expired;
  }

  getPending(): readonly CommandEnvelope[] {
    return Array.from(
      this.entries.values(),
      (entry) => entry.envelope,
    );
  }
}
