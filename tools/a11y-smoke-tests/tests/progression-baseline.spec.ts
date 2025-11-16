import { test, expect } from '@playwright/test';

const PROGRESSION_TIMEOUT_MS = 15000;

test.describe('Progression baseline rendering', () => {
  test('dev/preview shell eventually renders resources and generators', async ({ page }) => {
    page.on('console', (message) => {
      // eslint-disable-next-line no-console
      console.log(
        `[progression-baseline][console:${message.type()}]`,
        message.text(),
      );
    });

    await page.goto('/');
    await page.getByRole('main').waitFor();

    const bridgeDebug = await page.evaluate(async () => {
      const global = window as unknown as {
        __IDLE_WORKER_BRIDGE__?: {
          awaitReady: () => Promise<void>;
        };
      };
      const bridge = global.__IDLE_WORKER_BRIDGE__;
      if (!bridge) {
        return {
          hasDebugHandle: false as const,
          readyState: 'missing' as const,
          tickCount: global.__IDLE_RUNTIME_TICK_COUNT__ ?? 0,
        };
      }

      const readyState = await Promise.race<
        'resolved' | 'rejected' | 'timeout'
      >([
        bridge
          .awaitReady()
          .then(() => 'resolved')
          .catch(() => 'rejected'),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 5000),
        ),
      ]);

      return {
        hasDebugHandle: true as const,
        readyState,
        // Keep shape stable for debugging but avoid relying on internals.
        tickCount: 0,
      };
    });

    // Emit minimal debug context for diagnosing stuck loading in CI runs.
    // eslint-disable-next-line no-console
    console.log('[progression-baseline] worker bridge debug:', bridgeDebug);

    // Resources heading should always be present.
    await page.getByRole('heading', { name: /Resources/i, level: 2 }).waitFor();

    const deadline = Date.now() + PROGRESSION_TIMEOUT_MS;
    let sawResources = false;
    let sawGenerator = false;

    while (Date.now() < deadline && (!sawResources || !sawGenerator)) {
      // Resources: require at least one data row in the resource table.
      const tables = page.getByRole('table', { name: /Resource inventory/i });
      if (await tables.count()) {
        const table = tables.first();
        const rows = table.getByRole('row');
        const rowCount = await rows.count();
        if (rowCount > 1) {
          sawResources = true;
        }
      }

      // Generators: require at least one visible generator card.
      const generatorGroups = page.getByRole('group', { name: /generator$/i });
      if (await generatorGroups.count()) {
        if (await generatorGroups.first().isVisible()) {
          sawGenerator = true;
        }
      }

      if (sawResources && sawGenerator) {
        break;
      }

      // Short backoff to allow the worker/runtime to progress.
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(500);
    }

    expect(
      sawResources,
      'Resources dashboard did not render any resource rows before timing out; UI may be stuck in a loading or locked state.',
    ).toBe(true);

    expect(
      sawGenerator,
      'Generators panel did not render any generator cards before timing out; UI may be stuck in a loading or locked state.',
    ).toBe(true);
  });
});
