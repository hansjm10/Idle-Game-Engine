import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Upgrades modal accessibility', () => {
  test('dialog semantics, focus trap, escape/restore focus; no A/AA violations', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('main').waitFor();

    const openButton = page.getByRole('button', { name: /Open Upgrades/i });
    await openButton.waitFor();
    await openButton.scrollIntoViewIfNeeded();

    // Open the upgrades modal
    await openButton.click();

    // Dialog present, modal, and labeled by title
    const dialog = page.getByRole('dialog', { name: /^Upgrades$/i });
    await dialog.waitFor();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Focus should be within the dialog; Shift+Tab should remain in dialog (trap)
    // Ensure something inside is focusable
    const closeButton = dialog.getByRole('button', { name: /Close upgrades/i });
    await closeButton.waitFor();

    // Verify tab trapping cycles within dialog
    await page.keyboard.press('Shift+Tab');
    // Check the active element remains within the dialog
    const activeInDialog = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(activeInDialog).toBe(true);

    // Axe check limited to the dialog region
    const { violations } = await new AxeBuilder({ page })
      .include('role=dialog')
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
      console.error('Accessibility violations detected (upgrades dialog):\n' + formatted);
    }
    expect(violations, `Found ${violations.length} accessibility violation(s).`).toHaveLength(0);

    // Escape closes the dialog and focus returns to the opener
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();
  });
});
