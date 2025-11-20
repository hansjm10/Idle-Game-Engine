import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createInMemoryEconomyLedger } from '../ledger/in-memory-economy-ledger.js';
import type { EconomyLedger, HardCurrencyId } from '../types/economy.js';
import { createLeaderboardRouter } from './leaderboard.js';

const TEST_CURRENCY: HardCurrencyId = 'GEMS';

function createAuthenticatedApp(
  ledger: EconomyLedger,
  userId = 'user-1',
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: userId,
      preferredUsername: userId,
    };
    next();
  });

  app.use('/leaderboard', createLeaderboardRouter(ledger));

  return app;
}

describe('leaderboard routes', () => {
  it('returns ledger-derived ranks for currency leaderboard', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 120,
      source: 'seed',
    });
    await ledger.earn({
      kind: 'Earn',
      userId: 'user-2',
      currencyId: TEST_CURRENCY,
      amount: 80,
      source: 'seed',
    });

    const app = createAuthenticatedApp(ledger, 'user-1');

    const response = await request(app)
      .get(`/leaderboard/${TEST_CURRENCY}`)
      .expect(200);

    expect(response.body.currencyId).toBe(TEST_CURRENCY);
    expect(response.body.entries).toHaveLength(2);
    expect(response.body.entries[0].userId).toBe('user-1');
    expect(response.body.entries[0].score).toBe(120);
    expect(response.body.entries[0].rank).toBe(1);
    expect(response.body.entries[1].userId).toBe('user-2');
    expect(response.body.entries[1].rank).toBe(2);
  });

  it('includes current user with zero score when no operations exist', async () => {
    const ledger = createInMemoryEconomyLedger();
    const app = createAuthenticatedApp(ledger, 'user-3');

    const response = await request(app)
      .get(`/leaderboard/${TEST_CURRENCY}`)
      .expect(200);

    const userEntry = response.body.entries.find(
      (entry: { userId: string }) => entry.userId === 'user-3',
    );

    expect(userEntry).toBeDefined();
    expect(userEntry?.score).toBe(0);
    expect(userEntry?.rank).toBe(1);
  });

  it('rejects submissions that exceed ledger-derived score', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 10,
      source: 'seed',
    });

    const app = createAuthenticatedApp(ledger, 'user-1');

    const response = await request(app)
      .post('/leaderboard/submit')
      .send({
        leaderboardId: TEST_CURRENCY,
        score: 100,
      })
      .expect(400);

    expect(response.body.error).toBe('ScoreMismatch');
    expect(response.body.authoritativeScore).toBe(10);
  });

  it('accepts submissions that match ledger score and returns rank', async () => {
    const ledger = createInMemoryEconomyLedger();

    await ledger.earn({
      kind: 'Earn',
      userId: 'user-1',
      currencyId: TEST_CURRENCY,
      amount: 50,
      source: 'seed',
    });

    const app = createAuthenticatedApp(ledger, 'user-1');

    const response = await request(app)
      .post('/leaderboard/submit')
      .send({
        leaderboardId: TEST_CURRENCY,
        score: 50,
      })
      .expect(200);

    expect(response.body.status).toBe('accepted');
    expect(response.body.score).toBe(50);
    expect(response.body.rank).toBe(1);
  });
});
