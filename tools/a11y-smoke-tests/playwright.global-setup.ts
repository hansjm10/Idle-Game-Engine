import type { FullConfig } from '@playwright/test';

const DEFAULT_WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.PLAYWRIGHT_A11Y_SERVER_CHECK_TIMEOUT ?? '15000',
  10,
);
const RETRY_DELAY_MS = 500;
const SKIP_SERVER_CHECK = coerceBoolean(
  process.env.PLAYWRIGHT_A11Y_SKIP_SERVER_CHECK,
);

export default async function globalSetup(config: FullConfig) {
  if (SKIP_SERVER_CHECK) {
    return;
  }

  const expectedProject = process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT ?? null;
  let urlsToCheck = collectProjectUrls(config, expectedProject);
  let requireAll = Boolean(expectedProject);

  if (urlsToCheck.length === 0 && expectedProject) {
    // Fall back to best-effort checks when the requested project name is unknown.
    urlsToCheck = collectProjectUrls(config, null);
    requireAll = false;
  }

  if (urlsToCheck.length === 0) {
    return;
  }

  let reachableCount = 0;
  for (const entry of urlsToCheck) {
    const reachable = await waitForUrl(entry.url, DEFAULT_WAIT_TIMEOUT_MS);
    if (reachable) {
      reachableCount += 1;
      continue;
    }

    if (requireAll) {
      throw new Error(
        `Failed to reach ${entry.url} before running Playwright tests for project "${entry.name}". ` +
          'Use "pnpm test:a11y" (or "node ./scripts/run-playwright.cjs") so the harness can start the dev/preview servers, ' +
          'or start compatible servers manually and rerun with PLAYWRIGHT_A11Y_SKIP_SERVER_CHECK=1 once they are ready.',
      );
    }
  }

  if (!requireAll && reachableCount === 0) {
    const urlList = urlsToCheck.map((entry) => entry.url).join(', ');
    throw new Error(
      `Failed to reach any configured base URLs (${urlList}). ` +
        'Start a compatible dev/preview server or run "pnpm test:a11y" so the harness can manage the lifecycle automatically.',
    );
  }
}

type ProjectUrlEntry = {
  name: string;
  url: string;
};

function collectProjectUrls(config: FullConfig, projectName: string | null): ProjectUrlEntry[] {
  const entries: ProjectUrlEntry[] = [];
  const seen = new Set<string>();

  for (const project of config.projects) {
    if (projectName && project.name !== projectName) {
      continue;
    }
    const url = project.use?.baseURL;
    if (typeof url !== 'string' || !url.startsWith('http')) {
      continue;
    }
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    entries.push({
      name: project.name ?? 'unknown',
      url,
    });
  }

  return entries;
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok || response.status === 404) {
        return true;
      }
    } catch {
      // Ignore connection errors and retry until timeout.
    }
    await delay(RETRY_DELAY_MS);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coerceBoolean(value?: string | null): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}
