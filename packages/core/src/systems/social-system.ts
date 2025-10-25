import type {
  SocialIntentQueuedEventPayload,
  SocialIntentResolvedEventPayload,
  SocialIntentPayload,
} from '../events/runtime-event-catalog.js';
import type { TickContext } from './system-types.js';
import type { SystemDefinition } from './system-types.js';

export type SocialIntentStatus = 'queued' | 'confirming' | 'confirmed' | 'rejected';

export interface SocialIntentDefinition<
  TPayload extends SocialIntentPayload = SocialIntentPayload,
> {
  readonly type: string;
  readonly payload: TPayload;
  readonly issuedAt?: number;
}

export interface SocialIntentRecord<
  TPayload extends SocialIntentPayload = SocialIntentPayload,
> extends SocialIntentDefinition<TPayload> {
  readonly id: string;
  readonly issuedAt: number;
  readonly sequence: number;
  status: SocialIntentStatus;
  readonly enqueuedStep: number;
  lastConfirmedAt?: number;
  confirmationPayload?: SocialIntentPayload;
  resolutionNotified?: boolean;
  dirtyReason?: 'queued' | 'status';
}

export interface SocialConfirmation<
  TPayload extends SocialIntentPayload = SocialIntentPayload,
> {
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

  queue<TPayload extends SocialIntentPayload>(
    definition: SocialIntentDefinition<TPayload>,
    step: number,
  ): SocialIntentRecord<TPayload> {
    const sequence = this.nextSequence();
    const id = sequence.toString(36);
    const issuedAt = definition.issuedAt ?? this.clock();
    const record: SocialIntentRecord<TPayload> = {
      id,
      type: definition.type,
      payload: definition.payload,
      issuedAt,
      sequence,
      status: 'queued',
      enqueuedStep: step,
      dirtyReason: 'queued',
    };
    this.intents.set(id, record);
    this.insertIntent(record);
    this.dirty.add(id);
    return record;
  }

  markDirty(intentId: string, reason: 'queued' | 'status'): void {
    const intent = this.intents.get(intentId);
    if (!intent) {
      return;
    }

    intent.dirtyReason = reason;
    this.dirty.add(intentId);
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

  applyConfirmation(
    confirmation: SocialConfirmation,
  ): SocialIntentRecord | undefined {
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
    intent.confirmationPayload = confirmation.payload;
    intent.resolutionNotified = false;
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
      if (
        (intent.status === 'confirmed' || intent.status === 'rejected') &&
        intent.resolutionNotified
      ) {
        this.intents.delete(id);
        this.order.splice(index, 1);
      }
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
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
      const dirtyIntents = queue.consumeDirty();
      for (const intent of dirtyIntents) {
        if (intent.status === 'queued') {
          const basePayload = {
            intentId: intent.id,
            type: intent.type,
            issuedAt: intent.issuedAt,
          } satisfies Omit<SocialIntentQueuedEventPayload, 'payload'>;

          const queuedPayload: SocialIntentQueuedEventPayload =
            intent.payload !== undefined
              ? { ...basePayload, payload: intent.payload }
              : basePayload;

          const result = context.events.publish('social:intent-queued', queuedPayload);
          if (!result.accepted) {
            queue.markDirty(intent.id, 'queued');
          }
          continue;
        }

        if (intent.status !== 'confirmed' && intent.status !== 'rejected') {
          continue;
        }

        const confirmedAt = intent.lastConfirmedAt ?? context.step;
        const hasConfirmationPayload = intent.confirmationPayload !== undefined;
        const resolvedPayload: SocialIntentResolvedEventPayload = hasConfirmationPayload
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

        const eventType =
          intent.status === 'confirmed'
            ? 'social:intent-confirmed'
            : 'social:intent-rejected';
        const result = context.events.publish(eventType, resolvedPayload);
        if (result.accepted) {
          intent.resolutionNotified = true;
        } else {
          queue.markDirty(intent.id, 'status');
        }
      }

      if (provider) {
        const confirmations = provider.pullConfirmations(queue.list());
        for (const confirmation of confirmations) {
          const intent = queue.applyConfirmation(confirmation);
          if (!intent) {
            continue;
          }

          const confirmedAt = intent.lastConfirmedAt ?? confirmation.confirmedAt;
          const hasConfirmationPayload = intent.confirmationPayload !== undefined;
          const resolvedPayload: SocialIntentResolvedEventPayload = hasConfirmationPayload
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

          const eventType =
            intent.status === 'confirmed'
              ? 'social:intent-confirmed'
              : 'social:intent-rejected';
          const result = context.events.publish(eventType, resolvedPayload);
          if (result.accepted) {
            intent.resolutionNotified = true;
          } else {
            queue.markDirty(intent.id, 'status');
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
  return left.sequence - right.sequence;
}
