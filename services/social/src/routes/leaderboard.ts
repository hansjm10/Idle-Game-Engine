import { Router } from 'express';
import { z } from 'zod';

const submitSchema = z.object({
  leaderboardId: z.string().min(1),
  score: z.number().nonnegative(),
  metadata: z.record(z.string()).optional()
});

const leaderboardRouter = Router();

leaderboardRouter.get('/:leaderboardId', (req, res) => {
  const { leaderboardId } = req.params;
  res.json({
    leaderboardId,
    entries: [
      {
        userId: req.user?.id ?? 'anonymous',
        username: req.user?.preferredUsername ?? 'anonymous',
        score: 0,
        rank: 1
      }
    ]
  });
});

leaderboardRouter.post('/submit', (req, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { leaderboardId, score } = parsed.data;
  res.json({
    status: 'queued',
    leaderboardId,
    score,
    userId: req.user?.id ?? 'anonymous'
  });
});

export { leaderboardRouter };
