import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { ResourceView, UpgradeView } from '@idle-engine/core';

import { useShellBridge, useShellProgression } from './ShellStateProvider.js';
import { formatResourceAmount } from './ResourceDashboard.js';
import styles from './UpgradeModal.module.css';

function hasSufficientFunds(costs: readonly { resourceId: string; amount: number }[] | undefined, resources: readonly ResourceView[]): boolean {
  if (!costs || costs.length === 0) {
    return true;
  }
  for (const cost of costs) {
    const r = resources.find((res) => res.id === cost.resourceId);
    if (!r || r.amount < cost.amount) {
      return false;
    }
  }
  return true;
}

interface UpgradeModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function UpgradeModal({ open, onClose }: UpgradeModalProps): JSX.Element | null {
  const progression = useShellProgression();
  const bridge = useShellBridge();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const upgrades = progression.selectUpgrades();
  const resources = progression.selectOptimisticResources() ?? [];

  // Derive visible list unconditionally so Hooks order remains stable
  const visibleUpgrades = useMemo(
    () => (upgrades ?? []).filter((u) => u.isVisible),
    [upgrades],
  );

  // Manage focus trap and restore on close
  useEffect(() => {
    if (!open) {
      return;
    }
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!dialog) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) {
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, onClose]);

  // Bridge error toasts
  useEffect(() => {
    if (!open) return;
    const onError = (error: unknown) => {
      // Clear any optimistic pending deltas when a command fails
      progression.clearPendingDeltas();
      setErrorMessage(
        error instanceof Error ? error.message : 'An error occurred while processing your request.',
      );
    };
    bridge.onError(onError);
    return () => bridge.offError(onError);
  }, [open, bridge, progression]);

  if (!open) return null;

  const handlePurchase = (upgrade: UpgradeView) => {
    // Stage negative deltas for optimistic feedback
    if (upgrade.costs) {
      for (const cost of upgrade.costs) {
        if (cost.amount > 0) {
          progression.stageResourceDelta(cost.resourceId, -cost.amount);
        }
      }
    }
    try {
      bridge.sendCommand('PURCHASE_UPGRADE', {
        upgradeId: upgrade.id,
      });
    } catch {
      progression.clearPendingDeltas();
      setErrorMessage('Upgrade purchase failed. Please try again.');
    }
  };

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="upgrade-modal-title">
      <div
        ref={dialogRef}
        className={styles.dialog}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id="upgrade-modal-title" className={styles.title}>Upgrades</h2>
          <button type="button" className={styles.closeButton} onClick={onClose} aria-label="Close upgrades">
            Close
          </button>
        </div>
        <div className={styles.content}>
          {visibleUpgrades.length === 0 ? (
            <div role="status">No upgrades available.</div>
          ) : (
            visibleUpgrades.map((u) => {
              const canAfford = hasSufficientFunds(u.costs, resources);
              const isAvailable = u.status === 'available';
              const disabled = !isAvailable || !canAfford;
              return (
                <div key={u.id} className={styles.upgradeRow} role="group" aria-label={`${u.displayName} upgrade`}>
                  <div>
                    <div className={styles.upgradeName}>{u.displayName}</div>
                    <div className={styles.upgradeMeta}>
                      {u.status === 'locked' && u.unlockHint ? (
                        <span>Locked — {u.unlockHint}</span>
                      ) : u.status === 'purchased' ? (
                        <span>Purchased</span>
                      ) : (
                        <span>
                          {u.costs?.map((c, idx) => (
                            <span key={`${c.resourceId}-${idx}`}>
                              {idx > 0 ? ', ' : ''}
                              {formatResourceAmount(c.amount)} {c.resourceId.split('.').pop()}
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <button
                      type="button"
                      className={styles.purchaseButton}
                      disabled={disabled}
                      aria-disabled={disabled}
                      aria-label={`Purchase ${u.displayName}`}
                      onClick={() => handlePurchase(u)}
                    >
                      Purchase
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {errorMessage ? (
          <div className={styles.toast} role="alert" aria-live="assertive">{errorMessage}</div>
        ) : null}
      </div>
    </div>
  );
}
