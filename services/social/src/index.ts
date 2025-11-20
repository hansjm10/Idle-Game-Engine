import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { createAuthMiddleware } from './middleware/auth.js';
import { createInMemoryGuildStore } from './stores/in-memory-guild-store.js';
import { createEconomyRouter } from './routes/economy.js';
import { createLeaderboardRouter } from './routes/leaderboard.js';
import { createGuildRouter } from './routes/guild.js';
import { createInMemoryEconomyLedger } from './ledger/in-memory-economy-ledger.js';

const PORT = Number(process.env.PORT ?? 4000);
const app = express();

app.use(helmet());
app.use(express.json());
app.use(morgan('combined'));
app.use(createAuthMiddleware());

const ledger = createInMemoryEconomyLedger();
const guildStore = createInMemoryGuildStore();

app.use('/economy', createEconomyRouter(ledger));
app.use('/leaderboard', createLeaderboardRouter(ledger));
app.use('/guilds', createGuildRouter(ledger, guildStore));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Social service listening on port ${PORT}`);
});
