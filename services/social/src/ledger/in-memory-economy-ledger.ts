import crypto from 'node:crypto';

import type {
  EconomyLedger,
  EconomyOperationInput,
  EconomyOperationQuery,
  EconomyOperationRecord,
  GuildContributionOperationInput,
  HardCurrencyId,
  LedgerEntry,
  TransferOperationInput,
} from '../types/economy.js';
import { InsufficientFundsError } from '../types/economy.js';

function createLedgerEntryKey(userId: string, currencyId: HardCurrencyId): string {
  return `${userId}:${currencyId}`;
}

function generateId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

class InMemoryEconomyLedger implements EconomyLedger {
  private readonly balances = new Map<string, LedgerEntry>();

  private readonly operations: EconomyOperationRecord[] = [];

  async earn(
    operation: EconomyOperationInput & { kind: 'Earn' },
  ): Promise<EconomyOperationRecord> {
    const occurredAt = new Date();
    const record: EconomyOperationRecord = {
      id: generateId(),
      userId: operation.userId,
      currencyId: operation.currencyId,
      kind: 'Earn',
      amount: operation.amount,
      direction: 'Credit',
      source: operation.source,
      occurredAt,
      clientTimestamp: operation.clientTimestamp,
      metadata: operation.metadata,
    };

    this.applyRecordToBalances(record);
    this.operations.push(record);

    return record;
  }

  async spend(
    operation: EconomyOperationInput & { kind: 'Spend' },
  ): Promise<EconomyOperationRecord> {
    const balance = await this.getBalance(operation.userId, operation.currencyId);
    if (operation.amount > balance.balance) {
      throw new InsufficientFundsError(
        `User ${operation.userId} has insufficient funds to spend ${operation.amount} ${operation.currencyId} (balance: ${balance.balance})`,
      );
    }

    const occurredAt = new Date();
    const record: EconomyOperationRecord = {
      id: generateId(),
      userId: operation.userId,
      currencyId: operation.currencyId,
      kind: 'Spend',
      amount: operation.amount,
      direction: 'Debit',
      reason: operation.reason,
      occurredAt,
      clientTimestamp: operation.clientTimestamp,
      metadata: operation.metadata,
    };

    this.applyRecordToBalances(record);
    this.operations.push(record);

    return record;
  }

  async transfer(
    operation: TransferOperationInput,
  ): Promise<readonly EconomyOperationRecord[]> {
    const balance = await this.getBalance(
      operation.fromUserId,
      operation.currencyId,
    );
    if (operation.amount > balance.balance) {
      throw new InsufficientFundsError(
        `User ${operation.fromUserId} has insufficient funds to transfer ${operation.amount} ${operation.currencyId} (balance: ${balance.balance})`,
      );
    }

    const occurredAt = new Date();
    const correlationId = generateId();

    const debitRecord: EconomyOperationRecord = {
      id: generateId(),
      userId: operation.fromUserId,
      currencyId: operation.currencyId,
      kind: 'Transfer',
      amount: operation.amount,
      direction: 'Debit',
      reason: operation.reason,
      occurredAt,
      clientTimestamp: operation.clientTimestamp,
      counterpartyUserId: operation.toUserId,
      correlationId,
      metadata: operation.metadata,
    };

    const creditRecord: EconomyOperationRecord = {
      id: generateId(),
      userId: operation.toUserId,
      currencyId: operation.currencyId,
      kind: 'Transfer',
      amount: operation.amount,
      direction: 'Credit',
      reason: operation.reason,
      occurredAt,
      clientTimestamp: operation.clientTimestamp,
      counterpartyUserId: operation.fromUserId,
      correlationId,
      metadata: operation.metadata,
    };

    this.applyRecordToBalances(debitRecord);
    this.applyRecordToBalances(creditRecord);
    this.operations.push(debitRecord, creditRecord);

    return [debitRecord, creditRecord];
  }

