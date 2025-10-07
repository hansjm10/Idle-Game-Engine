import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { createAuthMiddleware } from './middleware/auth.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { guildRouter } from './routes/guild.js';

const PORT = Number(process.env.PORT ?? 4000);
const app = express();

app.use(helmet());
app.use(express.json());
app.use(morgan('combined'));
app.use(createAuthMiddleware());

app.use('/leaderboard', leaderboardRouter);
app.use('/guilds', guildRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Social service listening on port ${PORT}`);
});
