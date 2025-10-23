import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@idle-engine/content-compiler';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const defaultImport = () => import(PACKAGE_NAME);

export async function loadContentCompiler(options = {}) {
  const projectRoot = options.projectRoot ?? REPO_ROOT;
  const importCompiler = options.importCompiler ?? defaultImport;
  const buildCompiler =
    options.buildCompiler ??
    ((buildOptions) =>
      buildContentCompiler({
        ...buildOptions,
        projectRoot,
      }));

  let firstError;
  try {
    return await importCompiler();
  } catch (error) {
    if (!isCompilerModuleNotFound(error)) {
      throw error;
    }
    firstError = error;
  }

  await buildCompiler({ projectRoot });

  try {
    return await importCompiler();
  } catch (error) {
    if (firstError && error instanceof Error && error.cause === undefined) {
      error.cause = firstError;
    }
    throw error;
  }
}

export async function buildContentCompiler(options = {}) {
  const projectRoot = options.projectRoot ?? REPO_ROOT;
  const spawnProcess = options.spawn ?? spawn;
  const stdio = options.stdio ?? 'inherit';

  await new Promise((resolve, reject) => {
    const child = spawnProcess(
      'pnpm',
      ['--filter', PACKAGE_NAME, 'run', 'build'],
      {
        cwd: projectRoot,
        env: options.env ?? process.env,
        stdio,
      },
    );

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Failed to build ${PACKAGE_NAME} before running content compilation (exit code ${code}).`,
        ),
      );
    });
  });
}

function isCompilerModuleNotFound(error) {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const code = /** @type {{ code?: unknown }} */ (error).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return false;
  }

  const message = String(
    error instanceof Error && error.message !== undefined
      ? error.message
      : error,
  );
  return message.includes(PACKAGE_NAME);
}
