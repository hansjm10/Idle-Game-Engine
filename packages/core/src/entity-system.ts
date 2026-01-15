import type {
  EntityDefinition,
  FormulaEvaluationContext,
  NumericFormula,
} from '@idle-engine/content-schema';
import { evaluateNumericFormula } from '@idle-engine/content-schema';
import { evaluateCondition } from './condition-evaluator.js';
import type { ConditionContext } from './condition-evaluator.js';
import type { System, TickContext } from './index.js';
import { seededRandom } from './rng.js';
import { isFiniteNumber } from './validation/primitives.js';

export interface EntityState {
  readonly id: string;
  readonly count: number;
  readonly availableCount: number;
  readonly unlocked: boolean;
  readonly visible: boolean;
}

export interface EntityAssignment {
  readonly missionId: string;
  readonly batchId: string;
  readonly deployedAtStep: number;
  readonly returnStep: number;
}

export interface EntityInstanceState {
  readonly instanceId: string;
  readonly entityId: string;
  readonly level: number;
  readonly experience: number;
  readonly stats: Readonly<Record<string, number>>;
  readonly assignment: EntityAssignment | null;
}

export interface EntitySystemState {
  readonly entities: ReadonlyMap<string, EntityState>;
  readonly instances: ReadonlyMap<string, EntityInstanceState>;
  readonly entityInstances: ReadonlyMap<string, readonly string[]>;
}

export interface SerializedEntityState {
  readonly id: string;
  readonly count: number;
  readonly availableCount: number;
  readonly unlocked: boolean;
  readonly visible: boolean;
}

export interface SerializedEntityInstanceState {
  readonly instanceId: string;
  readonly entityId: string;
  readonly level: number;
  readonly experience: number;
  readonly stats: Readonly<Record<string, number>>;
  readonly assignment: EntityAssignment | null;
}

export interface SerializedEntityInstancesByEntity {
  readonly entityId: string;
  readonly instanceIds: readonly string[];
}

export interface SerializedEntitySystemState {
  readonly entities: readonly SerializedEntityState[];
  readonly instances: readonly SerializedEntityInstanceState[];
  readonly entityInstances: readonly SerializedEntityInstancesByEntity[];
}

export interface SeededRNG {
  nextInt(min: number, max: number): number;
}

