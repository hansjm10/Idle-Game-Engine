import { test, expect } from '@playwright/test';

test.describe('ShellStateProvider restore flow', () => {
  test('does not trigger Maximum update depth errors while idle', async ({ page }) => {
    let restoreLoopError: string | null = null;

    const handleConsole = (message: import('@playwright/test').ConsoleMessage) => {
      if (
        message.type() === 'error' &&
        message.text().includes('Maximum update depth exceeded')
      ) {
        restoreLoopError = message.text();
      }
    };

    page.on('console', handleConsole);

    await page.goto('/');
    await page.waitForTimeout(12000);

    page.off('console', handleConsole);

    expect(
      restoreLoopError,
      'ShellStateProvider should not enter a restore loop that trips React depth limits',
    ).toBeNull();
  });

  test('diagnostics toggle is stable under dev StrictMode', async ({ page }) => {
    let depthError: string | null = null;

    const onConsole = (message: import('@playwright/test').ConsoleMessage) => {
      if (
        message.type() === 'error' &&
        message.text().includes('Maximum update depth exceeded')
      ) {
        depthError = message.text();
      }
    };
    page.on('console', onConsole);

    await page.goto('/');
    const toggle = page.getByRole('button', { name: /Show Diagnostics|Hide Diagnostics/i });
    for (let i = 0; i < 3; i++) {
      await toggle.click();
      await page.waitForTimeout(200);
      await toggle.click();
      await page.waitForTimeout(200);
    }

    page.off('console', onConsole);

    expect(
      depthError,
      'Diagnostics toggle should not cause React depth-limit errors in dev',
    ).toBeNull();
  });
});
