import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryEconomyLedger } from '../ledger/in-memory-economy-ledger.js';
import type { EconomyLedger, HardCurrencyId } from '../types/economy.js';
import { createEconomyRouter } from './economy.js';
import type { EconomyRouterOptions } from './economy.js';

const TEST_CURRENCY: HardCurrencyId = 'GEMS';

function createAuthenticatedApp(
  ledger?: EconomyLedger,
  options?: EconomyRouterOptions,
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 'user-1',
      preferredUsername: 'user-1',
    };
    next();
  });

  app.use(
    '/economy',
    createEconomyRouter(ledger ?? createInMemoryEconomyLedger(), options),
  );

  return app;
}

describe('economy routes', () => {
  it('rejects spends that exceed balance', async () => {
    const app = createAuthenticatedApp();

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 50,
        source: 'seed',
      })
      .expect(200);

    const response = await request(app)
      .post('/economy/spend')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 100,
        reason: 'purchase',
      })
      .expect(400);

    expect(response.body.error).toBe('InsufficientFunds');
  });

  it('rejects transfers that exceed balance', async () => {
    const app = createAuthenticatedApp();

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 25,
        source: 'seed',
      })
      .expect(200);

    const response = await request(app)
      .post('/economy/transfer')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 50,
        toUserId: 'receiver-1',
        reason: 'gift',
      })
      .expect(400);

    expect(response.body.error).toBe('InsufficientFunds');
  });

  it('applies guild contributions as debits and exposes updated balances', async () => {
    const app = createAuthenticatedApp();

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 100,
        source: 'seed',
      })
      .expect(200);

    const contributeResponse = await request(app)
      .post('/economy/guild-contribute')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 40,
        guildId: 'guild-1',
      })
      .expect(200);

    expect(contributeResponse.body.operation).toBeDefined();
    expect(contributeResponse.body.operation.guildId).toBe('guild-1');

    const balancesResponse = await request(app)
      .get('/economy/balances')
      .expect(200);

    const balances = balancesResponse.body.balances as Array<{
      currencyId: string;
      balance: number;
    }>;

    const gemsBalance = balances.find(
      (entry) => entry.currencyId === TEST_CURRENCY,
    );

    expect(gemsBalance?.balance).toBe(60);
  });

  it('rate limits spend operations within the configured window', async () => {
    vi.useFakeTimers();
    const app = createAuthenticatedApp(undefined, {
      spendRateLimit: { windowMs: 60 * 60 * 1000, maxAmount: 50 },
    });

    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 100,
        source: 'seed',
      })
      .expect(200);

    await request(app)
      .post('/economy/spend')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 30,
        reason: 'purchase',
      })
      .expect(200);

    const limitedResponse = await request(app)
      .post('/economy/spend')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 25,
        reason: 'another-purchase',
      })
      .expect(429);

    expect(limitedResponse.body.error).toBe('RateLimitExceeded');

    vi.setSystemTime(new Date('2025-01-01T02:00:00.000Z'));

    const postWindowResponse = await request(app)
      .post('/economy/spend')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 25,
        reason: 'delayed-purchase',
      })
      .expect(200);

    expect(postWindowResponse.body.operation).toBeDefined();
    vi.useRealTimers();
  });

  it('rate limits earn operations within the configured window', async () => {
    vi.useFakeTimers();
    const app = createAuthenticatedApp(undefined, {
      earnRateLimit: { windowMs: 60 * 60 * 1000, maxAmount: 60 },
    });

    vi.setSystemTime(new Date('2025-02-01T00:00:00.000Z'));

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 40,
        source: 'quest',
      })
      .expect(200);

    const limitedResponse = await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 30,
        source: 'bonus',
      })
      .expect(429);

    expect(limitedResponse.body.error).toBe('RateLimitExceeded');

    vi.setSystemTime(new Date('2025-02-01T02:00:00.000Z'));

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 30,
        source: 'bonus',
      })
      .expect(200);

    vi.useRealTimers();
  });

  it('rejects guild contributions that exceed configured limit', async () => {
    const app = createAuthenticatedApp(undefined, {
      guildContributionLimit: 50,
    });

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 100,
        source: 'seed',
      })
      .expect(200);

    const response = await request(app)
      .post('/economy/guild-contribute')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 60,
        guildId: 'guild-1',
      })
      .expect(400);

    expect(response.body.error).toBe('GuildContributionLimitExceeded');
  });

  it('rejects guild contributions when limit is zero', async () => {
    const app = createAuthenticatedApp(undefined, {
      guildContributionLimit: 0,
    });

    await request(app)
      .post('/economy/earn')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 25,
        source: 'seed',
      })
      .expect(200);

    const response = await request(app)
      .post('/economy/guild-contribute')
      .send({
        currencyId: TEST_CURRENCY,
        amount: 1,
        guildId: 'guild-1',
      })
      .expect(400);

    expect(response.body.error).toBe('GuildContributionLimitExceeded');
  });
});
