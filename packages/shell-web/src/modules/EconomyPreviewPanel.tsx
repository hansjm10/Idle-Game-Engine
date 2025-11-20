import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';

import styles from './EconomyPreviewPanel.module.css';

type Balance = {
  readonly currencyId: string;
  readonly label: string;
  readonly balance: number;
  readonly pendingDelta?: number;
  readonly status: 'ok' | 'pending' | 'error';
};

const SAMPLE_BALANCES: readonly Balance[] = [
  {
    currencyId: 'GEMS',
    label: 'Gems',
    balance: 245,
    pendingDelta: -25,
    status: 'ok',
  },
  {
    currencyId: 'BONDS',
    label: 'Bonds',
    balance: 1200,
    pendingDelta: 150,
    status: 'pending',
  },
  {
    currencyId: 'GUILD_TOKENS',
    label: 'Guild Tokens',
    balance: 14,
    pendingDelta: 0,
    status: 'ok',
  },
];

function formatAmount(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '—';
  }
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function StatusPill({ status }: { status: Balance['status'] }): JSX.Element {
  const labelMap: Record<Balance['status'], string> = {
    ok: 'Ledger in sync',
    pending: 'Reconciliation pending',
    error: 'Attention required',
  };
  return (
    <span
      className={[
        styles.statusPill,
        status === 'pending' ? styles.pending : '',
        status === 'error' ? styles.error : '',
      ].join(' ')}
    >
      <span aria-hidden="true">●</span>
      {labelMap[status]}
    </span>
  );
}

export function EconomyPreviewPanel(): JSX.Element {
  const headingId = useId();
  const tableLabelId = useId();
  const dialogTitleId = useId();
  const dialogDescId = useId();
  const [showError, setShowError] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);

  const totals = useMemo(() => {
    return SAMPLE_BALANCES.reduce(
      (acc, balance) => acc + (Number.isFinite(balance.balance) ? balance.balance : 0),
      0,
    );
  }, []);

  useEffect(() => {
    if (dialogOpen && dialogRef.current) {
      dialogRef.current.focus();
    }
  }, [dialogOpen]);

  const closeDialog = () => {
    setDialogOpen(false);
    dialogTriggerRef.current?.focus();
  };

  return (
    <section
      className={styles.panel}
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className={styles.header}>
        Hard Currency Wallet (Preview)
      </h2>
      <p className={styles.lede} role="status" aria-live="polite">
        Preview of GEL-001 ledger data flowing into the shell UI. Values are static and
        flag-gated to keep the main shell stable while economy UI is built out.
      </p>

      <div
        className={styles.balances}
        role="table"
        aria-label="Hard currency balances"
      >
        <div className={styles.row} role="row" aria-labelledby={tableLabelId}>
          <div id={tableLabelId} className={styles.cellHeader} role="columnheader">
            Currency
          </div>
          <div className={styles.cellHeader} role="columnheader">
            Balance
          </div>
          <div className={styles.cellHeader} role="columnheader">
            Ledger status
          </div>
        </div>
        {SAMPLE_BALANCES.map((balance) => (
          <div key={balance.currencyId} className={styles.row} role="row">
            <div role="rowheader">
              {balance.label}{' '}
              <span className={styles.amount} aria-label={`Code ${balance.currencyId}`}>
                ({balance.currencyId})
              </span>
            </div>
            <div className={styles.amount} role="cell">
              {formatAmount(balance.balance)}
              {balance.pendingDelta ? (
                <span aria-label={`Pending delta ${balance.pendingDelta > 0 ? 'plus' : 'minus'} ${Math.abs(balance.pendingDelta)}`}>
                  {' '}
                  ({balance.pendingDelta > 0 ? '+' : '−'}
                  {formatAmount(Math.abs(balance.pendingDelta))} pending)
                </span>
              ) : null}
            </div>
            <div role="cell">
              <StatusPill status={balance.status} />
            </div>
          </div>
        ))}
        <div className={styles.row} role="row">
          <div role="rowheader">Total</div>
          <div className={styles.amount} role="cell">
            {formatAmount(totals)}
          </div>
          <div role="cell">
            <StatusPill status="ok" />
          </div>
        </div>
      </div>

      {showError ? (
        <div
          className={styles.alert}
          role="alert"
          aria-live="assertive"
        >
          Spend rejected: insufficient Gems to complete the operation. This preview simulates
          a hard-currency ledger denial—focus lands here so screen readers announce the failure.
          Verify the server-authoritative balance and retry with a smaller amount.
        </div>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() => setShowError(true)}
        >
          Simulate rejected spend
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.secondary}`}
          onClick={() => setShowError(false)}
          disabled={!showError}
        >
          Clear error
        </button>
        <button
          type="button"
          ref={dialogTriggerRef}
          className={styles.button}
          onClick={() => setDialogOpen(true)}
          aria-haspopup="dialog"
        >
          Open reconciliation dialog
        </button>
      </div>

      {dialogOpen ? (
        <div className={styles.dialogOverlay} role="presentation">
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            aria-describedby={dialogDescId}
            tabIndex={-1}
          >
            <h3 id={dialogTitleId} className={styles.dialogTitle}>
              Reconcile hard currency balance
            </h3>
            <p id={dialogDescId} className={styles.dialogBody}>
              This dialog simulates a focused reconciliation step for GEL-001. Confirm to align
              the optimistic client value with the server-authoritative ledger and announce the
              change to assistive tech users.
            </p>
            <div className={styles.dialogActions}>
              <button
                type="button"
                className={`${styles.button} ${styles.secondary}`}
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => {
                  setShowError(false);
                  closeDialog();
                }}
              >
                Confirm reconciliation
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
