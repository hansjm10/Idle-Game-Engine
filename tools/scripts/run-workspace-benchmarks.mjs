#!/usr/bin/env node

import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

const WORKSPACE_ROOTS = ['packages', 'services', 'tools'];
const ARTIFACT_ROOT = path.join('artifacts', 'benchmarks');
const BENCHMARK_EVENT = 'benchmark_run_end';

async function main() {
  await fs.rm(ARTIFACT_ROOT, {recursive: true, force: true});

  const packages = await collectPackages();
  const benchmarkPackages = [];

  for (const pkg of packages) {
    if (pkg.scripts?.benchmark) {
      benchmarkPackages.push(pkg);
    }
  }

  if (benchmarkPackages.length === 0) {
    throw new Error('No workspace packages define a "benchmark" script.');
  }

  let artifactsWritten = 0;
  for (const pkg of benchmarkPackages) {
    const {stdout} = await runBenchmark(pkg.name);
    const payloads = extractBenchmarkPayloads(stdout);
    if (payloads.length === 0) {
      throw new Error(`No benchmark payloads emitted for ${pkg.name}.`);
    }
    artifactsWritten += await writeArtifacts(pkg.name, payloads);
  }

  console.log(`[benchmarks] Wrote ${artifactsWritten} artifact(s) to ${ARTIFACT_ROOT}.`);
}

async function collectPackages() {
  const packages = [];

  for (const root of WORKSPACE_ROOTS) {
    if (!(await exists(root))) {
      continue;
    }

    const entries = await fs.readdir(root, {withFileTypes: true});
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dir = path.join(root, entry.name);
      const packageJsonPath = path.join(dir, 'package.json');
      if (!(await exists(packageJsonPath))) {
        continue;
      }

      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      packages.push({
        name: packageJson.name ?? dir,
        scripts: packageJson.scripts ?? {}
      });
    }
  }

  return packages;
}

async function runBenchmark(packageName) {
  return runCommand('pnpm', ['--filter', packageName, 'run', 'benchmark']);
}

async function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${code}\n${stderr}`));
        return;
      }

      resolve({stdout, stderr});
    });
  });
}

function extractBenchmarkPayloads(output) {
  const payloads = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (isBenchmarkPayload(parsed)) {
        payloads.push(parsed);
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }

  return payloads;
}

function isBenchmarkPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.event !== BENCHMARK_EVENT) {
    return false;
  }
  if (!payload.benchmark || typeof payload.benchmark.name !== 'string') {
    return false;
  }
  return true;
}

async function writeArtifacts(packageName, payloads) {
  const packageDir = path.join(ARTIFACT_ROOT, ...packageName.split('/'));
  await fs.mkdir(packageDir, {recursive: true});

  let written = 0;
  for (const payload of payloads) {
    const benchmarkName = payload.benchmark?.name;
    if (typeof benchmarkName !== 'string' || benchmarkName.length === 0) {
      throw new Error(`Benchmark payload missing name for package ${packageName}.`);
    }

    const fileName = `${sanitizeFileName(benchmarkName)}.json`;
    const filePath = path.join(packageDir, fileName);
    await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    written += 1;
  }

  return written;
}

function sanitizeFileName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^(?:-+)|(?:-+)$/g, '');
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

try {
  await main();
} catch (error) {
  console.error('[benchmarks] Failed to generate benchmark artifacts.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