export interface EntitySystemOptions {
  readonly stepDurationMs?: number;
  readonly conditionContext?: ConditionContext;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

const DEFAULT_STEP_DURATION_MS = 0;
const INSTANCE_SUFFIX_MAX = 0xffffff;
const INSTANCE_SUFFIX_LENGTH = 6;
const MAX_INSTANCE_ID_ATTEMPTS = 5;
const MIN_LEVEL = 1;

const compareStableStrings = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const normalizeNonNegativeInt = (value: unknown): number => {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  return Math.floor(value);
};

const normalizeFiniteNumber = (value: unknown): number =>
  isFiniteNumber(value) ? value : 0;

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const createEntityFormulaEvaluationContext = (options: {
  readonly level: number;
  readonly step: number;
  readonly stepDurationMs: number;
  readonly conditionContext?: ConditionContext;
}): FormulaEvaluationContext => {
  const level =
    isFiniteNumber(options.level) && options.level >= 0 ? options.level : 0;
  const step = isFiniteNumber(options.step) && options.step >= 0
    ? options.step
    : 0;
  const stepDurationMs =
    isFiniteNumber(options.stepDurationMs) && options.stepDurationMs >= 0
      ? options.stepDurationMs
      : 0;
  const deltaTime = stepDurationMs / 1000;
  const time = step * deltaTime;
  const conditionContext = options.conditionContext;

  return {
    variables: {
      level,
      time,
      deltaTime,
    },
    entities: {
      resource: (resourceId) =>
        conditionContext?.getResourceAmount(resourceId) ?? 0,
      generator: (generatorId) =>
        conditionContext?.getGeneratorLevel(generatorId) ?? 0,
      upgrade: (upgradeId) =>
        conditionContext?.getUpgradePurchases(upgradeId) ?? 0,
      automation: () => 0,
      prestigeLayer: () => 0,
    },
  };
};

const evaluateFormula = (
  formula: NumericFormula,
  context: FormulaEvaluationContext,
): number => {
  const value = evaluateNumericFormula(formula, context);
  return normalizeFiniteNumber(value);
};

const computeStats = (
  definition: EntityDefinition,
  level: number,
  context: FormulaEvaluationContext,
): Readonly<Record<string, number>> => {
  const stats: Record<string, number> = {};
  const normalizedLevel = Math.max(MIN_LEVEL, Math.floor(level));

  for (const statDef of definition.stats) {
    const base = evaluateFormula(statDef.baseValue, context);
    const growthFormula = definition.progression?.statGrowth[statDef.id];
    const growthValue = growthFormula
      ? evaluateFormula(growthFormula, context)
      : 0;
    const levelBonus = growthFormula
      ? growthValue * Math.max(0, normalizedLevel - 1)
      : 0;
    const minValue = statDef.minValue
      ? evaluateFormula(statDef.minValue, context)
      : Number.NEGATIVE_INFINITY;
    const maxValue = statDef.maxValue
      ? evaluateFormula(statDef.maxValue, context)
      : Number.POSITIVE_INFINITY;

    stats[statDef.id] = clampNumber(
      base + levelBonus,
      minValue,
      maxValue,
    );
  }

  return Object.freeze(stats);
};

export const createSeededRng = (
  randomFn: () => number = seededRandom,
): SeededRNG => ({
  nextInt(min: number, max: number): number {
    const minInt = Math.ceil(min);
    const maxInt = Math.floor(max);
    if (!Number.isFinite(minInt) || !Number.isFinite(maxInt)) {
      return 0;
    }
    if (maxInt <= minInt) {
      return minInt;
    }
    const span = maxInt - minInt + 1;
    return Math.floor(randomFn() * span) + minInt;
  },
});

export const serializeEntitySystemState = (
  state: EntitySystemState,
): SerializedEntitySystemState => {
  const entities = Array.from(state.entities.values());
  entities.sort((left, right) => compareStableStrings(left.id, right.id));

  const instances = Array.from(state.instances.values());
  instances.sort((left, right) =>
    compareStableStrings(left.instanceId, right.instanceId),
  );

  const entityInstances = Array.from(state.entityInstances.entries())
    .sort(([left], [right]) => compareStableStrings(left, right))
    .map(([entityId, instanceIds]) => ({
      entityId,
      instanceIds: [...instanceIds],
    }));

  return {
    entities: entities.map((entry) => ({
      id: entry.id,
      count: normalizeNonNegativeInt(entry.count),
      availableCount: normalizeNonNegativeInt(entry.availableCount),
      unlocked: Boolean(entry.unlocked),
      visible: Boolean(entry.visible),
    })),
    instances: instances.map((entry) => ({
      instanceId: entry.instanceId,
      entityId: entry.entityId,
      level: normalizeNonNegativeInt(entry.level) || MIN_LEVEL,
      experience: normalizeFiniteNumber(entry.experience),
      stats: { ...entry.stats },
      assignment: entry.assignment
        ? {
            missionId: entry.assignment.missionId,
            batchId: entry.assignment.batchId,
            deployedAtStep: normalizeNonNegativeInt(
              entry.assignment.deployedAtStep,
            ),
            returnStep: normalizeNonNegativeInt(entry.assignment.returnStep),
          }
        : null,
    })),
    entityInstances: entityInstances.map((entry) => ({
      entityId: entry.entityId,
      instanceIds: Object.freeze([...entry.instanceIds]),
    })),
  };
};

const isSerializedEntitySystemState = (
  value: EntitySystemState | SerializedEntitySystemState,
): value is SerializedEntitySystemState =>
  Array.isArray((value as SerializedEntitySystemState).entities);

export class EntitySystem implements System {
  readonly id = 'entity-system';

