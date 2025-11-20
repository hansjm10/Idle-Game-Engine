export const HARD_CURRENCY_IDS = ['GEMS', 'BONDS', 'GUILD_TOKENS'] as const;

export type HardCurrencyId = (typeof HARD_CURRENCY_IDS)[number];

export type EconomyOperationKind =
  | 'Earn'
  | 'Spend'
  | 'Transfer'
  | 'GuildContribution';

export interface LedgerEntry {
  readonly userId: string;
  readonly currencyId: HardCurrencyId;
  readonly balance: number;
  readonly updatedAt: Date;
}

export interface EconomyOperationBase {
  readonly currencyId: HardCurrencyId;
  readonly amount: number;
  readonly clientTimestamp?: Date;
  readonly metadata?: Record<string, unknown>;
}

export interface EarnOperationInput extends EconomyOperationBase {
  readonly kind: 'Earn';
  readonly userId: string;
  readonly source: string;
}

export interface SpendOperationInput extends EconomyOperationBase {
  readonly kind: 'Spend';
  readonly userId: string;
  readonly reason: string;
}

export interface TransferOperationInput extends EconomyOperationBase {
  readonly kind: 'Transfer';
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly reason: string;
}

export interface GuildContributionOperationInput extends EconomyOperationBase {
  readonly kind: 'GuildContribution';
  readonly userId: string;
  readonly guildId: string;
}

export type EconomyOperationInput =
  | EarnOperationInput
  | SpendOperationInput
  | TransferOperationInput
  | GuildContributionOperationInput;

export interface EconomyOperationRecord {
  readonly id: string;
  readonly userId: string;
  readonly currencyId: HardCurrencyId;
  readonly kind: EconomyOperationKind;
  readonly amount: number;
  readonly direction?: 'Debit' | 'Credit';
  readonly source?: string;
  readonly reason?: string;
  readonly occurredAt: Date;
  readonly clientTimestamp?: Date;
  readonly guildId?: string;
  readonly counterpartyUserId?: string;
  readonly correlationId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface EconomyOperationQuery {
  readonly userId?: string;
  readonly currencyId?: HardCurrencyId;
  readonly kind?: EconomyOperationKind;
  readonly guildId?: string;
  readonly counterpartyUserId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

export interface EconomyLedger {
  earn(operation: EarnOperationInput): Promise<EconomyOperationRecord>;

  spend(operation: SpendOperationInput): Promise<EconomyOperationRecord>;

  transfer(
    operation: TransferOperationInput,
  ): Promise<readonly EconomyOperationRecord[]>;

  guildContribute(
    operation: GuildContributionOperationInput,
  ): Promise<EconomyOperationRecord>;

  getBalance(
    userId: string,
    currencyId: HardCurrencyId,
  ): Promise<LedgerEntry>;

  getBalancesForUser(userId: string): Promise<readonly LedgerEntry[]>;

  getOperations(
    query: EconomyOperationQuery,
  ): Promise<readonly EconomyOperationRecord[]>;

  recomputeBalanceFromOperations(
    userId: string,
    currencyId: HardCurrencyId,
  ): Promise<LedgerEntry>;
}

export class InsufficientFundsError extends Error {
  readonly code = 'InsufficientFunds';

  constructor(message: string) {
    super(message);
    this.name = 'InsufficientFundsError';
  }
}
