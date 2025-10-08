import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Landing page accessibility', () => {
  test('has no WCAG 2.1 A/AA violations', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('main');

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    if (violations.length > 0) {
      const formatted = violations
        .map((violation) => {
          const nodes = violation.nodes
            .map((node) => `    - ${node.target.join(' ')}`)
            .join('\n');

          return [
            `${violation.id} (${violation.impact ?? 'no-impact'})`,
            violation.help,
            nodes ? nodes : '    - no target selectors reported'
          ].join('\n');
        })
        .join('\n\n');

      console.error('Accessibility violations detected:\n' + formatted);
    }

    expect(violations, `Found ${violations.length} accessibility violation(s). See console output for details.`).toHaveLength(0);
  });
});
