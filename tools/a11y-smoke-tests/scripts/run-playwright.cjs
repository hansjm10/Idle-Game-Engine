#!/usr/bin/env node

const { startAndTest } = require('start-server-and-test');
const { spawn } = require('node:child_process');
const net = require('node:net');

const rawArgs = process.argv.slice(2);
const forwardedArgs = rawArgs.filter((arg) => arg !== '--');
const hasUiFlag = forwardedArgs.some((arg) => arg === '--ui' || arg.startsWith('--ui='));

if (hasUiFlag) {
  console.error('The Playwright UI (--ui) runner is disabled for these smoke tests.');
  process.exit(1);
}

const { filteredArgs, requestedProjects } = extractProjectSelections(forwardedArgs);

const DEFAULT_HOST = '127.0.0.1';
const INVALID_HOSTS = new Set(['0.0.0.0', '::', '[::]']);
const configuredHost = process.env.PLAYWRIGHT_PREVIEW_HOST ?? process.env.HOST;
const HOST = configuredHost && !INVALID_HOSTS.has(configuredHost) ? configuredHost : DEFAULT_HOST;

const PREVIEW_PORT = Number.parseInt(process.env.PLAYWRIGHT_PREVIEW_PORT ?? '4173', 10);
const DEV_PORT = Number.parseInt(process.env.PLAYWRIGHT_DEV_PORT ?? '5173', 10);
const isCI = process.env.CI === 'true' || process.env.CI === '1';

const reporterAlreadyProvided = filteredArgs.some((arg) => {
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

const serializedArgs = filteredArgs.map(quoteArg).join(' ');

const PROJECTS = [
  {
    playwrightName: 'chromium-preview',
    label: 'preview',
    host: HOST,
    port: PREVIEW_PORT,
    baseUrl: `http://${HOST}:${PREVIEW_PORT}`,
    startCommand: `pnpm --filter @idle-engine/shell-web run preview -- --host ${HOST} --port ${PREVIEW_PORT} --strictPort`
  },
  {
    playwrightName: 'chromium-dev',
    label: 'dev',
    host: HOST,
    port: DEV_PORT,
    baseUrl: `http://${HOST}:${DEV_PORT}`,
    startCommand: `pnpm --filter @idle-engine/shell-web run dev -- --host ${HOST} --port ${DEV_PORT} --strictPort`
  }
];

const knownProjectNames = new Set(PROJECTS.map((project) => project.playwrightName));

const projectsToRun = (requestedProjects.length > 0
  ? dedupe(requestedProjects).map((name) => {
      if (!knownProjectNames.has(name)) {
        console.error(`Unknown Playwright project "${name}". Known projects: ${Array.from(knownProjectNames).join(', ')}`);
        process.exit(1);
      }
      return PROJECTS.find((project) => project.playwrightName === name);
    })
  : PROJECTS).filter(Boolean);

const runSequentially = async () => {
  for (const project of projectsToRun) {
    await runProject(project);
  }
};

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

async function runProject(project) {
  const command = buildPlaywrightCommand(project.playwrightName);
  const previousExpectedProject = process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT;
  process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT = project.playwrightName;

  try {
    const portInUse = await isPortReachable(project.host, project.port);

    if (portInUse) {
      console.log(`[a11y] Reusing existing ${project.label} server at ${project.baseUrl}`);
      await waitForExistingServer(project.baseUrl);
      await runPlaywrightCommand(command);
      return;
    }

    await startAndTest({
      services: [
        {
          start: project.startCommand,
          url: `tcp:${project.host}:${project.port}`
        }
      ],
      test: command,
      namedArguments: {
        expect: 200
      }
    });
  } finally {
    if (previousExpectedProject === undefined) {
      delete process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT;
    } else {
      process.env.PLAYWRIGHT_A11Y_EXPECTED_PROJECT = previousExpectedProject;
    }
  }
}

function extractProjectSelections(args) {
  const filtered = [];
  const requested = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (arg === '--project' || arg === '-p') {
      const value = args[index + 1];
      if (!value) {
        console.error('Missing value for --project flag.');
        process.exit(1);
      }
      requested.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--project=') || arg.startsWith('-p=')) {
      const [, value] = arg.split('=');
      if (!value) {
        console.error('Missing value for --project flag.');
        process.exit(1);
      }
      requested.push(value);
      continue;
    }

    filtered.push(arg);
  }

  return { filteredArgs: filtered, requestedProjects: requested };
}

function dedupe(list) {
  return Array.from(new Set(list));
}

function runPlaywrightCommand(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Playwright exited with code ${code}`));
      }
    });
  });
}

function isPortReachable(host, port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const cleanup = () => {
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);
    socket.once('error', () => {
      cleanup();
      resolve(false);
    });
    socket.once('timeout', () => {
      cleanup();
      resolve(false);
    });
    socket.connect(port, host, () => {
      cleanup();
      resolve(true);
    });
  });
}

async function waitForExistingServer(url, timeoutMs = 120_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await canFetchUrl(url)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for server at ${url}`);
}

async function canFetchUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);

  try {
    await fetch(url, { method: 'GET', signal: controller.signal });
    return true;
  } catch (error) {
    if (error.name !== 'AbortError') {
      // Ignore connection errors and retry until timeout
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

runSequentially().catch((error) => {
  console.error(error);
  process.exit(1);
});