  private readonly definitions: readonly EntityDefinition[];
  private readonly definitionById: Map<string, EntityDefinition>;
  private readonly entityStates: Map<string, Mutable<EntityState>>;
  private readonly instanceStates: Map<string, Mutable<EntityInstanceState>>;
  private readonly entityInstances: Map<string, string[]>;
  private readonly rng: SeededRNG;
  private readonly stepDurationMs: number;
  private readonly conditionContext?: ConditionContext;
  private currentStep = 0;

  constructor(
    definitions: readonly EntityDefinition[],
    rng: SeededRNG = createSeededRng(),
    options: EntitySystemOptions = {},
  ) {
    this.definitions = Object.freeze([...definitions]);
    this.definitionById = new Map(
      this.definitions.map((definition) => [definition.id, definition]),
    );
    this.entityStates = new Map();
    this.instanceStates = new Map();
    this.entityInstances = new Map();
    this.rng = rng;
    this.stepDurationMs =
      options.stepDurationMs ?? DEFAULT_STEP_DURATION_MS;
    this.conditionContext = options.conditionContext;

    this.initializeState();
  }

  private initializeState(): void {
    this.entityStates.clear();
    this.instanceStates.clear();
    this.entityInstances.clear();

    for (const definition of this.definitions) {
      const unlocked =
        definition.unlocked || definition.unlockCondition === undefined;
      const visible = definition.visible;

      this.entityStates.set(definition.id, {
        id: definition.id,
        count: 0,
        availableCount: 0,
        unlocked,
        visible,
      });
      this.entityInstances.set(definition.id, []);

      const startCount = normalizeNonNegativeInt(definition.startCount);
      if (startCount <= 0) {
        continue;
      }

      if (definition.trackInstances) {
        const maxCount = this.getMaxCount(definition, startCount, 0);
        const targetCount =
          maxCount === undefined ? startCount : Math.min(startCount, maxCount);
        for (let i = 0; i < targetCount; i += 1) {
          this.createInstance(definition.id, 0);
        }
      } else {
        this.addEntity(definition.id, startCount);
      }
    }
  }

  tick(context: TickContext): void {
    const { step } = context;
    this.currentStep = step;

    const conditionContext = this.conditionContext;
    if (conditionContext) {
      this.refreshEntityVisibility(conditionContext);
    }

    this.processReturningMissions(step);
  }

  private refreshEntityVisibility(conditionContext: ConditionContext): void {
    for (const definition of this.definitions) {
      const state = this.entityStates.get(definition.id);
      if (!state) {
        continue;
      }

      state.visible = this.resolveVisibility(definition, conditionContext);

      if (!state.unlocked) {
        state.unlocked = this.resolveUnlocked(definition, conditionContext);
      }
    }
  }

  private resolveVisibility(
    definition: EntityDefinition,
    conditionContext: ConditionContext,
  ): boolean {
    if (definition.visibilityCondition) {
      return evaluateCondition(definition.visibilityCondition, conditionContext);
    }
    return definition.visible;
  }

  private resolveUnlocked(
    definition: EntityDefinition,
    conditionContext: ConditionContext,
  ): boolean {
    if (definition.unlocked || definition.unlockCondition === undefined) {
      return true;
    }
    return evaluateCondition(definition.unlockCondition, conditionContext);
  }

  private processReturningMissions(step: number): void {
    for (const instance of this.instanceStates.values()) {
      const assignment = instance.assignment;
      if (!assignment) {
        continue;
      }
      if (assignment.returnStep <= step) {
        this.returnFromMission(instance.instanceId);
      }
    }
  }

  getEntityState(entityId: string): EntityState | undefined {
    return this.entityStates.get(entityId);
  }

