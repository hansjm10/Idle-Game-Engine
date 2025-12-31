import type { ChildProcess, SpawnOptions, StdioOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@idle-engine/content-compiler';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

type ContentCompilerModule = typeof import('@idle-engine/content-compiler');

const defaultImport = (): Promise<ContentCompilerModule> => import(PACKAGE_NAME);

export interface LoadContentCompilerOptions {
  projectRoot?: string;
  importCompiler?: () => Promise<ContentCompilerModule>;
  buildCompiler?: (options: BuildContentCompilerOptions) => Promise<void>;
}

export interface BuildContentCompilerOptions {
  projectRoot?: string;
  spawn?: typeof spawn;
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
}

export async function loadContentCompiler(
  options: LoadContentCompilerOptions = {},
): Promise<ContentCompilerModule> {
  const projectRoot = options.projectRoot ?? REPO_ROOT;
  const importCompiler = options.importCompiler ?? defaultImport;
  const buildCompiler =
    options.buildCompiler ??
    ((buildOptions: BuildContentCompilerOptions) =>
      buildContentCompiler({
        ...buildOptions,
        projectRoot,
      }));

  let firstError: Error | undefined;
  try {
    return await importCompiler();
  } catch (error) {
    if (!isCompilerModuleNotFound(error)) {
      throw error;
    }
    firstError = error as Error;
  }

  await buildCompiler({ projectRoot });

  try {
    return await importCompiler();
  } catch (error) {
    if (firstError && error instanceof Error) {
      const errorWithCause = error as Error & { cause?: unknown };
      if (errorWithCause.cause === undefined) {
        errorWithCause.cause = firstError;
      }
    }
    throw error;
  }
}

export async function buildContentCompiler(
  options: BuildContentCompilerOptions = {},
): Promise<void> {
  const projectRoot = options.projectRoot ?? REPO_ROOT;
  const spawnProcess = options.spawn ?? spawn;
  const stdio = options.stdio ?? 'inherit';

  await new Promise<void>((resolve, reject) => {
    const child: ChildProcess = spawnProcess(
      'pnpm',
      ['--filter', PACKAGE_NAME, 'run', 'build'],
      {
        cwd: projectRoot,
        env: options.env ?? process.env,
        stdio,
      } as SpawnOptions,
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

interface ErrorWithCode {
  code?: unknown;
}

function isCompilerModuleNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const code = (error as ErrorWithCode).code;
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
