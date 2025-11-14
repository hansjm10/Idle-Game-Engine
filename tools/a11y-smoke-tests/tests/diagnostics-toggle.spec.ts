import { test, expect } from '@playwright/test';

test.describe('Diagnostics toggle stability', () => {
  test('toggling diagnostics does not trigger React depth-limit errors', async ({ page }) => {
    let depthError: string | null = null;

    const onConsole = (msg: import('@playwright/test').ConsoleMessage) => {
      if (msg.type() === 'error' && msg.text().includes('Maximum update depth exceeded')) {
        depthError = msg.text();
      }
    };

    page.on('console', onConsole);

    await page.goto('/');

    const toggle = page.getByRole('button', { name: /Show Diagnostics|Hide Diagnostics/i });

    // Toggle open/close a few times to exercise subscribe/unsubscribe cleanup paths
    for (let i = 0; i < 3; i++) {
      await toggle.click();
      // Allow a brief window for updates and deferred cleanup reconciliation
      await page.waitForTimeout(200);
      await toggle.click();
      await page.waitForTimeout(200);
    }

    page.off('console', onConsole);

    expect(
      depthError,
      'Diagnostics toggle should not cause "Maximum update depth exceeded" errors',
    ).toBeNull();
  });
});