  getInstanceState(instanceId: string): EntityInstanceState | undefined {
    return this.instanceStates.get(instanceId);
  }

  getInstancesForEntity(entityId: string): readonly EntityInstanceState[] {
    const instanceIds = this.entityInstances.get(entityId);
    if (!instanceIds || instanceIds.length === 0) {
      return [];
    }

    const instances: EntityInstanceState[] = [];
    for (const instanceId of instanceIds) {
      const state = this.instanceStates.get(instanceId);
      if (state) {
        instances.push(state);
      }
    }

    return Object.freeze(instances);
  }

  getAvailableInstances(entityId: string): readonly EntityInstanceState[] {
    const instanceIds = this.entityInstances.get(entityId);
    if (!instanceIds || instanceIds.length === 0) {
      return [];
    }

    const instances: EntityInstanceState[] = [];
    for (const instanceId of instanceIds) {
      const state = this.instanceStates.get(instanceId);
      if (state && !state.assignment) {
        instances.push(state);
      }
    }

    return Object.freeze(instances);
  }

  addEntity(entityId: string, count: number, step = this.currentStep): void {
    const definition = this.definitionById.get(entityId);
    const state = this.entityStates.get(entityId);
    if (!definition || !state) {
      throw new Error(`Entity "${entityId}" not found.`);
    }

    const normalizedCount = normalizeNonNegativeInt(count);
    if (normalizedCount <= 0) {
      return;
    }

    if (definition.trackInstances) {
      for (let i = 0; i < normalizedCount; i += 1) {
        this.createInstance(entityId, step);
      }
      return;
    }

    const maxCount = this.getMaxCount(
      definition,
      state.count + normalizedCount,
      step,
    );
    const targetCount =
      maxCount === undefined
        ? state.count + normalizedCount
        : Math.min(state.count + normalizedCount, maxCount);
    if (targetCount === state.count) {
      return;
    }

    const delta = targetCount - state.count;
    state.count = targetCount;
    state.availableCount = Math.max(0, state.availableCount + delta);
  }

  removeEntity(entityId: string, count: number): void {
    const definition = this.definitionById.get(entityId);
    const state = this.entityStates.get(entityId);
    if (!definition || !state) {
      throw new Error(`Entity "${entityId}" not found.`);
    }

    const normalizedCount = normalizeNonNegativeInt(count);
    if (normalizedCount <= 0) {
      return;
    }

    if (definition.trackInstances) {
      this.removeEntityInstances(entityId, normalizedCount);
      return;
    }

    this.removeEntityCount(entityId, state, normalizedCount);
  }

  private removeEntityInstances(entityId: string, normalizedCount: number): void {
    const instanceIds = this.entityInstances.get(entityId) ?? [];
    const available = this.collectAvailableInstances(instanceIds, normalizedCount);
    if (available.length < normalizedCount) {
      throw new Error(`Entity "${entityId}" lacks ${normalizedCount} available instances.`);
    }

    for (const instanceId of available) {
      this.destroyInstance(instanceId);
    }
  }

  private collectAvailableInstances(
    instanceIds: readonly string[],
    count: number,
  ): string[] {
    const available: string[] = [];
    for (let index = instanceIds.length - 1; index >= 0; index -= 1) {
      const instanceId = instanceIds[index];
      const instance = this.instanceStates.get(instanceId);
      if (instance && !instance.assignment) {
        available.push(instanceId);
        if (available.length >= count) {
          break;
        }
      }
    }
    return available;
  }

  private removeEntityCount(
    entityId: string,
    state: Mutable<EntityState>,
    normalizedCount: number,
  ): void {
    if (state.count < normalizedCount) {
      throw new Error(`Entity "${entityId}" lacks ${normalizedCount} count.`);
    }

    state.count = state.count - normalizedCount;
    state.availableCount = Math.max(0, state.availableCount - normalizedCount);
  }

