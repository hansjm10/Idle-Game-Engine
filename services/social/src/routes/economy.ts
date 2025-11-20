import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { createInMemoryEconomyLedger } from '../ledger/in-memory-economy-ledger.js';
import {
  HARD_CURRENCY_IDS,
  InsufficientFundsError,
  type EconomyLedger,
  type EconomyOperationKind,
  type HardCurrencyId,
} from '../types/economy.js';

const hardCurrencyIdSchema = z.enum(HARD_CURRENCY_IDS);

const metadataSchema = z.record(z.string(), z.unknown());

const baseOperationSchema = z.object({
  currencyId: hardCurrencyIdSchema,
  amount: z.number().positive(),
  clientTimestamp: z.coerce.date().optional(),
  metadata: metadataSchema.optional(),
  simMetadata: metadataSchema.optional(),
});

const earnSchema = baseOperationSchema.extend({
  source: z.string().min(1),
});

const spendSchema = baseOperationSchema.extend({
  reason: z.string().min(1),
});

const transferSchema = baseOperationSchema.extend({
  toUserId: z.string().min(1),
  reason: z.string().min(1),
});

const guildContributionSchema = baseOperationSchema.extend({
  guildId: z.string().min(1),
});

interface RateLimitRule {
  readonly windowMs: number;
  readonly maxAmount: number;
}

export interface EconomyRouterOptions {
  readonly earnRateLimit?: RateLimitRule;
  readonly spendRateLimit?: RateLimitRule;
  readonly guildContributionLimit?: number;
}

const DEFAULT_EARN_RATE_LIMIT: RateLimitRule = {
  windowMs: 60 * 60 * 1000,
  maxAmount: 1_000,
};

const DEFAULT_SPEND_RATE_LIMIT: RateLimitRule = {
  windowMs: 60 * 60 * 1000,
  maxAmount: 500,
};

const DEFAULT_GUILD_CONTRIBUTION_LIMIT = 10_000;

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

function resolveMetadata(
  metadata?: Record<string, unknown>,
  simMetadata?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return metadata ?? simMetadata;
}

class RateLimitExceededError extends Error {
  readonly code = 'RateLimitExceeded';

  constructor(
    readonly kind: EconomyOperationKind,
    readonly maxAmount: number,
    readonly windowMs: number,
  ) {
    super(
      `Rate limit exceeded for ${kind}: attempted amount would exceed ${maxAmount} in the last ${windowMs}ms`,
    );
    this.name = 'RateLimitExceededError';
  }
}

class GuildContributionLimitExceededError extends Error {
  readonly code = 'GuildContributionLimitExceeded';

  constructor(readonly maxAmount: number) {
    super(
      `Guild contributions cannot exceed ${maxAmount} in a single operation`,
    );
    this.name = 'GuildContributionLimitExceededError';
  }
}

async function enforceRateLimit(
  ledger: EconomyLedger,
  userId: string,
  currencyId: HardCurrencyId,
  kind: EconomyOperationKind,
  amount: number,
  rule?: RateLimitRule,
): Promise<void> {
  if (!rule) {
    return;
  }

  const from = new Date(Date.now() - rule.windowMs);
  const operations = await ledger.getOperations({
    userId,
    currencyId,
    kind,
    from,
  });

  const totalInWindow = operations.reduce((sum, operation) => {
    if (operation.kind !== kind) {
      return sum;
    }
    return sum + operation.amount;
  }, 0);

  if (totalInWindow + amount > rule.maxAmount) {
    throw new RateLimitExceededError(kind, rule.maxAmount, rule.windowMs);
  }
}

function enforceGuildContributionLimit(
  amount: number,
  limit?: number,
): void {
  if (limit == null) {
    return;
  }

  if (amount > limit) {
    throw new GuildContributionLimitExceededError(limit);
  }
}

