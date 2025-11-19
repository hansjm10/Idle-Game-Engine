import { describe, expect, it, vi } from 'vitest';

import {
  InsufficientFundsError,
  type EconomyOperationRecord,
  type HardCurrencyId,
} from '../types/economy.js';
import { createInMemoryEconomyLedger } from './in-memory-economy-ledger.js';

const TEST_CURRENCY: HardCurrencyId = 'GEMS';

describe('InMemoryEconomyLedger', () => {
  it('earns currency and records operation', async () => {
    const ledger = createInMemoryEconomyLedger();

    const record = await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 100,
      source: 'quest_reward',
    });

    const balance = await ledger.getBalance('user-1', TEST_CURRENCY);
    expect(balance.balance).toBe(100);
    expect(record.userId).toBe('user-1');
    expect(record.kind).toBe('Earn');

    const operations = await ledger.getOperations({ userId: 'user-1' });
    expect(operations).toHaveLength(1);
    expect(operations[0]!.id).toBe(record.id);
  });

  it('spends currency and prevents overspend', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 100,
      source: 'init',
    });

    await ledger.spend({
      kind: 'Spend',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 40,
      reason: 'purchase',
    });

    const balance = await ledger.getBalance('user-1', TEST_CURRENCY);
    expect(balance.balance).toBe(60);

    await expect(
      ledger.spend({
        kind: 'Spend',
        userId: 'user-1',
        currencyId: TEST_CURRENCY,
        amount: 100,
        reason: 'overspend',
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
  });

  it('transfers currency between users with correlated records', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'sender',
      currencyId: TEST_CURRENCY,
      amount: 100,
      source: 'seed',
    });

    const [debit, credit] = await ledger.transfer({
      kind: 'Transfer',
      fromUserId: 'sender',
      toUserId: 'receiver',
      currencyId: TEST_CURRENCY,
      amount: 30,
      reason: 'gift',
    });

    const senderBalance = await ledger.getBalance('sender', TEST_CURRENCY);
    const receiverBalance = await ledger.getBalance('receiver', TEST_CURRENCY);

    expect(senderBalance.balance).toBe(70);
    expect(receiverBalance.balance).toBe(30);

    expect(debit.correlationId).toBeDefined();
    expect(credit.correlationId).toBe(debit.correlationId);
    expect(debit.counterpartyUserId).toBe('receiver');
    expect(credit.counterpartyUserId).toBe('sender');
  });

  it('supports guild contributions as debits', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 50,
      source: 'seed',
    });

    const contribution = await ledger.guildContribute({
      kind: 'GuildContribution',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 20,
      guildId: 'guild-1',
    });

    const balance = await ledger.getBalance('user-1', TEST_CURRENCY);
    expect(balance.balance).toBe(30);
    expect(contribution.guildId).toBe('guild-1');
  });

  it('reconstructs balances from operation history', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 100,
      source: 'seed',
    });
    await ledger.spend({
      kind: 'Spend',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 30,
      reason: 'purchase',
    });
    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 10,
      source: 'bonus',
    });

    const balance = await ledger.getBalance('user-1', TEST_CURRENCY);
    expect(balance.balance).toBe(80);

    const recomputed = await ledger.recomputeBalanceFromOperations(
      'user-1',
      TEST_CURRENCY,
    );

    expect(recomputed.balance).toBe(80);
    expect(recomputed.updatedAt.getTime()).toBeGreaterThan(0);
  });

  it('filters operations by time window', async () => {
    vi.useFakeTimers();
    const ledger = createInMemoryEconomyLedger();

    const t1 = new Date('2025-01-01T00:00:00.000Z');
    const t2 = new Date('2025-01-02T00:00:00.000Z');

    vi.setSystemTime(t1);
    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 10,
      source: 'early',
    });

    vi.setSystemTime(t2);
    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 20,
      source: 'late',
    });

    const from = new Date('2025-01-02T00:00:00.000Z');
    const operations = (await ledger.getOperations({
      userId: 'user-1',
      from,
    })) as EconomyOperationRecord[];

    expect(operations).toHaveLength(1);
    expect(operations[0]!.amount).toBe(20);

    vi.useRealTimers();
  });
});

