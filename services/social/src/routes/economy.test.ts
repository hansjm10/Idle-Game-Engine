import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createInMemoryEconomyLedger } from '../ledger/in-memory-economy-ledger.js';
import type { EconomyLedger, HardCurrencyId } from '../types/economy.js';
import { createEconomyRouter } from './economy.js';

const TEST_CURRENCY: HardCurrencyId = 'GEMS';

function createAuthenticatedApp(ledger?: EconomyLedger): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: 'user-1',
      preferredUsername: 'user-1',
    };
    next();
  });

  app.use('/economy', createEconomyRouter(ledger ?? createInMemoryEconomyLedger()));

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
});

