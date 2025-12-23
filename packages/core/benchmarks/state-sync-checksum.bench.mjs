import { performance } from 'node:perf_hooks';

import { CommandPriority, computeStateChecksum } from '../dist/index.js';
import {
  assertBenchmarkPayload,
  computeStats,
  getEnvMetadata,
  roundNumber,
} from './benchmark-json-helpers.mjs';

const WARMUP_ITERATIONS = 2_000;
const MEASURE_ITERATIONS = 20_000;
const RUNS = 5;
const TARGET_US = 100;
const ENFORCE_TARGET = process.env.CHECKSUM_BENCH_ENFORCE === '1';

const COMMAND_PRIORITIES = [
  CommandPriority.PLAYER,
  CommandPriority.AUTOMATION,
  CommandPriority.SYSTEM,
];

function createResources(count) {
  const ids = new Array(count);
  const amounts = new Array(count);
  const capacities = new Array(count);
  const flags = new Array(count);
  const unlocked = new Array(count);
  const visible = new Array(count);

  for (let index = 0; index < count; index += 1) {
    ids[index] = `resource.${index}`;
    amounts[index] = index * 1.25;
    capacities[index] = index % 7 === 0 ? null : 100 + index;
    flags[index] = index % 2 === 0 ? 1 : 0;
    unlocked[index] = index % 3 !== 0;
    visible[index] = index % 4 !== 0;
  }

  const digestHash = ((count * 2_654_435_761) >>> 0)
    .toString(16)
    .padStart(8, '0');

  return {
    ids,
    amounts,
    capacities,
    unlocked,
    visible,
    flags,
    definitionDigest: {
      ids,
      version: 1,
      hash: `fnv1a-${digestHash}`,
    },
  };
}

function createGenerators(count) {
  const generators = new Array(count);

  for (let index = 0; index < count; index += 1) {
    const generator = {
      id: `generator.${index}`,
      owned: index % 8,
      enabled: index % 2 === 0,
      isUnlocked: index % 3 !== 0,
    };
    if (index % 5 === 0) {
      generator.nextPurchaseReadyAtStep = 100 + index;
    }
    generators[index] = generator;
  }

  return generators;
}

function createUpgrades(count) {
  const upgrades = new Array(count);
  for (let index = 0; index < count; index += 1) {
    upgrades[index] = {
      id: `upgrade.${index}`,
      purchases: index % 4,
    };
  }
  return upgrades;
}

function createAchievements(count) {
  const achievements = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const achievement = {
      id: `achievement.${index}`,
      completions: index % 3,
      progress: (index % 10) / 10,
    };
    if (index % 4 === 0) {
      achievement.nextRepeatableAtStep = 200 + index;
      achievement.lastCompletedStep = 180 + index;
    }
    achievements[index] = achievement;
  }
  return achievements;
}

function createAutomations(count) {
  const automations = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const automation = {
      id: `automation.${index}`,
      enabled: index % 2 === 0,
      lastFiredStep: index % 3 === 0 ? null : 50 + index,
      cooldownExpiresStep: 75 + index,
      unlocked: index % 5 !== 0,
    };
    if (index % 4 === 0) {
      automation.lastThresholdSatisfied = index % 8 === 0;
    }
    automations[index] = automation;
  }
  return automations;
}

function createTransforms(count) {
  const transforms = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const transform = {
      id: `transform.${index}`,
      unlocked: index % 3 !== 0,
      cooldownExpiresStep: 90 + index,
    };
    if (index % 2 === 0) {
      transform.batches = [
        {
          completeAtStep: 120 + index,
          outputs: [
            {
              resourceId: `resource.${index % 10}`,
              amount: 1 + index / 10,
            },
          ],
        },
      ];
    }
    transforms[index] = transform;
  }
  return transforms;
}

function createCommandQueue(count) {
  const entries = new Array(count);
  for (let index = 0; index < count; index += 1) {
    entries[index] = {
      type: 'bench:command',
      priority: COMMAND_PRIORITIES[index % COMMAND_PRIORITIES.length],
      timestamp: 1_700_000_000 + index * 17,
      step: 42 + (index % 5),
      payload: {
        resourceId: `resource.${index % 10}`,
        amount: index * 0.5,
        meta: {
          source: 'benchmark',
          index,
        },
      },
    };
  }
  return {
    schemaVersion: 1,
    entries,
  };
}

function createSnapshot(scenario) {
  const resources = createResources(scenario.resources);
  return {
    version: 1,
    capturedAt: 1_700_000_000,
    runtime: {
      step: 42,
      stepSizeMs: 100,
      rngSeed: 4242,
    },
    resources,
    progression: {
      schemaVersion: 2,
      step: 42,
      resources,
      generators: createGenerators(scenario.generators),
      upgrades: createUpgrades(scenario.upgrades),
      achievements: createAchievements(scenario.achievements),
    },
    automation: createAutomations(scenario.automations),
    transforms: createTransforms(scenario.transforms),
    commandQueue: createCommandQueue(scenario.commands),
  };
}

