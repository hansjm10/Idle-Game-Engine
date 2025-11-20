import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type {
  EconomyLedger,
  EconomyOperationRecord,
  HardCurrencyId,
} from '../types/economy.js';
import type { Guild, GuildStore } from '../types/guild.js';

const createGuildSchema = z.object({
  name: z.string().min(3),
  description: z.string().max(140).optional(),
});

interface GuildContributionSummary {
  readonly currencyId: HardCurrencyId;
  readonly totalContributed: number;
  readonly contributionsByMember: Record<string, number>;
  readonly lastUpdatedAt?: Date;
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

function mapGuildToResponse(guild: Guild) {
  return {
    id: guild.id,
    name: guild.name,
    description: guild.description,
    ownerId: guild.ownerId,
    createdAt: guild.createdAt,
    members: guild.members.map((member) => ({
      userId: member.userId,
      joinedAt: member.joinedAt,
    })),
  };
}

function summariseGuildContributions(
  operations: readonly EconomyOperationRecord[],
): GuildContributionSummary[] {
  const summaries = new Map<HardCurrencyId, GuildContributionSummary>();
  for (const record of operations) {
    if (record.kind !== 'GuildContribution') {
      continue;
    }
    const existing = summaries.get(record.currencyId);
    const contributionsByMember = existing?.contributionsByMember ?? {};
    const previousMemberTotal = contributionsByMember[record.userId] ?? 0;
    const nextMemberTotal = previousMemberTotal + record.amount;
    contributionsByMember[record.userId] = nextMemberTotal;

    const summary: GuildContributionSummary = {
      currencyId: record.currencyId,
      totalContributed: (existing?.totalContributed ?? 0) + record.amount,
      contributionsByMember,
      lastUpdatedAt: record.occurredAt,
    };

    summaries.set(record.currencyId, summary);
  }

  return Array.from(summaries.values());
}

export function createGuildRouter(
  ledger: EconomyLedger,
  guildStore: GuildStore,
): Router {
  const guildRouter: ReturnType<typeof Router> = Router();

  guildRouter.get('/mine', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const guild = guildStore.getGuildForUser(userId);
    if (!guild) {
      return res.json({
        guild: null,
        userId,
      });
    }

    try {
      const operations = await ledger.getOperations({
        guildId: guild.id,
        kind: 'GuildContribution',
      });

      const contributions = summariseGuildContributions(operations);

      res.json({
        guild: {
          ...mapGuildToResponse(guild),
          ledger: {
            contributions,
          },
        },
        userId,
      });
    } catch {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  guildRouter.post('/', (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const parsed = createGuildSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existingGuild = guildStore.getGuildForUser(userId);
    if (existingGuild) {
      return res.status(200).json({
        status: 'exists',
        guildId: existingGuild.id,
        ownerId: existingGuild.ownerId,
      });
    }

    const guild = guildStore.createGuild({
      name: parsed.data.name,
      description: parsed.data.description,
      ownerId: userId,
    });

    res.status(202).json({
      status: 'created',
      guildId: guild.id,
      ownerId: guild.ownerId,
    });
  });

  return guildRouter;
}
