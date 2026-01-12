#!/usr/bin/env node

/**
 * Validates that RUNTIME_VERSION in version.ts matches the package.json version.
 *
 * This script ensures version synchronization between the package version and
 * the runtime version constant used for persistence schema validation and
 * telemetry correlation.
 *
 * Exit codes:
 * - 0: Versions match
 * - 1: Versions mismatch or validation error
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');

async function validateRuntimeVersion() {
  try {
    // Read package.json version
    const packageJsonPath = join(projectRoot, 'packages/core/package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);
    const packageVersion = packageJson.version;

    if (!packageVersion) {
      console.error('❌ Error: Could not find version in packages/core/package.json');
      process.exit(1);
    }

    // Read version.ts and extract RUNTIME_VERSION
    const versionTsPath = join(projectRoot, 'packages/core/src/version.ts');
    const versionTsContent = await readFile(versionTsPath, 'utf-8');

    // Match: export const RUNTIME_VERSION = '0.1.0';
    const runtimeVersionMatch = versionTsContent.match(
      /export\s+const\s+RUNTIME_VERSION\s*=\s*['"]([^'"]+)['"]/
    );

    if (!runtimeVersionMatch) {
      console.error('❌ Error: Could not find RUNTIME_VERSION export in packages/core/src/version.ts');
      console.error('   Expected format: export const RUNTIME_VERSION = \'x.y.z\';');
      process.exit(1);
    }

    const runtimeVersion = runtimeVersionMatch[1];

    // Compare versions
    if (packageVersion !== runtimeVersion) {
      console.error('❌ Version mismatch detected!');
      console.error('');
      console.error('   packages/core/package.json version:  ' + packageVersion);
      console.error('   packages/core/src/version.ts:        ' + runtimeVersion);
      console.error('');
      console.error('   These versions must match for proper session snapshot compatibility.');
      console.error('');
      console.error('   To fix:');
      console.error('   1. Update RUNTIME_VERSION in packages/core/src/version.ts to match package.json');
      console.error('   2. Update the test expectation in packages/core/src/version.test.ts');
      console.error('   3. Run tests to ensure the change is intentional');
      console.error('');
      process.exit(1);
    }

    // Success
    console.log('✅ Runtime version validation passed');
    console.log(`   Version: ${packageVersion}`);
    process.exit(0);

  } catch (error) {
    console.error('❌ Error during version validation:', error.message);
    process.exit(1);
  }
}

await validateRuntimeVersion();
