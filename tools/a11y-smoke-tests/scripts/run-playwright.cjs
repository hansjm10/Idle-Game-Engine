#!/usr/bin/env node

const { startAndTest } = require('start-server-and-test');

const rawArgs = process.argv.slice(2);
const forwardedArgs = rawArgs.filter((arg) => arg !== '--');
const hasUiFlag = forwardedArgs.some((arg) => arg === '--ui' || arg.startsWith('--ui='));

if (hasUiFlag) {
  console.error('The Playwright UI (--ui) runner is disabled for these smoke tests.');
  process.exit(1);
}

const DEFAULT_HOST = '127.0.0.1';
const INVALID_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const configuredHost = process.env.PLAYWRIGHT_PREVIEW_HOST ?? process.env.HOST;
const HOST = configuredHost && !INVALID_HOSTS.has(configuredHost) ? configuredHost : DEFAULT_HOST;

const PREVIEW_PORT = Number.parseInt(process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173', 10);
const DEV_PORT = Number.parseInt(process.env.PLAYWRIGHT_DEV_PORT ?? '5173', 10);
const isCI = process.env.CI === 'true' || process.env.CI === '1';

const reporterAlreadyProvided = forwardedArgs.some((arg) => {
  if (arg === '--reporter' || arg === '-r') {
    return true;
  }

  return arg.startsWith('--reporter=') || arg.startsWith('-r=');
});
const reporterFlag = isCI && !reporterAlreadyProvided ? '--reporter=line' : '';

const quoteArg = (arg) => {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(arg)) {
    return arg;
  }

  return '"' + arg.replace(/(["$`\\])/g, '\\$1') + '"';
};

const serializedArgs = forwardedArgs.map(quoteArg).join(' ');

const previewServerCommand = `pnpm --filter @idle-engine/shell-web run preview -- --host ${HOST} --port ${PREVIEW_PORT} --strictPort`;
const devServerCommand = `pnpm --filter @idle-engine/shell-web run dev -- --host ${HOST} --port ${DEV_PORT} --strictPort`;

const buildPlaywrightCommand = (project) => {
  const parts = [
    'pnpm --filter @idle-engine/a11y-smoke-tests exec playwright test',
    `--project=${project}`
  ];

  if (reporterFlag) {
    parts.push(reporterFlag);
  }

  if (serializedArgs) {
    parts.push(serializedArgs);
  }

  return parts.join(' ');
};

const runWithServer = async (startCommand, port, projectName) => {
  await startAndTest({
    services: [
      {
        start: startCommand,
        url: `tcp:${HOST}:${port}`
      }
    ],
    test: buildPlaywrightCommand(projectName),
    namedArguments: {
      expect: 200
    }
  });
};

runWithServer(previewServerCommand, PREVIEW_PORT, 'chromium-preview')
  .then(() => runWithServer(devServerCommand, DEV_PORT, 'chromium-dev'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
