import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createInMemoryEconomyLedger } from '../ledger/in-memory-economy-ledger.js';
import { createInMemoryGuildStore } from '../stores/in-memory-guild-store.js';
import type { EconomyLedger, HardCurrencyId } from '../types/economy.js';
import type { GuildStore } from '../types/guild.js';
import { createGuildRouter } from './guild.js';

const TEST_CURRENCY: HardCurrencyId = 'GEMS';

function createAuthenticatedApp(
  ledger: EconomyLedger,
  guildStore: GuildStore,
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

  app.use('/guilds', createGuildRouter(ledger, guildStore));

  return app;
}

describe('guild routes', () => {
  it('returns null guild when user is not a member', async () => {
    const ledger = createInMemoryEconomyLedger();
    const guildStore = createInMemoryGuildStore();
    const app = createAuthenticatedApp(ledger, guildStore, 'user-1');

    const response = await request(app).get('/guilds/mine').expect(200);

    expect(response.body.guild).toBeNull();
    expect(response.body.userId).toBe('user-1');
  });

  it('creates a guild and returns ledger-driven contribution summary', async () => {
    const ledger = createInMemoryEconomyLedger();
    const guildStore = createInMemoryGuildStore();
    const app = createAuthenticatedApp(ledger, guildStore, 'owner-1');

    const createResponse = await request(app)
      .post('/guilds')
      .send({
        name: 'Test Guild',
        description: 'A guild for testing',
      })
      .expect(202);

    const guildId = createResponse.body.guildId as string;

    await ledger.earn({
      kind: 'Earn',
      userId: 'owner-1',
      currencyId: TEST_CURRENCY,
      amount: 100,
      source: 'seed',
    });

    await ledger.guildContribute({
      kind: 'GuildContribution',
      userId: 'owner-1',
      currencyId: TEST_CURRENCY,
      amount: 25,
      guildId,
    });

    const mineResponse = await request(app).get('/guilds/mine').expect(200);

    expect(mineResponse.body.guild.id).toBe(guildId);
    expect(mineResponse.body.guild.ownerId).toBe('owner-1');
    expect(mineResponse.body.guild.ledger.contributions).toHaveLength(1);

    const gemsContribution = mineResponse.body.guild.ledger.contributions.find(
      (entry: { currencyId: HardCurrencyId }) => entry.currencyId === TEST_CURRENCY,
    );

    expect(gemsContribution.totalContributed).toBe(25);
    expect(gemsContribution.contributionsByMember['owner-1']).toBe(25);
  });

  it('is idempotent when creating a guild for the same user', async () => {
    const ledger = createInMemoryEconomyLedger();
    const guildStore = createInMemoryGuildStore();
    const app = createAuthenticatedApp(ledger, guildStore, 'owner-2');

    const firstResponse = await request(app)
      .post('/guilds')
      .send({ name: 'First Guild' })
      .expect(202);

    const secondResponse = await request(app)
      .post('/guilds')
      .send({ name: 'First Guild' })
      .expect(200);

    expect(secondResponse.body.status).toBe('exists');
    expect(secondResponse.body.guildId).toBe(firstResponse.body.guildId);
  });
});
