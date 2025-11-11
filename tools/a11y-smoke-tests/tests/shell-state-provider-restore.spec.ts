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
});
