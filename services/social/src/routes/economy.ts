import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { createInMemoryEconomyLedger } from '../ledger/in-memory-economy-ledger.js';
import {
  InsufficientFundsError,
  type EconomyLedger,
  type HardCurrencyId,
} from '../types/economy.js';

const hardCurrencyIdSchema = z.enum(['GEMS', 'BONDS', 'GUILD_TOKENS']);

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

export function createEconomyRouter(ledger: EconomyLedger): ReturnType<
  typeof Router
> {
  const router: ReturnType<typeof Router> = Router();

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
    } catch {
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

const economyRouter = createEconomyRouter(defaultLedger);

export { economyRouter };
