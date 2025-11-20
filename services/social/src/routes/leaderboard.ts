import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import {
  HARD_CURRENCY_IDS,
  type EconomyLedger,
  type EconomyOperationRecord,
  type HardCurrencyId,
} from '../types/economy.js';

interface LeaderboardEntry {
  readonly userId: string;
  readonly username: string;
  readonly score: number;
  readonly rank: number;
}

const submitSchema = z.object({
  leaderboardId: z.string().min(1),
  score: z.number().nonnegative(),
  metadata: z.record(z.string(), z.string()).optional(),
});

function isHardCurrencyId(value: string): value is HardCurrencyId {
  return HARD_CURRENCY_IDS.includes(value as HardCurrencyId);
}

function resolveCurrencyFromLeaderboardId(
  leaderboardId: string,
): HardCurrencyId | undefined {
  if (isHardCurrencyId(leaderboardId)) {
    return leaderboardId;
  }
  const upper = leaderboardId.toUpperCase();
  if (isHardCurrencyId(upper)) {
    return upper;
  }
  return undefined;
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
  return record.amount;
}

async function buildLeaderboardEntries(
  ledger: EconomyLedger,
  currencyId: HardCurrencyId,
  currentUserId?: string,
  currentUsername?: string,
  limit = 50,
): Promise<LeaderboardEntry[]> {
  const operations = await ledger.getOperations({ currencyId });
  const balances = new Map<string, number>();

  for (const record of operations) {
    const next = (balances.get(record.userId) ?? 0) + getSignedAmount(record);
    balances.set(record.userId, next);
  }

  if (currentUserId && !balances.has(currentUserId)) {
    const balance = await ledger.getBalance(currentUserId, currencyId);
    balances.set(currentUserId, balance.balance);
  }

  const ordered = Array.from(balances.entries())
    .map(([userId, score]) => ({
      userId,
      score,
    }))
    .sort((a, b) => b.score - a.score);

  const entries: LeaderboardEntry[] = ordered.slice(0, limit).map(
    ({ userId, score }, index) => ({
      userId,
      username: userId,
      score,
      rank: index + 1,
    }),
  );

  if (currentUserId) {
    const existingIndex = ordered.findIndex(
      (entry) => entry.userId === currentUserId,
    );
    if (existingIndex !== -1) {
      const existingRank = existingIndex + 1;
      const existingScore = ordered[existingIndex]!.score;
      const username = currentUsername ?? currentUserId;
      if (existingRank > limit) {
        entries.push({
          userId: currentUserId,
          username,
          score: existingScore,
          rank: existingRank,
        });
      } else {
        const entryAtRank = entries[existingIndex];
        if (entryAtRank) {
          entries[existingIndex] = {
            ...entryAtRank,
            username,
          };
        }
      }
    }
  }

  return entries;
}

function getAuthenticatedUserId(
  req: Request,
  res: Response,
): string | undefined {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'unauthorized' });
    return undefined;
  }
  return userId;
}

export function createLeaderboardRouter(ledger: EconomyLedger): Router {
  const leaderboardRouter: ReturnType<typeof Router> = Router();

  leaderboardRouter.get('/:leaderboardId', async (req: Request, res: Response) => {
    const currencyId = resolveCurrencyFromLeaderboardId(req.params.leaderboardId);
    if (!currencyId) {
      return res.status(404).json({ error: 'UnknownLeaderboard' });
    }

    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    try {
      const entries = await buildLeaderboardEntries(
        ledger,
        currencyId,
        userId,
        req.user?.preferredUsername,
      );

      res.json({
        leaderboardId: req.params.leaderboardId,
        currencyId,
        entries,
      });
    } catch {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  leaderboardRouter.post('/submit', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { leaderboardId, score } = parsed.data;
    const currencyId = resolveCurrencyFromLeaderboardId(leaderboardId);
    if (!currencyId) {
      return res.status(404).json({ error: 'UnknownLeaderboard' });
    }

    try {
      const balance = await ledger.getBalance(userId, currencyId);
      const authoritativeScore = balance.balance;

      if (score > authoritativeScore) {
        return res.status(400).json({
          error: 'ScoreMismatch',
          message: 'Submitted score exceeds ledger-derived balance.',
          authoritativeScore,
        });
      }

      const entries = await buildLeaderboardEntries(
        ledger,
        currencyId,
        userId,
        req.user?.preferredUsername,
      );

      const currentEntry = entries.find((entry) => entry.userId === userId);

      res.json({
        status: 'accepted',
        leaderboardId,
        currencyId,
        userId,
        score: currentEntry?.score ?? authoritativeScore,
        rank: currentEntry?.rank,
        entries,
      });
    } catch {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return leaderboardRouter;
}
