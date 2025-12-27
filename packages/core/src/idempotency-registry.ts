import type { CommandResponse } from './command-transport.js';

export interface IdempotencyRegistry {
  get(key: string): CommandResponse | undefined;
  record(key: string, response: CommandResponse, expiresAt: number): void;
  purgeExpired(now: number): void;
  size(): number;
}

interface RegistryEntry {
  readonly response: CommandResponse;
  readonly expiresAt: number;
}

export class InMemoryIdempotencyRegistry implements IdempotencyRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  get(key: string): CommandResponse | undefined {
    return this.entries.get(key)?.response;
  }

  record(key: string, response: CommandResponse, expiresAt: number): void {
    this.entries.set(key, { response, expiresAt });
  }

  purgeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  size(): number {
    return this.entries.size;
  }
}
