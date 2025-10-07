import { Router } from 'express';
import { z } from 'zod';

const createGuildSchema = z.object({
  name: z.string().min(3),
  description: z.string().max(140).optional()
});

const guildRouter = Router();

guildRouter.get('/mine', (req, res) => {
  res.json({
    guild: null,
    userId: req.user?.id ?? 'anonymous'
  });
});

guildRouter.post('/', (req, res) => {
  const parsed = createGuildSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  res.status(202).json({
    status: 'queued',
    guildId: `guild-${Date.now()}`,
    ownerId: req.user?.id ?? 'anonymous'
  });
});

export { guildRouter };