  createInstance(
    entityId: string,
    creationStep = this.currentStep,
  ): EntityInstanceState {
    const definition = this.definitionById.get(entityId);
    const state = this.entityStates.get(entityId);
    if (!definition || !state) {
      throw new Error(`Entity "${entityId}" not found.`);
    }
    if (!definition.trackInstances) {
      throw new Error(`Entity "${entityId}" does not track instances.`);
    }

    const maxCount = this.getMaxCount(definition, state.count + 1, creationStep);
    if (maxCount !== undefined && state.count >= maxCount) {
      throw new Error(`Entity "${entityId}" reached max count.`);
    }

    const instanceId = this.generateInstanceId(entityId, creationStep);
    const level = MIN_LEVEL;
    const context = this.buildFormulaContext(level, creationStep);
    const stats = computeStats(definition, level, context);

    const instance: Mutable<EntityInstanceState> = {
      instanceId,
      entityId,
      level,
      experience: 0,
      stats,
      assignment: null,
    };

    this.instanceStates.set(instanceId, instance);
    const list = this.entityInstances.get(entityId) ?? [];
    list.push(instanceId);
    this.entityInstances.set(entityId, list);
    state.count += 1;
    state.availableCount += 1;

    return instance;
  }

  destroyInstance(instanceId: string): void {
    const instance = this.instanceStates.get(instanceId);
    if (!instance) {
      throw new Error(`Entity instance "${instanceId}" not found.`);
    }

    const state = this.entityStates.get(instance.entityId);
    if (!state) {
      throw new Error(`Entity "${instance.entityId}" not found.`);
    }

    const list = this.entityInstances.get(instance.entityId) ?? [];
    const index = list.indexOf(instanceId);
    if (index >= 0) {
      list.splice(index, 1);
    }

    this.instanceStates.delete(instanceId);
    state.count = Math.max(0, state.count - 1);
    if (!instance.assignment) {
      state.availableCount = Math.max(0, state.availableCount - 1);
    }
  }

  assignToMission(instanceId: string, assignment: EntityAssignment): void {
    const instance = this.instanceStates.get(instanceId);
    if (!instance) {
      throw new Error(`Entity instance "${instanceId}" not found.`);
    }
    if (instance.assignment) {
      throw new Error(`Entity instance "${instanceId}" already assigned.`);
    }

    if (assignment.returnStep < assignment.deployedAtStep) {
      throw new Error('Assignment returnStep must be >= deployedAtStep.');
    }

    instance.assignment = {
      missionId: assignment.missionId,
      batchId: assignment.batchId,
      deployedAtStep: assignment.deployedAtStep,
      returnStep: assignment.returnStep,
    };

    const state = this.entityStates.get(instance.entityId);
    if (state) {
      state.availableCount = Math.max(0, state.availableCount - 1);
    }
  }

  returnFromMission(instanceId: string): void {
    const instance = this.instanceStates.get(instanceId);
    if (!instance) {
      throw new Error(`Entity instance "${instanceId}" not found.`);
    }

    if (!instance.assignment) {
      return;
    }

    instance.assignment = null;
    const state = this.entityStates.get(instance.entityId);
    if (state) {
      state.availableCount += 1;
    }
  }

