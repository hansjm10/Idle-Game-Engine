import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const isPreview = (process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT ?? '').includes('preview');

test.describe('Economy preview accessibility', () => {
  test('hard-currency balances, errors, and reconciliation dialog are accessible', async ({ page }) => {
    await page.goto('/');
    const heading = page.getByRole('heading', { name: /Hard Currency Wallet \(Preview\)/i });
    await heading.waitFor();

    const table = page.getByRole('table', { name: /Hard currency balances/i });
    await expect(table).toBeVisible();
    const rowCount = await table.getByRole('row').count();
    expect(rowCount).toBeGreaterThan(1);

    // Simulate rejected spend and verify alert semantics
    await page.getByRole('button', { name: /rejected spend/i }).click();
    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible();
    await page.getByRole('button', { name: /Clear error/i }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Dialog semantics and focus return
    const dialogTrigger = page.getByRole('button', { name: /reconciliation dialog/i });
    await dialogTrigger.click();
    const dialog = page.getByRole('dialog', { name: /Reconcile hard currency balance/i });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    const cancelButton = dialog.getByRole('button', { name: /Cancel/i });
    await cancelButton.focus();
    await expect(cancelButton).toBeFocused();
    await cancelButton.click();
    await expect(dialog).toBeHidden();
    await expect(dialogTrigger).toBeFocused();

    // WCAG A/AA check scoped to the panel
    const axe = new AxeBuilder({ page });
    if (!isPreview) {
      axe.include('section');
    }
    const { violations } = await axe
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => [
          `${v.id} (${v.impact ?? 'no-impact'})`,
          v.help,
          ...v.nodes.map((n) => `  - ${n.target.join(' ')}`)
        ].join('\n'))
        .join('\n\n');
      console.error('Accessibility violations detected (economy preview):\n' + formatted);
    }
    expect(violations, `Found ${violations.length} accessibility violation(s).`).toHaveLength(0);
  });
});