function runMeasurement(snapshot) {
  let checksum = '';
  for (let index = 0; index < WARMUP_ITERATIONS; index += 1) {
    checksum = computeStateChecksum(snapshot);
  }

  const samplesUs = [];
  for (let run = 0; run < RUNS; run += 1) {
    const start = performance.now();
    for (let index = 0; index < MEASURE_ITERATIONS; index += 1) {
      checksum = computeStateChecksum(snapshot);
    }
    const durationMs = performance.now() - start;
    samplesUs.push((durationMs * 1000) / MEASURE_ITERATIONS);
  }

  if (checksum.length === 0) {
    throw new Error('Checksum computation did not produce output.');
  }

  return { samplesUs };
}

function formatScenarioLabel(scenario) {
  return [
    `resources=${scenario.resources}`,
    `generators=${scenario.generators}`,
    `upgrades=${scenario.upgrades}`,
    `achievements=${scenario.achievements}`,
    `automations=${scenario.automations}`,
    `transforms=${scenario.transforms}`,
    `commands=${scenario.commands}`,
  ].join(' ');
}

function runScenario(scenario) {
  const snapshot = createSnapshot(scenario);
  const { samplesUs } = runMeasurement(snapshot);
  const total = samplesUs.reduce((sum, value) => sum + value, 0);
  const averageUs = total / samplesUs.length;
  const minUs = Math.min(...samplesUs);
  const maxUs = Math.max(...samplesUs);
  const statsMs = computeStats(
    samplesUs.map((value) => value / 1000),
  );
  const shouldCheckTarget = scenario.enforceTarget === true;
  const passesTarget = averageUs <= TARGET_US;
  const status = shouldCheckTarget
    ? passesTarget
      ? 'OK'
      : 'ABOVE_TARGET'
    : 'INFO';
  const meanOverTarget =
    TARGET_US === 0 ? null : roundNumber(averageUs / TARGET_US, 4);

  console.log(`scenario=${scenario.label}`);
  console.log(`  shape=${formatScenarioLabel(scenario)}`);
  console.log(
    `  checksum_avg=${averageUs.toFixed(2)}us min=${minUs.toFixed(2)}us max=${maxUs.toFixed(2)}us`,
  );
  console.log(
    `  target=${TARGET_US}us status=${status}${shouldCheckTarget ? '' : ' (not enforced)'}`,
  );

  if (ENFORCE_TARGET && shouldCheckTarget && !passesTarget) {
    process.exitCode = 1;
  }

  return {
    label: scenario.label,
    shape: {
      resources: scenario.resources,
      generators: scenario.generators,
      upgrades: scenario.upgrades,
      achievements: scenario.achievements,
      automations: scenario.automations,
      transforms: scenario.transforms,
      commands: scenario.commands,
    },
    stats: statsMs,
    meanOverTarget,
    status,
    targetUs: TARGET_US,
    enforceTarget: shouldCheckTarget,
  };
}

const SCENARIOS = [
  {
    label: 'doc-typical',
    resources: 100,
    generators: 50,
    upgrades: 0,
    achievements: 0,
    automations: 0,
    transforms: 0,
    commands: 0,
    enforceTarget: true,
  },
  {
    label: 'typical-expanded',
    resources: 100,
    generators: 50,
    upgrades: 40,
    achievements: 20,
    automations: 15,
    transforms: 10,
    commands: 8,
  },
  {
    label: 'small',
    resources: 20,
    generators: 10,
    upgrades: 8,
    achievements: 6,
    automations: 5,
    transforms: 3,
    commands: 2,
  },
  {
    label: 'large',
    resources: 500,
    generators: 250,
    upgrades: 200,
    achievements: 100,
    automations: 80,
    transforms: 60,
    commands: 40,
  },
];

const scenarioResults = [];
for (const scenario of SCENARIOS) {
  scenarioResults.push(runScenario(scenario));
}

const payload = {
  event: 'benchmark_run_end',
  schemaVersion: 1,
  benchmark: {
    name: 'state-sync-checksum',
  },
  config: {
    warmupIterations: WARMUP_ITERATIONS,
    measureIterations: MEASURE_ITERATIONS,
    runs: RUNS,
    targetUs: TARGET_US,
    enforceTarget: ENFORCE_TARGET,
  },
  results: {
    scenarios: scenarioResults,
  },
  env: getEnvMetadata(),
};

assertBenchmarkPayload(payload);
console.log(JSON.stringify(payload));