  addExperience(
    instanceId: string,
    amount: number,
    step = this.currentStep,
  ): void {
    const instance = this.instanceStates.get(instanceId);
    if (!instance) {
      throw new Error(`Entity instance "${instanceId}" not found.`);
    }

    const definition = this.definitionById.get(instance.entityId);
    if (!definition) {
      throw new Error(`Entity "${instance.entityId}" not found.`);
    }

    const normalizedAmount = normalizeFiniteNumber(amount);
    if (normalizedAmount <= 0) {
      return;
    }

    instance.experience = normalizeFiniteNumber(
      instance.experience + normalizedAmount,
    );

    const progression = definition.progression;
    if (!progression) {
      return;
    }

    let level = Math.max(MIN_LEVEL, Math.floor(instance.level));
    const maxLevel = Math.max(
      MIN_LEVEL,
      progression.maxLevel ?? Number.POSITIVE_INFINITY,
    );
    let experience = instance.experience;

    while (level < maxLevel) {
      const context = this.buildFormulaContext(level, step);
      const required = evaluateFormula(progression.levelFormula, context);
      if (!Number.isFinite(required) || required <= 0) {
        break;
      }
      if (experience < required) {
        break;
      }

      experience -= required;
      level += 1;
    }

    instance.experience = experience;
    if (level !== instance.level) {
      instance.level = level;
      const context = this.buildFormulaContext(level, step);
      instance.stats = computeStats(definition, level, context);
    }
  }

  captureState(): EntitySystemState {
    const entities = new Map<string, EntityState>();
    const instances = new Map<string, EntityInstanceState>();
    const entityInstances = new Map<string, readonly string[]>();

    for (const [id, state] of this.entityStates.entries()) {
      entities.set(id, { ...state });
    }

    for (const [id, state] of this.instanceStates.entries()) {
      instances.set(id, {
        ...state,
        stats: { ...state.stats },
        assignment: state.assignment ? { ...state.assignment } : null,
      });
    }

    for (const [entityId, list] of this.entityInstances.entries()) {
      entityInstances.set(entityId, Object.freeze([...list]));
    }

    return {
      entities,
      instances,
      entityInstances,
    };
  }

  getState(): EntitySystemState {
    return {
      entities: this.entityStates,
      instances: this.instanceStates,
      entityInstances: this.entityInstances,
    };
  }

  exportForSave(): SerializedEntitySystemState {
    return serializeEntitySystemState(this.getState());
  }

  restoreState(
    state: EntitySystemState | SerializedEntitySystemState,
    options?: { savedWorkerStep?: number; currentStep?: number },
  ): void {
    const resolved = isSerializedEntitySystemState(state)
      ? this.deserialize(state, options)
      : state;

    this.entityStates.clear();
    this.instanceStates.clear();
    this.entityInstances.clear();

    for (const definition of this.definitions) {
      const unlocked =
        definition.unlocked || definition.unlockCondition === undefined;
      const visible = definition.visible;
      const initial: Mutable<EntityState> = {
        id: definition.id,
        count: 0,
        availableCount: 0,
        unlocked,
        visible,
      };

      this.entityStates.set(definition.id, initial);
      this.entityInstances.set(definition.id, []);
    }

    for (const [id, entry] of resolved.entities.entries()) {
      const stateEntry = this.entityStates.get(id);
      if (stateEntry) {
        stateEntry.count = normalizeNonNegativeInt(entry.count);
        stateEntry.availableCount = normalizeNonNegativeInt(entry.availableCount);
        stateEntry.unlocked = Boolean(entry.unlocked);
        stateEntry.visible = Boolean(entry.visible);
      } else {
        this.entityStates.set(id, { ...entry });
      }
    }

    for (const [id, entry] of resolved.instances.entries()) {
      this.instanceStates.set(id, {
        ...entry,
        stats: { ...entry.stats },
        assignment: entry.assignment ? { ...entry.assignment } : null,
      });
    }

    for (const [entityId, list] of resolved.entityInstances.entries()) {
      this.entityInstances.set(entityId, [...list]);
    }

    for (const definition of this.definitions) {
      if (!definition.trackInstances) {
        continue;
      }

      const list = this.entityInstances.get(definition.id) ?? [];
      const assignedCount = list.reduce((count, instanceId) => {
        const instance = this.instanceStates.get(instanceId);
        return instance?.assignment ? count + 1 : count;
      }, 0);
      const stateEntry = this.entityStates.get(definition.id);
      if (!stateEntry) {
        continue;
      }
      stateEntry.count = list.length;
      stateEntry.availableCount = Math.max(0, list.length - assignedCount);
    }
  }

