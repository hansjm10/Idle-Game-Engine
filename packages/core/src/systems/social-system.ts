import type {
  SocialIntentQueuedEventPayload,
  SocialIntentResolvedEventPayload,
} from '../events/runtime-event-catalog.js';
import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';

export type SocialIntentStatus = 'queued' | 'confirming' | 'confirmed' | 'rejected';

export interface SocialIntentDefinition<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
  readonly issuedAt?: number;
}

export interface SocialIntentRecord<TPayload = unknown> extends SocialIntentDefinition<TPayload> {
  readonly id: string;
  readonly issuedAt: number;
  status: SocialIntentStatus;
  readonly enqueuedStep: number;
  lastConfirmedAt?: number;
  confirmationPayload?: Record<string, unknown>;
  dirtyReason?: 'queued' | 'status';
}

export interface SocialConfirmation<TPayload = unknown> {
  readonly intentId: string;
  readonly status: Extract<SocialIntentStatus, 'confirmed' | 'rejected'>;
  readonly confirmedAt: number;
  readonly payload?: TPayload;
}

export interface SocialProvider {
  pullConfirmations(
    intents: readonly SocialIntentRecord[],
  ): readonly SocialConfirmation[];
}

export class SocialIntentQueue {
  private readonly intents = new Map<string, SocialIntentRecord>();
  private readonly order: string[] = [];
  private sequence = 0;
  private readonly dirty: Set<string> = new Set();

  constructor(private readonly clock: () => number = () => Date.now()) {}

  queue<TPayload>(definition: SocialIntentDefinition<TPayload>, step: number): SocialIntentRecord<TPayload> {
    const id = this.createIntentId();
    const issuedAt = definition.issuedAt ?? this.clock();
    const record: SocialIntentRecord<TPayload> = {
      id,
      type: definition.type,
      payload: definition.payload,
      issuedAt,
      status: 'queued',
      enqueuedStep: step,
      dirtyReason: 'queued',
    };
    this.intents.set(id, record);
    this.insertIntent(record);
    this.dirty.add(id);
    return record;
  }

  list(): readonly SocialIntentRecord[] {
    return this.order.map((id) => this.intents.get(id)!).filter(Boolean);
  }

  consumeDirty(): readonly SocialIntentRecord[] {
    if (this.dirty.size === 0) {
      return [];
    }
    const items: SocialIntentRecord[] = [];
    for (const id of this.dirty) {
      const intent = this.intents.get(id);
      if (intent) {
        items.push(intent);
        intent.dirtyReason = undefined;
      }
    }
    this.dirty.clear();
    items.sort(compareIntents);
    return items;
  }

  applyConfirmation(confirmation: SocialConfirmation): SocialIntentRecord | undefined {
    const intent = this.intents.get(confirmation.intentId);
    if (!intent) {
      return undefined;
    }

    if (
      intent.lastConfirmedAt !== undefined &&
      intent.lastConfirmedAt > confirmation.confirmedAt
    ) {
      return undefined;
    }

    if (intent.status === confirmation.status && intent.lastConfirmedAt === confirmation.confirmedAt) {
      return undefined;
    }

    intent.status = confirmation.status;
    intent.lastConfirmedAt = confirmation.confirmedAt;
    intent.confirmationPayload = toRecord(confirmation.payload);
    intent.dirtyReason = 'status';
    this.dirty.add(intent.id);
    return intent;
  }

  pruneResolved(): void {
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const id = this.order[index]!;
      const intent = this.intents.get(id);
      if (!intent) {
        this.order.splice(index, 1);
        continue;
      }
      if (intent.status === 'confirmed' || intent.status === 'rejected') {
        this.intents.delete(id);
        this.order.splice(index, 1);
      }
    }
  }

  private createIntentId(): string {
    const sequence = (this.sequence += 1);
    return `${sequence.toString(36)}`;
  }

  private insertIntent(record: SocialIntentRecord): void {
    let low = 0;
    let high = this.order.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const current = this.intents.get(this.order[mid]!)!;
      if (compareIntents(current, record) <= 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    this.order.splice(low, 0, record.id);
  }
}

export interface SocialSystemOptions {
  readonly queue: SocialIntentQueue;
  readonly provider?: SocialProvider;
  readonly id?: string;
  readonly removeResolved?: boolean;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export function createSocialSystem(options: SocialSystemOptions): SystemDefinition {
  const {
    queue,
    provider,
    id = 'social',
    removeResolved = true,
    before,
    after,
  } = options;

  return {
    id,
    before,
    after,
    tick(context: TickContext) {
      const newlyQueued = queue.consumeDirty().filter((intent) => intent.status === 'queued');
      for (const intent of newlyQueued) {
        const recordPayload = toRecord(intent.payload);
        const basePayload = {
          intentId: intent.id,
          type: intent.type,
          issuedAt: intent.issuedAt,
        } satisfies Omit<SocialIntentQueuedEventPayload, 'payload'>;

        const queuedPayload: SocialIntentQueuedEventPayload = recordPayload
          ? { ...basePayload, payload: recordPayload }
          : basePayload;
        context.events.publish('social:intent-queued', queuedPayload);
      }

      if (provider) {
        const confirmations = provider.pullConfirmations(queue.list());
        for (const confirmation of confirmations) {
          const intent = queue.applyConfirmation(confirmation);
          if (!intent) {
            continue;
          }

          const confirmedAt = intent.lastConfirmedAt ?? confirmation.confirmedAt;
          const resolvedPayload: SocialIntentResolvedEventPayload = intent.confirmationPayload
            ? {
                intentId: intent.id,
                type: intent.type,
                confirmedAt,
                payload: intent.confirmationPayload,
              }
            : {
                intentId: intent.id,
                type: intent.type,
                confirmedAt,
              };

          if (intent.status === 'confirmed') {
            context.events.publish('social:intent-confirmed', resolvedPayload);
          } else if (intent.status === 'rejected') {
            context.events.publish('social:intent-rejected', resolvedPayload);
          }
        }
      }

      if (removeResolved) {
        queue.pruneResolved();
      }
    },
  };
}

function compareIntents(left: SocialIntentRecord, right: SocialIntentRecord): number {
  if (left.issuedAt !== right.issuedAt) {
    return left.issuedAt - right.issuedAt;
  }
  return left.id.localeCompare(right.id);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
