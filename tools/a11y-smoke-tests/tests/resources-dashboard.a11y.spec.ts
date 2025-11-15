import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const isPreview = (process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT ?? '').includes('preview');

test.describe('Resources dashboard accessibility', () => {
  test('renders table semantics and valid progressbar ARIA; no A/AA violations', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('main').waitFor();

    // Section + heading present
    await page.getByRole('heading', { name: /Resources/i, level: 2 }).waitFor();

    // Table structure renders
    if (!isPreview) {
      const table = page.getByRole('table', { name: /Resource inventory/i });
      if (await table.count() > 0) {
        await table.first().waitFor();
        // At least one data row (beyond header) should be visible
        const rows = table.getByRole('row');
        await expect(rows.nth(1)).toBeVisible();
      } else {
        // Fallback states are acceptable while data loads or before unlocks
        await expect(
          page.getByRole('status', { name: /Loading resource data|Resource progression is locked/i }),
        ).toBeVisible();
      }
    }

    // Validate progressbar ARIA if present (capacity resources)
    if (!isPreview) {
      const progressbars = page.getByRole('progressbar');
      if (await progressbars.count() > 0) {
        const pb = progressbars.first();
        const ariaMin = await pb.getAttribute('aria-valuemin');
        const ariaMax = await pb.getAttribute('aria-valuemax');
        const ariaNow = await pb.getAttribute('aria-valuenow');
        const ariaText = await pb.getAttribute('aria-valuetext');

        expect(ariaMin).not.toBeNull();
        expect(ariaMax).not.toBeNull();
        expect(ariaNow).not.toBeNull();
        expect(ariaText).not.toBeNull();

        const min = Number(ariaMin);
        const max = Number(ariaMax);
        const now = Number(ariaNow);
        expect(Number.isFinite(min)).toBe(true);
        expect(Number.isFinite(max)).toBe(true);
        expect(Number.isFinite(now)).toBe(true);
        expect(min).toBe(0);
        expect(now).toBeGreaterThanOrEqual(min);
        expect(now).toBeLessThanOrEqual(max);
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
      console.error('Accessibility violations detected:\n' + formatted);
    }

    expect(violations, `Found ${violations.length} accessibility violation(s).`).toHaveLength(0);
  });
});