export function createEconomyRouter(
  ledger: EconomyLedger,
  options: EconomyRouterOptions = {},
): Router {
  const router = Router();
  const {
    earnRateLimit = DEFAULT_EARN_RATE_LIMIT,
    spendRateLimit = DEFAULT_SPEND_RATE_LIMIT,
    guildContributionLimit = DEFAULT_GUILD_CONTRIBUTION_LIMIT,
  } = options;

  router.get('/balances', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    try {
      const balances = await ledger.getBalancesForUser(userId);
      res.json({
        userId,
        balances,
      });
    } catch {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/earn', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const parsed = earnSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'InvalidPayload',
        details: parsed.error.flatten(),
      });
    }

    const { currencyId, amount, clientTimestamp, metadata, simMetadata, source } =
      parsed.data;

    try {
      await enforceRateLimit(
        ledger,
        userId,
        currencyId as HardCurrencyId,
        'Earn',
        amount,
        earnRateLimit,
      );

      const operation = await ledger.earn({
        kind: 'Earn',
        userId,
        currencyId: currencyId as HardCurrencyId,
        amount,
        source,
        clientTimestamp,
        metadata: resolveMetadata(metadata, simMetadata),
      });

      const balance = await ledger.getBalance(userId, currencyId as HardCurrencyId);

      res.json({
        operation,
        balance,
      });
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return res.status(429).json({
          error: error.code,
          message: error.message,
          windowMs: error.windowMs,
          maxAmount: error.maxAmount,
        });
      }

      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/spend', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const parsed = spendSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'InvalidPayload',
        details: parsed.error.flatten(),
      });
    }

    const { currencyId, amount, clientTimestamp, metadata, simMetadata, reason } =
      parsed.data;

    try {
      await enforceRateLimit(
        ledger,
        userId,
        currencyId as HardCurrencyId,
        'Spend',
        amount,
        spendRateLimit,
      );

      const operation = await ledger.spend({
        kind: 'Spend',
        userId,
        currencyId: currencyId as HardCurrencyId,
        amount,
        reason,
        clientTimestamp,
        metadata: resolveMetadata(metadata, simMetadata),
      });

      const balance = await ledger.getBalance(userId, currencyId as HardCurrencyId);

      res.json({
        operation,
        balance,
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return res.status(400).json({
          error: error.code,
          message: error.message,
        });
      }

      if (error instanceof RateLimitExceededError) {
        return res.status(429).json({
          error: error.code,
          message: error.message,
          windowMs: error.windowMs,
          maxAmount: error.maxAmount,
        });
      }

      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/transfer', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'InvalidPayload',
        details: parsed.error.flatten(),
      });
    }

    const {
      currencyId,
      amount,
      clientTimestamp,
      metadata,
      simMetadata,
      toUserId,
      reason,
    } = parsed.data;

    try {
      const [debitOperation, creditOperation] = await ledger.transfer({
        kind: 'Transfer',
        fromUserId: userId,
        toUserId,
        currencyId: currencyId as HardCurrencyId,
        amount,
        reason,
        clientTimestamp,
        metadata: resolveMetadata(metadata, simMetadata),
      });

      const senderBalance = await ledger.getBalance(
        userId,
        currencyId as HardCurrencyId,
      );
      const receiverBalance = await ledger.getBalance(
        toUserId,
        currencyId as HardCurrencyId,
      );

      res.json({
        operations: {
          debit: debitOperation,
          credit: creditOperation,
        },
        balances: {
          sender: senderBalance,
          receiver: receiverBalance,
        },
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return res.status(400).json({
          error: error.code,
          message: error.message,
        });
      }

      res.status(500).json({ error: 'internal_error' });
    }
  });

  router.post('/guild-contribute', async (req: Request, res: Response) => {
    const userId = getAuthenticatedUserId(req, res);
    if (!userId) {
      return;
    }

    const parsed = guildContributionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'InvalidPayload',
        details: parsed.error.flatten(),
      });
    }

    const {
      currencyId,
      amount,
      clientTimestamp,
      metadata,
      simMetadata,
      guildId,
    } = parsed.data;

    try {
      enforceGuildContributionLimit(amount, guildContributionLimit);

      const operation = await ledger.guildContribute({
        kind: 'GuildContribution',
        userId,
        currencyId: currencyId as HardCurrencyId,
        amount,
        guildId,
        clientTimestamp,
        metadata: resolveMetadata(metadata, simMetadata),
      });

      const balance = await ledger.getBalance(userId, currencyId as HardCurrencyId);

      res.json({
        operation,
        balance,
      });
    } catch (error) {
      if (error instanceof GuildContributionLimitExceededError) {
        return res.status(400).json({
          error: error.code,
          message: error.message,
          maxAmount: error.maxAmount,
        });
      }

      if (error instanceof InsufficientFundsError) {
        return res.status(400).json({
          error: error.code,
          message: error.message,
        });
      }

      res.status(500).json({ error: 'internal_error' });
    }
  });

  return router;
}

const defaultLedger = createInMemoryEconomyLedger();

const economyRouter: Router = createEconomyRouter(defaultLedger);

export { economyRouter };