  async guildContribute(
    operation: GuildContributionOperationInput,
  ): Promise<EconomyOperationRecord> {
    const balance = await this.getBalance(operation.userId, operation.currencyId);
    if (operation.amount > balance.balance) {
      throw new InsufficientFundsError(
        `User ${operation.userId} has insufficient funds to contribute ${operation.amount} ${operation.currencyId} (balance: ${balance.balance})`,
      );
    }

    const occurredAt = new Date();
    const record: EconomyOperationRecord = {
      id: generateId(),
      userId: operation.userId,
      currencyId: operation.currencyId,
      kind: 'GuildContribution',
      amount: operation.amount,
      direction: 'Debit',
      occurredAt,
      clientTimestamp: operation.clientTimestamp,
      guildId: operation.guildId,
      metadata: operation.metadata,
    };

    this.applyRecordToBalances(record);
    this.operations.push(record);

    return record;
  }

  async getBalance(
    userId: string,
    currencyId: HardCurrencyId,
  ): Promise<LedgerEntry> {
    const key = createLedgerEntryKey(userId, currencyId);
    const existing = this.balances.get(key);
    if (existing) {
      return existing;
    }

    const entry: LedgerEntry = {
      userId,
      currencyId,
      balance: 0,
      updatedAt: new Date(0),
    };
    this.balances.set(key, entry);
    return entry;
  }

  async getBalancesForUser(userId: string): Promise<readonly LedgerEntry[]> {
    const entries: LedgerEntry[] = [];
    for (const entry of this.balances.values()) {
      if (entry.userId === userId) {
        entries.push(entry);
      }
    }
    return entries;
  }

  async getOperations(
    query: EconomyOperationQuery,
  ): Promise<readonly EconomyOperationRecord[]> {
    return this.operations.filter((record) => matchesQuery(record, query));
  }

  async recomputeBalanceFromOperations(
    userId: string,
    currencyId: HardCurrencyId,
  ): Promise<LedgerEntry> {
    const relevant = this.operations.filter(
      (record) => record.userId === userId && record.currencyId === currencyId,
    );

    let balance = 0;
    for (const record of relevant) {
      balance += getSignedAmount(record);
    }

    const key = createLedgerEntryKey(userId, currencyId);
    const updatedEntry: LedgerEntry = {
      userId,
      currencyId,
      balance,
      updatedAt: relevant.length > 0 ? relevant[relevant.length - 1]!.occurredAt : new Date(0),
    };
    this.balances.set(key, updatedEntry);
    return updatedEntry;
  }

  private applyRecordToBalances(record: EconomyOperationRecord): void {
    const key = createLedgerEntryKey(record.userId, record.currencyId);
    const existing = this.balances.get(key);
    const currentBalance = existing?.balance ?? 0;
    const newBalance = currentBalance + getSignedAmount(record);

    const updatedEntry: LedgerEntry = {
      userId: record.userId,
      currencyId: record.currencyId,
      balance: newBalance,
      updatedAt: record.occurredAt,
    };

    this.balances.set(key, updatedEntry);
  }
}

function getSignedAmount(record: EconomyOperationRecord): number {
  if (record.direction === 'Debit') {
    return -record.amount;
  }
  if (record.direction === 'Credit') {
    return record.amount;
  }

  if (record.kind === 'Spend' || record.kind === 'GuildContribution') {
    return -record.amount;
  }
  if (record.kind === 'Earn' || record.kind === 'Transfer') {
    return record.amount;
  }
  return record.amount;
}

function matchesQuery(
  record: EconomyOperationRecord,
  query: EconomyOperationQuery,
): boolean {
  if (query.userId !== undefined && record.userId !== query.userId) {
    return false;
  }
  if (query.currencyId !== undefined && record.currencyId !== query.currencyId) {
    return false;
  }
  if (query.kind !== undefined && record.kind !== query.kind) {
    return false;
  }
  if (query.guildId !== undefined && record.guildId !== query.guildId) {
    return false;
  }
  if (
    query.counterpartyUserId !== undefined &&
    record.counterpartyUserId !== query.counterpartyUserId
  ) {
    return false;
  }
  if (query.from !== undefined && record.occurredAt < query.from) {
    return false;
  }
  if (query.to !== undefined && record.occurredAt >= query.to) {
    return false;
  }
  return true;
}

export function createInMemoryEconomyLedger(): EconomyLedger {
  return new InMemoryEconomyLedger();
}