  private deserialize(
    serialized: SerializedEntitySystemState,
    options?: { savedWorkerStep?: number; currentStep?: number },
  ): EntitySystemState {
    const entities = new Map<string, EntityState>();
    const instances = new Map<string, EntityInstanceState>();
    const entityInstances = new Map<string, readonly string[]>();

    for (const entry of serialized.entities ?? []) {
      entities.set(entry.id, {
        id: entry.id,
        count: normalizeNonNegativeInt(entry.count),
        availableCount: normalizeNonNegativeInt(entry.availableCount),
        unlocked: Boolean(entry.unlocked),
        visible: Boolean(entry.visible),
      });
    }

    const stepOffset =
      options?.savedWorkerStep !== undefined &&
      options?.currentStep !== undefined
        ? options.currentStep - options.savedWorkerStep
        : 0;

    for (const entry of serialized.instances ?? []) {
      const assignment = entry.assignment
        ? {
            missionId: entry.assignment.missionId,
            batchId: entry.assignment.batchId,
            deployedAtStep: normalizeNonNegativeInt(
              entry.assignment.deployedAtStep + stepOffset,
            ),
            returnStep: normalizeNonNegativeInt(
              entry.assignment.returnStep + stepOffset,
            ),
          }
        : null;

      instances.set(entry.instanceId, {
        instanceId: entry.instanceId,
        entityId: entry.entityId,
        level: Math.max(MIN_LEVEL, normalizeNonNegativeInt(entry.level)),
        experience: normalizeFiniteNumber(entry.experience),
        stats: { ...entry.stats },
        assignment,
      });
    }

    const serializedEntityInstances = serialized.entityInstances ?? [];
    if (serializedEntityInstances.length > 0) {
      for (const entry of serializedEntityInstances) {
        entityInstances.set(entry.entityId, Object.freeze([...entry.instanceIds]));
      }
    } else {
      const byEntity = new Map<string, string[]>();
      for (const instance of instances.values()) {
        const list = byEntity.get(instance.entityId) ?? [];
        list.push(instance.instanceId);
        byEntity.set(instance.entityId, list);
      }
      for (const [entityId, list] of byEntity.entries()) {
        entityInstances.set(entityId, Object.freeze([...list]));
      }
    }

    return {
      entities,
      instances,
      entityInstances,
    };
  }

  private buildFormulaContext(level: number, step: number): FormulaEvaluationContext {
    return createEntityFormulaEvaluationContext({
      level,
      step,
      stepDurationMs: this.stepDurationMs,
      conditionContext: this.conditionContext,
    });
  }

  private getMaxCount(
    definition: EntityDefinition,
    targetCount: number,
    step: number,
  ): number | undefined {
    if (!definition.maxCount) {
      return undefined;
    }
    const context = this.buildFormulaContext(targetCount, step);
    const maxCount = evaluateFormula(definition.maxCount, context);
    return Math.max(0, Math.floor(maxCount));
  }

  private generateInstanceId(entityId: string, creationStep: number): string {
    let attempt = 0;
    while (attempt < MAX_INSTANCE_ID_ATTEMPTS) {
      const suffix = this.rng
        .nextInt(0, INSTANCE_SUFFIX_MAX)
        .toString(16)
        .padStart(INSTANCE_SUFFIX_LENGTH, '0');
      const id = `${entityId}_${creationStep}_${suffix}`;
      if (!this.instanceStates.has(id)) {
        return id;
      }
      attempt += 1;
    }

    let fallback = this.instanceStates.size;
    while (true) {
      const suffix = fallback.toString(16).padStart(INSTANCE_SUFFIX_LENGTH, '0');
      const id = `${entityId}_${creationStep}_${suffix}`;
      if (!this.instanceStates.has(id)) {
        return id;
      }
      fallback += 1;
    }
  }
}
