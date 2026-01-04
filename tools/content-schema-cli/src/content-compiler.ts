import type { StdioOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Constants
// ============================================================================

const PACKAGE_NAME = '@idle-engine/content-compiler';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// ============================================================================
// Types
// ============================================================================

type ContentCompilerModule = typeof import('@idle-engine/content-compiler');

export interface SpawnProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: StdioOptions;
}

export interface SpawnProcessResult {
  code: number | null;
  error?: Error;
}

export interface ContentCompilerDependencies {
  importCompiler: () => Promise<ContentCompilerModule>;
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnProcessOptions,
  ) => Promise<SpawnProcessResult>;
}

export interface LoadContentCompilerOptions {
  projectRoot?: string;
  dependencies?: Partial<ContentCompilerDependencies>;
}

export interface BuildContentCompilerOptions {
  projectRoot: string;
  packageName?: string;
  stdio?: StdioOptions;
  env?: NodeJS.ProcessEnv;
  dependencies?: Pick<ContentCompilerDependencies, 'spawnProcess'>;
}

// ============================================================================
// Pure Helper Functions
// ============================================================================

export function isModuleNotFoundError(
  error: unknown,
  packageName: string,
): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
    return false;
  }

  const errorWithMessage = error as { message?: unknown };
  const stringified = String(error);
  let message: string;
  if (typeof errorWithMessage.message === 'string') {
    message = errorWithMessage.message;
  } else if (stringified !== '[object Object]') {
    message = stringified;
  } else {
    message = JSON.stringify(error);
  }
  return message.includes(packageName);
}

// ============================================================================
// Default Implementations
// ============================================================================

async function defaultImportCompiler(): Promise<ContentCompilerModule> {
  return import(PACKAGE_NAME);
}

async function defaultSpawnProcess(
  command: string,
  args: string[],
  options: SpawnProcessOptions,
): Promise<SpawnProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    });

    child.on('error', (error) => {
      resolve({ code: null, error });
    });

    child.on('exit', (code) => {
      resolve({ code });
    });
  });
}

// ============================================================================
// Main Functions
// ============================================================================

export async function buildContentCompiler(
  options: BuildContentCompilerOptions,
): Promise<void> {
  const packageName = options.packageName ?? PACKAGE_NAME;
  const deps = {
    spawnProcess: defaultSpawnProcess,
    ...options.dependencies,
  };

  const result = await deps.spawnProcess(
    'pnpm',
    ['--filter', packageName, 'run', 'build'],
    {
      cwd: options.projectRoot,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.code !== 0) {
    throw new Error(
      `Failed to build ${packageName} before running content compilation (exit code ${result.code}).`,
    );
  }
}

export async function loadContentCompiler(
  options: LoadContentCompilerOptions = {},
): Promise<ContentCompilerModule> {
  const projectRoot = options.projectRoot ?? REPO_ROOT;
  const deps: ContentCompilerDependencies = {
    importCompiler: defaultImportCompiler,
    spawnProcess: defaultSpawnProcess,
    ...options.dependencies,
  };

  let firstError: Error | undefined;
  try {
    return await deps.importCompiler();
  } catch (error) {
    if (!isModuleNotFoundError(error, PACKAGE_NAME)) {
      throw error;
    }
    firstError = error as Error;
  }

  await buildContentCompiler({
    projectRoot,
    dependencies: { spawnProcess: deps.spawnProcess },
  });

  try {
    return await deps.importCompiler();
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
