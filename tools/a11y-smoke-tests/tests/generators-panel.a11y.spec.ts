import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const isPreview = (process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT ?? '').includes('preview');

test.describe('Generators panel accessibility', () => {
  test('cards and Buy buttons expose correct roles/states; no A/AA violations', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('main').waitFor();

    // Generators heading should render when progression UI is enabled
    await page.getByRole('heading', { name: /Generators/i, level: 2 }).waitFor();

    if (!isPreview) {
      // Each generator card is a group labeled with the generator name
      const cards = page.getByRole('group', { name: /generator$/i });
      // Allow empty-state when generators are not yet visible
      if (await cards.count() > 0) {
        await expect(cards.first()).toBeVisible();
      }

      // Validate Buy 1 button states are consistent (disabled matches aria-disabled)
      const buttons = page.getByRole('button', { name: /^Buy 1$/i });
      if (await buttons.count() > 0) {
        await expect(buttons.first()).toBeVisible();
        const buttonCount = await buttons.count();
        let disabledSeen = false;
        for (let i = 0; i < buttonCount; i++) {
          const btn = buttons.nth(i);
          const ariaDisabled = await btn.getAttribute('aria-disabled');
          const isDisabled = await btn.isDisabled();
          // aria-disabled should reflect the actual disabled state
          expect(String(isDisabled)).toBe((ariaDisabled ?? 'false').toLowerCase());
          disabledSeen = disabledSeen || isDisabled;
        }
        // At least one button is often disabled initially
        expect(disabledSeen).toBe(true);
      }
    }

    // Axe A/AA check on main content
    const axe = new AxeBuilder({ page });
    if (!isPreview) {
      axe.include('main');
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
      console.error('Accessibility violations detected (generators):\n' + formatted);
    }

    expect(violations, `Found ${violations.length} accessibility violation(s).`).toHaveLength(0);
  });
});
