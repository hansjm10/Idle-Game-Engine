#!/usr/bin/env node
/**
 * Benchmark runner with baseline comparison.
 *
 * Usage:
 *   node benchmarks/run-benchmarks.mjs                    # Compare against baseline
 *   node benchmarks/run-benchmarks.mjs --update-baseline  # Update baseline file
 *   REGRESSION_THRESHOLD=0.25 node benchmarks/run-benchmarks.mjs  # Custom threshold
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, 'baseline.json');
const BENCHMARK_SCRIPT = join(__dirname, 'validation.bench.mjs');

// Default regression threshold: fail if >25% slower than baseline
const REGRESSION_THRESHOLD = parseFloat(
  process.env.REGRESSION_THRESHOLD ?? '0.25',
);

function runBenchmark() {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn('node', [BENCHMARK_SCRIPT], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: dirname(BENCHMARK_SCRIPT),
    });

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Benchmark exited with code ${code}`));
        return;
      }

      // Find JSON output line
      const jsonLine = stdout.split('\n').find((line) => line.startsWith('{'));
      if (!jsonLine) {
        reject(new Error('No JSON output found in benchmark results'));
        return;
      }

      try {
        resolve(JSON.parse(jsonLine));
      } catch (err) {
        reject(new Error(`Failed to parse benchmark JSON: ${err.message}`));
      }
    });
  });
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return null;
  }
  try {
    const content = readFileSync(BASELINE_PATH, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`Warning: Failed to load baseline: ${err.message}`);
    return null;
  }
}

function saveBaseline(results) {
  writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nBaseline saved to ${BASELINE_PATH}`);
}

function compareResults(current, baseline) {
  const regressions = [];
  const improvements = [];

  // Compare uncached scenarios
  for (const currentScenario of current.results.uncached) {
    const baselineScenario = baseline.results.uncached.find(
      (s) => s.label === currentScenario.label,
    );

    if (!baselineScenario) {
      console.log(`  [new] ${currentScenario.label}: ${currentScenario.stats.meanMs.toFixed(2)}ms`);
      continue;
    }

    const baselineMean = baselineScenario.stats.meanMs;
    const currentMean = currentScenario.stats.meanMs;
    const change = (currentMean - baselineMean) / baselineMean;

    const changeStr =
      change >= 0 ? `+${(change * 100).toFixed(1)}%` : `${(change * 100).toFixed(1)}%`;
    const status = change > REGRESSION_THRESHOLD ? 'REGRESSION' : change < -0.1 ? 'IMPROVED' : 'OK';

    console.log(
      `  ${currentScenario.label}: ${currentMean.toFixed(2)}ms (baseline: ${baselineMean.toFixed(2)}ms, ${changeStr}) [${status}]`,
    );

    if (change > REGRESSION_THRESHOLD) {
      regressions.push({
        label: currentScenario.label,
        baseline: baselineMean,
        current: currentMean,
        change,
      });
    } else if (change < -0.1) {
      improvements.push({
        label: currentScenario.label,
        baseline: baselineMean,
        current: currentMean,
        change,
      });
    }
  }

  // Compare cached scenarios
  for (const currentScenario of current.results.cached) {
    const baselineScenario = baseline.results.cached.find(
      (s) => s.label === currentScenario.label,
    );

    if (!baselineScenario) {
      console.log(`  [new] ${currentScenario.label}: speedup=${(currentScenario.speedup * 100).toFixed(1)}%`);
      continue;
    }

    const baselineSpeedup = baselineScenario.speedup;
    const currentSpeedup = currentScenario.speedup;

    // For speedup, regression means current speedup is lower than baseline
    const speedupChange = currentSpeedup - baselineSpeedup;
    const status =
      speedupChange < -REGRESSION_THRESHOLD ? 'REGRESSION' : speedupChange > 0.05 ? 'IMPROVED' : 'OK';

    console.log(
      `  ${currentScenario.label}: speedup=${(currentSpeedup * 100).toFixed(1)}% (baseline: ${(baselineSpeedup * 100).toFixed(1)}%) [${status}]`,
    );

    if (speedupChange < -REGRESSION_THRESHOLD) {
      regressions.push({
        label: currentScenario.label,
        type: 'speedup',
        baseline: baselineSpeedup,
        current: currentSpeedup,
        change: speedupChange,
      });
    }
  }

  return { regressions, improvements };
}

async function main() {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');

  console.log('Running validation benchmarks...\n');

  const results = await runBenchmark();

  if (updateBaseline) {
    saveBaseline(results);
    process.exit(0);
  }

  const baseline = loadBaseline();

  if (!baseline) {
    console.log('\nNo baseline found. Run with --update-baseline to create one.');
    console.log('Saving current results as baseline...');
    saveBaseline(results);
    process.exit(0);
  }

  console.log('\n--- Baseline Comparison ---');
  console.log(`Regression threshold: ${(REGRESSION_THRESHOLD * 100).toFixed(0)}%\n`);

  const { regressions, improvements } = compareResults(results, baseline);

  if (improvements.length > 0) {
    console.log(`\n${improvements.length} improvement(s) detected!`);
  }

  if (regressions.length > 0) {
    console.log(`\nFAILED: ${regressions.length} regression(s) detected!`);
    for (const reg of regressions) {
      if (reg.type === 'speedup') {
        console.log(
          `  - ${reg.label}: speedup dropped from ${(reg.baseline * 100).toFixed(1)}% to ${(reg.current * 100).toFixed(1)}%`,
        );
      } else {
        console.log(
          `  - ${reg.label}: ${reg.baseline.toFixed(2)}ms -> ${reg.current.toFixed(2)}ms (+${(reg.change * 100).toFixed(1)}%)`,
        );
      }
    }
    process.exit(1);
  }

  console.log('\nPASSED: No regressions detected.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
