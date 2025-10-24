import { Bench } from 'tinybench';

import {
  createResourceState,
  createGeneratorState,
  createUpgradeState,
  RuntimeChangeJournal,
} from '../dist/index.js';

const RESOURCE_COUNT = 4096;
const GENERATOR_COUNT = 512;
const UPGRADE_COUNT = 256;
const TOUCH_COUNT = 64;
const SAMPLE_TICKS = 8;

const benchSink = { value: 0 };

function createResourceDefinitions() {
  return Array.from({ length: RESOURCE_COUNT }, (_, index) => ({
    id: `resource:${index}`,
    startAmount: 100,
    capacity: 1_000_000,
  }));
}

function createGeneratorDefinitions() {
  return Array.from({ length: GENERATOR_COUNT }, (_, index) => ({
    id: `generator:${index}`,
    startLevel: index % 3,
    maxLevel: 32,
    unlocked: true,
    visible: true,
  }));
}

function createUpgradeDefinitions() {
  return Array.from({ length: UPGRADE_COUNT }, (_, index) => ({
    id: `upgrade:${index}`,
    maxPurchases: 5,
  }));
}

function mutateState(state, step) {
  for (let offset = 0; offset < TOUCH_COUNT; offset += 1) {
    const resourceIndex = offset % RESOURCE_COUNT;
    state.resources.addAmount(resourceIndex, 1);

    const generatorIndex = offset % GENERATOR_COUNT;
    state.generators.setLevel(generatorIndex, ((step + offset) % 16) + 1);
    state.generators.setEnabled(generatorIndex, ((step + offset) & 1) === 0);

    const upgradeIndex = offset % UPGRADE_COUNT;
    state.upgrades.setPurchaseCount(upgradeIndex, (step + offset) % 3);
  }
}

function createState() {
  return {
    resources: createResourceState(createResourceDefinitions()),
    generators: createGeneratorState(createGeneratorDefinitions()),
    upgrades: createUpgradeState(createUpgradeDefinitions()),
  };
}

function consumeDelta(delta) {
  if (!delta) {
    return;
  }
  if (delta.resources && delta.resources.count > 0) {
    benchSink.value ^= Math.trunc(delta.resources.amounts[0]);
  }
  if (delta.generators && delta.generators.dirtyCount > 0) {
    benchSink.value ^= delta.generators.levels[0] << 1;
  }
  if (delta.upgrades && delta.upgrades.dirtyCount > 0) {
    benchSink.value ^= delta.upgrades.purchaseCount[0] << 2;
  }
}

function consumeClone(clone) {
  if (!clone) {
    return;
  }
  const amounts = clone.resources.amounts;
  if (amounts.length > 0) {
    benchSink.value ^= Math.trunc(amounts[0]);
  }
  const firstGenerator = clone.generators[0];
  if (firstGenerator) {
    benchSink.value ^= firstGenerator.level << 1;
  }
  const firstUpgrade = clone.upgrades[0];
  if (firstUpgrade) {
    benchSink.value ^= firstUpgrade.purchaseCount << 2;
  }
}

function createChangeJournalScenario() {
  const state = createState();
  const journal = new RuntimeChangeJournal({ requireMonotonicTick: false });
  let tick = 0;
  return {
    step() {
      mutateState(state, tick);
      const delta = journal.capture({
        tick,
        resources: state.resources,
        generators: state.generators,
        upgrades: state.upgrades,
      });
      tick += 1;
      consumeDelta(delta);
    },
  };
}

function createNaiveCloneScenario() {
  const state = createState();
  let tick = 0;
  return {
    step() {
      mutateState(state, tick);
      const clone = captureNaive(state, tick);
      tick += 1;
      consumeClone(clone);
    },
  };
}

function captureNaive(state, tick) {
  const resources = state.resources.snapshot({ mode: 'recorder' });
  return {
    tick,
    resources: {
      ids: [...resources.ids],
      amounts: Array.from(resources.amounts),
      capacities: Array.from(resources.capacities),
      incomePerSecond: Array.from(resources.incomePerSecond),
      expensePerSecond: Array.from(resources.expensePerSecond),
      netPerSecond: Array.from(resources.netPerSecond),
      tickDelta: Array.from(resources.tickDelta),
      flags: Array.from(resources.flags),
      dirtyTolerance: Array.from(resources.dirtyTolerance),
    },
    generators: state.generators.collectRecords().map((record) => ({ ...record })),
    upgrades: state.upgrades.collectRecords().map((record) => ({ ...record })),
  };
}

const bench = new Bench({ iterations: 30 });

let changeJournalScenario;
bench.add(
  'runtime-change-journal',
  () => {
    for (let sample = 0; sample < SAMPLE_TICKS; sample += 1) {
      changeJournalScenario.step();
    }
  },
  {
    beforeEach() {
      changeJournalScenario = createChangeJournalScenario();
    },
  },
);

let naiveScenario;
bench.add(
  'naive-struct-clones',
  () => {
    for (let sample = 0; sample < SAMPLE_TICKS; sample += 1) {
      naiveScenario.step();
    }
  },
  {
    beforeEach() {
      naiveScenario = createNaiveCloneScenario();
    },
  },
);

await bench.warmup();
await bench.run();

for (const task of bench.tasks) {
  const result = task.result;
  if (!result) {
    continue;
  }
  const hz = result.hz.toFixed(2).padStart(12);
  const rme = `${result.rme.toFixed(2)}%`.padStart(8);
  console.log(`${task.name.padEnd(26)} ${hz} ops/sec ±${rme}`);
}

console.log(`sink=${benchSink.value}`);
